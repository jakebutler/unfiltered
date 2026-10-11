import { validateRepresentationBinding, validateRepresentationDigests } from './representation-review.js';
import { toNativeQuestionnaireResponse } from './questionnaire-response.js';
import { ClinicalError, canonicalJson, digest, validateSubmissionIntegrity, administrativeLogisticsSchema, type ConfirmedSubmission, type Submission } from './domain.js';

export const IDENTIFIER_SYSTEM = 'urn:corvo:clinical:handoff-component';
export const DIGEST_SYSTEM = 'urn:corvo:clinical:confirmed-digest';
export const DELIVERY_CONTRACT = 'conditional-resumable-v1' as const;
export const ACTION_HISTORY_EXTENSION = 'https://corvo.example/fhir/StructureDefinition/clinic-action-history';
const EXTENSION = 'https://corvo.example/fhir/StructureDefinition/';
export type FhirResource = { resourceType: string; id?: string; [key: string]: unknown };
export interface Component { key: string; fullUrl: string; resource: FhirResource; }
export interface AnchorDescriptor { reference: string; version: string; hash: string; }
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

export async function planHandoff(input: ConfirmedSubmission, questionnaireReference?: string): Promise<HandoffPlan> {
  // Copy before asynchronous work, so a caller cannot mutate a confirmed payload during planning.
  const confirmation = structuredClone(input);
  const s = validateSubmissionIntegrity(confirmation.submission, confirmation.representationAuthority);
  await validateRepresentationDigests(s, confirmation.representationAuthority);
  if (s.representationReview && confirmation.representationConfirmed !== true) throw new ClinicalError('representation-final-act-required');
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
  add('sources', document('patient-conversation-sources', { schemaVersion: 1, patient: s.patient, submissionId: s.submissionId, version: s.version, sources: s.sources, ...(s.representationReview ? { representationReview: s.representationReview } : {}) }));
  const legacyResponse: FhirResource = {
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
  };
  const response: FhirResource = s.questionnaireCapture ? { ...await toNativeQuestionnaireResponse({ capture: s.questionnaireCapture, representationAuthority: validateRepresentationBinding(s, confirmation.representationAuthority), validSourceIds: new Set(s.sources.filter(source => source.kind !== 'assistant-statement').map(source => source.id)), patient: s.patient, authored: s.confirmedAt, confirmed: true, sourceDocumentReference: urls.get('sources')!, ...(questionnaireReference ? { questionnaireReference } : {}) }) } : legacyResponse;
  if (s.questionnaireCapture) {
    response.extension = [...response.extension as unknown[], { url: `${EXTENSION}content-version`, valueString: s.contentVersion }, { url: `${EXTENSION}intake-completeness`, valueCode: s.completeness }, ...(s.previous ? [{ url: `${EXTENSION}previous-submission`, valueString: canonicalJson(s.previous) }] : [])];
    if (s.completeness === 'complete' && response.status !== 'completed') throw new ClinicalError('questionnaire-completeness-mismatch');
  }
  add('response', response);
  for (const work of s.work) add(`work.${work.id}`, {
    resourceType: 'Task', status: 'requested', intent: 'order', for: reference(s.patient), owner: reference(work.owner), ...(work.kind === 'clinical' ? { focus: reference(urls.get('response')!) } : {}), authoredOn: s.confirmedAt,
    code: { coding: [{ system: 'urn:corvo:clinical:work-kind', code: work.responsibility }] },
    description: 'This Task requests work from its owner. Routing to other owners may still be pending.',
    ...(work.kind === 'administrative' ? { extension: [{ url: `${EXTENSION}administrative-logistics`, valueString: canonicalJson(administrativeLogisticsSchema.parse(s.administrativeLogistics)) }] } : {}),
    ...(work.kind === 'clinical' ? { input: [{ type: { text: 'Patient conversation sources' }, valueReference: reference(urls.get('sources')!) }] } : {}),
  });
  add('manifest', document('submission-manifest', {
    schemaVersion: 2, deliveryContract: DELIVERY_CONTRACT, submissionId: s.submissionId, version: s.version, patient: s.patient, confirmedDigest: confirmation.digest, sufficiency: confirmation.sufficiency,
    required: components.map(c => ({ identifier: c.key, resourceType: c.resource.resourceType })),
  }));
  if (components.some(c => new TextEncoder().encode(canonicalJson(c.resource)).byteLength > 1_000_000)) throw new ClinicalError('fhir-component-too-large');
  return { confirmation, components };
}
export function transactionBundle(plan: HandoffPlan): TransactionBundle {
  return { resourceType: 'Bundle', type: 'transaction', entry: plan.components.map(c => ({ fullUrl: c.fullUrl, resource: structuredClone(c.resource), request: { method: 'POST', url: c.resource.resourceType, ifNoneExist: identifierQuery(c.key) } })) };
}
/** Resolve FHIR Reference.reference only. Patient words and other string values remain exact. */
export function resolveReferences(resource: FhirResource, references: Map<string, string>): FhirResource {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'reference' && typeof item === 'string' ? references.get(item) ?? item : walk(item)]));
    return value;
  };
  return walk(resource) as FhirResource;
}
export function hasUnresolvedReferences(resource: FhirResource): boolean {
  const walk = (value: unknown): boolean => Array.isArray(value) ? value.some(walk) : !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => key === 'reference' && typeof item === 'string' && (item.startsWith('urn:') || item.includes('?')) || walk(item));
  return walk(resource);
}
/** The sealed manifest binds resolved work identities and immutable clinical anchor versions. */
export function resolvedComponent(plan: HandoffPlan, component: Component, references: Map<string, string>, anchors: Record<string, AnchorDescriptor>): FhirResource {
  const resource = resolveReferences(component.resource, references);
  if (component.key.endsWith('.manifest')) {
    const payload = {
      schemaVersion: 2, deliveryContract: DELIVERY_CONTRACT, submissionId: plan.confirmation.submission.submissionId,
      version: plan.confirmation.submission.version, patient: plan.confirmation.submission.patient,
      confirmedDigest: plan.confirmation.digest, sufficiency: plan.confirmation.sufficiency,
      anchors,
      required: plan.components.filter(item => item !== component).map(item => ({ identifier: item.key, resourceType: item.resource.resourceType, reference: references.get(item.fullUrl) })),
    };
    resource.content = [{ attachment: { contentType: 'application/json', data: base64Json(payload) } }];
  }
  return resource;
}
export function resourceVersion(resource: FhirResource): string | undefined {
  const version = (resource.meta as Record<string, unknown> | undefined)?.versionId;
  return typeof version === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(version) ? version : undefined;
}
/** Compare the entire immutable resource; tolerate only an explicit server/workflow allowlist. */
export function verifyComponent(expected: FhirResource, actual: FhirResource, references = new Map<string, string>()): boolean {
  const wanted = resolveReferences(expected, references), found = structuredClone(actual);
  delete wanted.id; delete found.id;
  const normalizeMeta = (resource: FhirResource) => {
    const meta = { ...((resource.meta as Record<string, unknown> | undefined) ?? {}) };
    for (const field of ['versionId', 'lastUpdated', 'author', 'project', 'compartment', 'account']) delete meta[field];
    resource.meta = meta;
  };
  normalizeMeta(wanted); normalizeMeta(found);
  if (wanted.resourceType === 'Task') {
    if (!['requested', 'received', 'accepted', 'rejected', 'ready', 'cancelled', 'in-progress', 'on-hold', 'failed', 'completed', 'entered-in-error'].includes(String(found.status))) return false;
    delete wanted.status; delete found.status; delete wanted.businessStatus; delete found.businessStatus;
    for (const resource of [wanted, found]) {
      if (resource.extension !== undefined && !Array.isArray(resource.extension)) return false;
      const extensions = ((resource.extension as Array<Record<string, unknown>> | undefined) ?? []).filter(extension => extension.url !== ACTION_HISTORY_EXTENSION);
      if (extensions.length) resource.extension = extensions; else delete resource.extension;
    }
  }
  return !hasUnresolvedReferences(wanted) && canonicalJson(wanted) === canonicalJson(found);
}
