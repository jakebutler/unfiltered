import { z } from 'zod';
import { getNativeQuestionnaireDefinition, NATIVE_EXTENSION, NATIVE_QUESTIONNAIRE_CANONICAL, type NativeRoutingContext } from '../../clinic-content/src/native-questionnaire.js';
import type { ScenarioId, SlotAnswer, SlotAnswers } from '../../clinic-content/src/types.js';
import { fromNativeQuestionnaireResponse, nativeRoutingContextSchema, type NativeQuestionnaireResponse } from '../../clinical-core/src/questionnaire-response.js';
import { DIGEST_SYSTEM, IDENTIFIER_SYSTEM } from '../../clinical-core/src/fhir.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { submissionSchema, unresolvedRecognitionSourceIds, type Source } from '../../clinical-core/src/domain.js';

export interface PriorContextSource { reference: string; version: string; recordedAt: string; kind: 'appointment' | 'plan' | 'prior-submission'; truncated?: boolean }
export interface PriorContext { context: NativeRoutingContext; sources: PriorContextSource[] }
export interface FrozenPriorContext extends PriorContext { loadedAt: string }
export const PLAN_CATEGORY = 'urn:corvo:clinical:document-kind|follow-up-plan';
export const APPOINTMENT_TIMEZONE_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/timezone';
const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const instant = z.string().datetime({ offset: true });
export const frozenPriorContextSchema: z.ZodType<FrozenPriorContext> = z.object({
  context: nativeRoutingContextSchema,
  sources: z.array(z.object({ reference: z.string().regex(/^(Appointment|CarePlan|DocumentReference|QuestionnaireResponse)\/[A-Za-z0-9.-]{1,64}$/), version: id, recordedAt: instant, kind: z.enum(['appointment', 'plan', 'prior-submission']), truncated: z.boolean().optional() }).strict()).max(3),
  loadedAt: instant,
}).strict().refine(value => Object.keys(value.context).every(key => ['appointment', 'plan', 'priorSubmission'].includes(key))
  && value.sources.length === Object.keys(value.context).length
  && new Set(value.sources.map(source => source.kind)).size === value.sources.length
  && value.sources.every(source => {
    const context = source.kind === 'appointment' ? value.context.appointment : source.kind === 'plan' ? value.context.plan : value.context.priorSubmission;
    return context?.reference === source.reference && context.version === source.version && context.recordedAt === source.recordedAt
      && Date.parse(source.recordedAt) <= Date.parse(value.loadedAt)
      && (source.kind === 'plan' ? !!source.truncated === !!value.context.plan?.truncated : source.truncated === undefined);
  }));
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-prior-context');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error('invalid-prior-context'); return value; };
const text = (value: unknown, maximum = 8000): string => z.string().min(1).max(maximum).parse(value);
function identity(value: unknown, type: string) {
  const resource = object(value);
  if (resource.resourceType !== type) throw new Error('invalid-prior-context-resource');
  return { resource, reference: `${type}/${id.parse(resource.id)}`, version: id.parse(object(resource.meta).versionId) };
}
function latest(body: unknown): unknown | undefined {
  const bundle = object(body);
  if (bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset') throw new Error('invalid-prior-context-search');
  const entries = bundle.entry === undefined ? [] : array(bundle.entry);
  if (entries.length > 1 || bundle.total !== undefined && (!Number.isSafeInteger(bundle.total) || Number(bundle.total) < entries.length) || !entries.length && bundle.total !== undefined && bundle.total !== 0) throw new Error('invalid-prior-context-search');
  if (bundle.link !== undefined) array(bundle.link).forEach(link => { const item = object(link); text(item.relation, 100); text(item.url, 8000); });
  if (!entries.length) return;
  const resource = object(entries[0]).resource;
  object(resource);
  return resource;
}
function extension(resource: Record<string, unknown>, url: string): Record<string, unknown> | undefined {
  const found = resource.extension === undefined ? [] : array(resource.extension).map(object).filter(entry => entry.url === url);
  if (found.length > 1) throw new Error('ambiguous-prior-context-extension');
  return found[0];
}
function utf8Inline(attachment: Record<string, unknown>): string | undefined {
  if (attachment.url !== undefined || attachment.data === undefined) return;
  if (typeof attachment.contentType !== 'string' || !/^text\/plain(?:;\s*charset=utf-8)?$/i.test(attachment.contentType)) return;
  const data = text(attachment.data, 1_500_000);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('invalid-prior-context-encoding');
  const bytes = Buffer.from(data, 'base64');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function patient(resource: Record<string, unknown>, reference: string) {
  if (object(resource.subject).reference !== reference) throw new Error('prior-context-patient-mismatch');
}
function digestTag(resource: Record<string, unknown>): string {
  const tags = array(object(resource.meta).tag).map(object).filter(tag => tag.system === DIGEST_SYSTEM);
  if (tags.length !== 1) throw new Error('unconfirmed-prior-response');
  return z.string().regex(/^[a-f0-9]{64}$/).parse(tags[0].code);
}
function componentIdentity(resource: Record<string, unknown>, singleton = false): string {
  const identifiers = singleton ? [object(resource.identifier)] : array(resource.identifier).map(object);
  const found = identifiers.filter(identifier => identifier.system === IDENTIFIER_SYSTEM);
  if (found.length !== 1) throw new Error('unconfirmed-prior-response');
  return text(found[0].value, 300);
}
function exactPatientItem(answer: SlotAnswer | undefined, sources: readonly Source[], unreviewed: readonly string[]): string | undefined {
  if (answer?.state !== 'known' || answer.items || typeof answer.value !== 'string' || !answer.value.trim() || !answer.sourceIds.length || answer.value.length > 8000) return;
  const value = answer.value;
  if (answer.sourceIds.some(id => unreviewed.includes(id))) return;
  const cited = answer.sourceIds.map(id => sources.find(source => source.id === id));
  if (cited.some(source => !source || !['patient-statement', 'patient-correction'].includes(String(source.kind)) || source.channel === 'unreviewed-transcript' || typeof source.text !== 'string')) return;
  // Exact values alone may be read back. A model summary or inferred medicine name is not a prior quote.
  return cited.some(source => (source!.text as string).includes(value)) ? value : undefined;
}

/** Optional read-only context. Every network operation has one transport-owned deadline and no retry.
 * Nothing is promoted to a current answer; any failure discards the entire lookup. */
export async function loadPriorContext(client: MedplumClient, patientReference: string, scenario: ScenarioId): Promise<PriorContext> {
  const empty = (): PriorContext => ({ context: {}, sources: [] });
  if (!['pre-visit', 'post-visit'].includes(scenario)) return empty();
  try {
    if (!/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(patientReference)) throw new Error('invalid-prior-context-patient');
    const now = new Date().toISOString(), context: NativeRoutingContext = {}, sources: PriorContextSource[] = [];
    const read = async (path: string) => (await client.request(path, 'GET', undefined, undefined, { timeoutMs: 5000 })).body;
    const search = async (type: string, parameters: Record<string, string>) => latest(await read(`${type}?${new URLSearchParams({ ...parameters, _count: '1' })}`));
    const qr = await search('QuestionnaireResponse', { subject: patientReference, questionnaire: NATIVE_QUESTIONNAIRE_CANONICAL, status: 'completed,stopped', _sort: '-authored' });
    if (qr !== undefined) {
      const prior = identity(qr, 'QuestionnaireResponse'), resource = prior.resource;
      patient(resource, patientReference);
      if (object(resource.source).reference !== patientReference || !['completed', 'stopped'].includes(String(resource.status))) throw new Error('unconfirmed-prior-response');
      const recordedAt = instant.parse(resource.authored);
      if (Date.parse(recordedAt) > Date.parse(now)) throw new Error('future-prior-response');
      const definition = await getNativeQuestionnaireDefinition();
      if (resource.questionnaire !== `${definition.binding.canonical}|${definition.binding.version}` || extension(resource, `${NATIVE_EXTENSION}definition-digest`)?.valueString !== definition.binding.digest) throw new Error('unsupported-prior-response');
      const header = object(JSON.parse(text(extension(resource, `${NATIVE_EXTENSION}capture-header`)?.valueString, 400000)));
      // Prior qualified representation authority cannot be recreated from an audit string.
      // Unsupported captures stay unavailable rather than being credited as ordinary answers.
      if (header.reviewBinding !== undefined) throw new Error('unsupported-prior-review-authority');
      const binding = object(header.definition);
      if (binding.canonical !== definition.binding.canonical || binding.version !== definition.binding.version || binding.digest !== definition.binding.digest) throw new Error('unsupported-prior-response');
      const unreviewed = array(header.unreviewedSourceIds).map(value => text(value, 100));
      const completeness = extension(resource, `${NATIVE_EXTENSION}intake-completeness`)?.valueCode;
      if (!['partial', 'complete'].includes(String(completeness)) || resource.status === 'stopped' && completeness !== 'partial') throw new Error('unconfirmed-prior-response');
      const sourceReference = object(extension(resource, `${NATIVE_EXTENSION}source-document`)?.valueReference).reference;
      if (typeof sourceReference !== 'string' || !/^DocumentReference\/[A-Za-z0-9.-]{1,64}\/_history\/[A-Za-z0-9.-]{1,64}$/.test(sourceReference)) throw new Error('unversioned-prior-source');
      const source = identity(await read(sourceReference), 'DocumentReference'), sourceResource = source.resource;
      patient(sourceResource, patientReference);
      if (`${source.reference}/_history/${source.version}` !== sourceReference || sourceResource.status !== 'current' || sourceResource.docStatus !== 'final' || instant.parse(sourceResource.date) !== recordedAt || digestTag(sourceResource) !== digestTag(resource)) throw new Error('prior-source-mismatch');
      const sourceKind = array(object(sourceResource.type).coding).map(object);
      if (!sourceKind.some(coding => coding.system === 'urn:corvo:clinical:document-kind' && coding.code === 'patient-conversation-sources')) throw new Error('invalid-prior-source-kind');
      const responseKey = componentIdentity(resource, true), sourceKey = componentIdentity(sourceResource);
      if (!responseKey.endsWith('.response') || sourceKey !== `${responseKey.slice(0, -'.response'.length)}.sources`) throw new Error('prior-source-mismatch');
      const content = array(sourceResource.content);
      if (content.length !== 1) throw new Error('invalid-prior-source');
      const attachment = object(object(content[0]).attachment);
      if (attachment.contentType !== 'application/json' || attachment.url !== undefined) throw new Error('invalid-prior-source');
      const encoded = text(attachment.data, 1_500_000);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('invalid-prior-source');
      const sourceData = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'))));
      text(sourceData.submissionId, 64); z.number().int().positive().parse(sourceData.version);
      if (sourceData.schemaVersion !== 1 || sourceData.patient !== patientReference || responseKey !== `${sourceData.submissionId}.v${sourceData.version}.response`) throw new Error('prior-source-mismatch');
      const patientSources = submissionSchema.shape.sources.parse(sourceData.sources);
      if (patientSources.length > 550 || new Set(patientSources.map(source => source.id)).size !== patientSources.length) throw new Error('invalid-prior-source');
      for (const source of patientSources) {
        if (source.patient !== patientReference || !['patient-statement', 'patient-correction', 'assistant-statement'].includes(String(source.kind))) throw new Error('prior-source-patient-mismatch');
        text(source.id, 100); text(source.text, 12000); instant.parse(source.capturedAt);
        if (Date.parse(String(source.capturedAt)) > Date.parse(recordedAt) || source.channel !== undefined && !['text', 'confirmed-transcript', 'unreviewed-transcript'].includes(String(source.channel))) throw new Error('invalid-prior-source');
      }
      const validSourceIds = new Set(patientSources.filter(source => ['patient-statement', 'patient-correction'].includes(String(source.kind))).map(source => String(source.id)));
      // The existing decoder re-evaluates routing, active values, source scope, native
      // binding and the complete canonical response tree, including applicability rows.
      const capture = await fromNativeQuestionnaireResponse(resource as unknown as NativeQuestionnaireResponse, validSourceIds);
      const sourceById = new Map(patientSources.map(source => [source.id, source]));
      if (unresolvedRecognitionSourceIds(patientSources, capture.topics).some(id => !capture.unreviewedSourceIds.includes(id))) throw new Error('prior-recognition-mismatch');
      const checkKnownSources = (answers: SlotAnswers) => {
        for (const [path, answer] of Object.entries(answers)) if (answer?.state === 'known') {
          if (answer.sourceIds.some(id => sourceById.get(id)?.channel === 'unreviewed-transcript')) throw new Error('prior-recognition-mismatch');
          if ((path === 'statedAt' || path.endsWith('.statedAt')) && answer.sourceIds.some(id => sourceById.get(id)?.capturedAt !== answer.value)) throw new Error('prior-source-time-mismatch');
          for (const item of answer.items ?? []) checkKnownSources(item.answers);
        }
      };
      for (const topic of Object.values(capture.topics)) checkKnownSources(topic.answers);
      const concern = capture.topics.Q02?.answers.concern, medicines = capture.topics.Q08?.answers.medicines;
      const candidates: Array<{ topicId: 'Q02' | 'Q08'; path: string; answer: SlotAnswer | undefined }> = [{ topicId: 'Q02', path: 'concern', answer: concern }];
      const confirmedCollection = medicines?.state === 'known' && medicines.items && medicines.sourceIds.length > 0
        && medicines.sourceIds.every(id => !unreviewed.includes(id) && patientSources.some(source => source.id === id && ['patient-statement', 'patient-correction'].includes(String(source.kind)) && source.channel !== 'unreviewed-transcript'));
      if (confirmedCollection && medicines?.state === 'known' && medicines.items) for (const medicine of medicines.items) candidates.push({ topicId: 'Q08', path: `medicines[${medicine.id}].name`, answer: medicine.answers.name });
      const item = candidates.map(candidate => ({ ...candidate, value: exactPatientItem(candidate.answer, patientSources, unreviewed) })).find(candidate => candidate.value !== undefined);
      context.priorSubmission = { reference: prior.reference, version: prior.version, recordedAt, sourceDocumentReference: sourceReference, ...(item ? { item: item.value!, topicId: item.topicId, path: item.path } : {}) };
      sources.push({ reference: prior.reference, version: prior.version, recordedAt, kind: 'prior-submission' });
    }
    if (scenario === 'pre-visit') {
      const result = await search('Appointment', { patient: patientReference, status: 'booked', date: `ge${now}`, _sort: 'date' });
      if (result !== undefined) {
        const appointment = identity(result, 'Appointment'), resource = appointment.resource;
        if (resource.status !== 'booked') throw new Error('invalid-prior-appointment');
        const participants = array(resource.participant).map(object), patients = participants.map(entry => object(entry.actor).reference).filter(reference => typeof reference === 'string' && reference.startsWith('Patient/'));
        if (patients.length !== 1 || patients[0] !== patientReference) throw new Error('prior-appointment-patient-mismatch');
        const startsAt = instant.parse(resource.start), recordedAt = instant.parse(object(resource.meta).lastUpdated);
        if (Date.parse(startsAt) < Date.parse(now) || Date.parse(recordedAt) > Date.parse(now)) throw new Error('invalid-prior-appointment-date');
        const zone = extension(resource, APPOINTMENT_TIMEZONE_EXTENSION), timezone = zone ? text(zone.valueCode, 100) : 'Not recorded';
        if (zone) new Intl.DateTimeFormat('en', { timeZone: timezone });
        context.appointment = { reference: appointment.reference, version: appointment.version, startsAt, timezone, recordedAt, ...(context.priorSubmission ? { priorUpdateAt: context.priorSubmission.recordedAt } : {}) };
        sources.push({ reference: appointment.reference, version: appointment.version, recordedAt, kind: 'appointment' });
      }
    }
    if (scenario === 'post-visit') {
      const result = await search('DocumentReference', { patient: patientReference, category: PLAN_CATEGORY, _sort: '-date' });
      if (result !== undefined) {
        const plan = identity(result, 'DocumentReference'), resource = plan.resource;
        patient(resource, patientReference);
        if (resource.status !== 'current' || resource.docStatus !== 'final') throw new Error('invalid-prior-plan');
        const category = array(resource.category).map(object).flatMap(category => array(category.coding).map(object));
        if (!category.some(coding => `${coding.system}|${coding.code}` === PLAN_CATEGORY)) throw new Error('invalid-prior-plan-category');
        const recordedAt = instant.parse(resource.date);
        if (Date.parse(recordedAt) > Date.parse(now)) throw new Error('future-prior-plan');
        const author = text(object(array(resource.author)[0]).display), content = array(resource.content);
        if (content.length !== 1) throw new Error('ambiguous-prior-plan');
        const planText = utf8Inline(object(object(content[0]).attachment));
        if (planText?.trim()) {
          const truncated = planText.length > 8000;
          context.plan = { reference: plan.reference, version: plan.version, author, recordedAt, text: planText.slice(0, 8000).replace(/[\uD800-\uDBFF]$/, ''), ...(truncated ? { truncated: true } : {}) };
          sources.push({ reference: plan.reference, version: plan.version, recordedAt, kind: 'plan', ...(truncated ? { truncated: true } : {}) });
        }
      }
    }
    return { context: nativeRoutingContextSchema.parse(context), sources };
  } catch {
    return empty();
  }
}

/** Staff readback uses only context bound into the confirmed capture and the named staff client's
 * current authorization for each immutable source. A missing grant hides that source alone. */
export async function authorizedContextSources(client: MedplumClient, patientReference: string, context?: NativeRoutingContext): Promise<PriorContextSource[]> {
  const candidates: PriorContextSource[] = [
    ...(context?.appointment?.recordedAt ? [{ kind: 'appointment' as const, reference: context.appointment.reference, version: context.appointment.version, recordedAt: context.appointment.recordedAt }] : []),
    ...(context?.plan ? [{ kind: 'plan' as const, reference: context.plan.reference, version: context.plan.version, recordedAt: context.plan.recordedAt, ...(context.plan.truncated ? { truncated: true } : {}) }] : []),
    ...(context?.priorSubmission ? [{ kind: 'prior-submission' as const, reference: context.priorSubmission.reference, version: context.priorSubmission.version, recordedAt: context.priorSubmission.recordedAt }] : []),
  ];
  const visible: PriorContextSource[] = [];
  for (const candidate of candidates) {
    try {
      if (!/^(Appointment|CarePlan|DocumentReference|QuestionnaireResponse)\/[A-Za-z0-9.-]{1,64}$/.test(candidate.reference)) continue;
      id.parse(candidate.version); instant.parse(candidate.recordedAt);
      const path = `${candidate.reference}/_history/${candidate.version}`;
      const read = identity((await client.request(path, 'GET', undefined, undefined, { timeoutMs: 5000 })).body, candidate.reference.split('/')[0]);
      if (read.reference !== candidate.reference || read.version !== candidate.version) continue;
      if (candidate.kind === 'appointment') {
        const patients = array(read.resource.participant).map(object).map(participant => object(participant.actor).reference).filter(reference => typeof reference === 'string' && reference.startsWith('Patient/'));
        if (patients.length !== 1 || patients[0] !== patientReference || object(read.resource.meta).lastUpdated !== candidate.recordedAt) continue;
      } else {
        patient(read.resource, patientReference);
        if ((candidate.kind === 'prior-submission' ? read.resource.authored : read.resource.date) !== candidate.recordedAt) continue;
      }
      if (candidate.kind === 'prior-submission') {
        const sourcePath = context!.priorSubmission!.sourceDocumentReference;
        const source = identity((await client.request(sourcePath, 'GET', undefined, undefined, { timeoutMs: 5000 })).body, 'DocumentReference');
        patient(source.resource, patientReference);
        if (`${source.reference}/_history/${source.version}` !== sourcePath || source.resource.date !== candidate.recordedAt) continue;
      }
      visible.push(candidate);
    } catch {
      // Context audit metadata never broadens a staff member's record access.
    }
  }
  return visible;
}
