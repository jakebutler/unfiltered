import { ClinicalError, canonicalJson, digest, validateSubmissionIntegrity, type ConfirmedSubmission, type Submission } from './domain.js';

export const IDENTIFIER_SYSTEM = 'urn:corvo:clinical:handoff-component';
export const DIGEST_SYSTEM = 'urn:corvo:clinical:confirmed-digest';
const EXTENSION = 'https://corvo.example/fhir/StructureDefinition/';
export type FhirResource = { resourceType: string; id?: string; [key: string]: unknown };
export interface Component { key: string; fullUrl: string; resource: FhirResource; }
export interface HandoffPlan { confirmation: ConfirmedSubmission; components: Component[]; }
export interface TransactionBundle { resourceType: 'Bundle'; type: 'transaction'; entry: Array<{ fullUrl: string; resource: FhirResource; request: { method: 'POST'; url: string; ifNoneExist: string } }> }
export function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
async function urn(key: string): Promise<string> {
  const hash = await digest(key);
  return `urn:uuid:${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export function componentKey(s: Submission, part: string) { return `${s.submissionId}.v${s.version}.${part}`; }
export function identifierQuery(key: string): string { return new URLSearchParams({ identifier: `${IDENTIFIER_SYSTEM}|${key}` }).toString(); }
const reference = (value: string) => ({ reference: value });

export async function planHandoff(input: ConfirmedSubmission): Promise<HandoffPlan> {
  // Copy before asynchronous work, so a caller cannot mutate a confirmed payload during planning.
  const confirmation = structuredClone(input);
  const s = validateSubmissionIntegrity(confirmation.submission);
  if (s.sources.some(source => source.recording)) throw new ClinicalError('recording-evidence-not-qualified');
  if (await digest(s) !== confirmation.digest) throw new ClinicalError('confirmation-digest-mismatch');
  if (s.completeness === 'complete' && confirmation.sufficiency?.submissionDigest !== confirmation.digest) throw new ClinicalError('sufficiency-digest-mismatch');
  const parts = ['sources', 'response', ...s.work.map(w => `work.${w.id}`), 'manifest'];
  const urls = new Map(await Promise.all(parts.map(async p => [p, await urn(componentKey(s, p))] as const)));
  const components: Component[] = [];
  const add = (part: string, resource: FhirResource) => {
    const identifier = { system: IDENTIFIER_SYSTEM, value: componentKey(s, part) };
    resource.identifier = resource.resourceType === 'QuestionnaireResponse' ? identifier : [identifier];
    resource.meta = { tag: [{ system: DIGEST_SYSTEM, code: confirmation.digest }] };
    components.push({ key: componentKey(s, part), fullUrl: urls.get(part)!, resource });
  };
  const document = (kind: string, value: unknown): FhirResource => ({
    resourceType: 'DocumentReference', status: 'current', docStatus: 'final', subject: reference(s.patient), date: s.confirmedAt,
    type: { coding: [{ system: 'urn:corvo:clinical:document-kind', code: kind }] },
    content: [{ attachment: { contentType: 'application/json', data: base64Json(value) } }],
  });
  add('sources', document('patient-conversation-sources', { schemaVersion: 1, patient: s.patient, submissionId: s.submissionId, version: s.version, sources: s.sources }));
  add('response', {
    resourceType: 'QuestionnaireResponse', status: 'completed', questionnaire: s.questionnaire, subject: reference(s.patient), source: reference(s.patient), authored: s.confirmedAt,
    extension: [
      { url: `${EXTENSION}content-version`, valueString: s.contentVersion },
      { url: `${EXTENSION}intake-completeness`, valueCode: s.completeness },
      { url: `${EXTENSION}source-document`, valueReference: reference(urls.get('sources')!) },
      ...(s.previous ? [{ url: `${EXTENSION}previous-submission`, valueString: canonicalJson(s.previous) }] : []),
    ],
    item: s.answers.map(answer => ({
      linkId: answer.questionId,
      extension: [
        { url: `${EXTENSION}answer-state`, valueCode: answer.state },
        ...answer.sourceIds.map(sourceId => ({ url: `${EXTENSION}source-turn`, valueString: sourceId })),
      ],
      ...(answer.text ? { answer: [{ valueString: answer.text }] } : {}),
    })),
  });
  for (const work of s.work) add(`work.${work.id}`, {
    resourceType: 'Task', status: 'requested', intent: 'order', for: reference(s.patient), owner: reference(work.owner), focus: reference(urls.get('response')!), authoredOn: s.confirmedAt,
    code: { coding: [{ system: 'urn:corvo:clinical:work-kind', code: work.responsibility }] },
    // Administrative tasks deliberately contain no clinical source/response input.
    // The focus is an association, not an access grant; direct FHIR policies must separately qualify denial.
    ...(work.kind === 'clinical' ? { input: [{ type: { text: 'Patient conversation sources' }, valueReference: reference(urls.get('sources')!) }] } : {}),
  });
  add('manifest', document('submission-manifest', {
    schemaVersion: 1, submissionId: s.submissionId, version: s.version, patient: s.patient, confirmedDigest: confirmation.digest, sufficiency: confirmation.sufficiency,
    required: components.map(c => ({ identifier: c.key, resourceType: c.resource.resourceType })),
  }));
  if (components.some(c => new TextEncoder().encode(canonicalJson(c.resource)).byteLength > 1_000_000)) throw new ClinicalError('fhir-component-too-large');
  return { confirmation, components };
}
export function transactionBundle(plan: HandoffPlan): TransactionBundle {
  return { resourceType: 'Bundle', type: 'transaction', entry: plan.components.map(c => ({ fullUrl: c.fullUrl, resource: structuredClone(c.resource), request: { method: 'POST', url: c.resource.resourceType, ifNoneExist: identifierQuery(c.key) } })) };
}
/** Compare submitted content, allowing only server-managed root id/meta and mutable Task workflow fields. */
export function verifyComponent(expected: FhirResource, actual: FhirResource, references: Map<string, string>): boolean {
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') return references.get(value) ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    return value;
  };
  const normalized = replace(expected) as FhirResource;
  const subset = (wanted: unknown, found: unknown): boolean => {
    if (Array.isArray(wanted)) return Array.isArray(found) && wanted.length === found.length && wanted.every((v, i) => subset(v, found[i]));
    if (wanted && typeof wanted === 'object') return !!found && typeof found === 'object' && Object.entries(wanted).every(([k, v]) => subset(v, (found as Record<string, unknown>)[k]));
    return wanted === found;
  };
  if (expected.resourceType === 'Task') {
    delete normalized.status;
    if (!['requested', 'received', 'accepted', 'rejected', 'ready', 'cancelled', 'in-progress', 'on-hold', 'failed', 'completed', 'entered-in-error'].includes(String(actual.status))) return false;
  }
  return subset(normalized, actual);
}
