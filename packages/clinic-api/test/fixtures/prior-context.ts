import { vi } from 'vitest';
import { MedplumClient } from '../../../clinical-core/src/medplum.js';
import { buildNativeQuestionnaireCapture, toNativeQuestionnaireResponse } from '../../../clinical-core/src/questionnaire-response.js';
import { DIGEST_SYSTEM, IDENTIFIER_SYSTEM } from '../../../clinical-core/src/fhir.js';
import { NATIVE_EXTENSION } from '../../../clinic-content/src/native-questionnaire.js';
import type { TopicResponse } from '../../../clinic-content/src/types.js';
import { APPOINTMENT_TIMEZONE_EXTENSION, PLAN_CATEGORY } from '../../src/prior-context.js';
import { conversation } from '../../src/conversation.js';
import type { ClinicApiConfig, Draft } from '../../src/types.js';
import { planHandoff } from '../../../clinical-core/src/fhir.js';

export const patientReference = 'Patient/synthetic-prior';
export const sourceReference = 'DocumentReference/prior-sources/_history/1';
export const recordedAt = '2026-10-01T12:00:00.000Z';
export type Resource = Record<string, unknown>;
export const bundle = (resource?: Resource) => ({ resourceType: 'Bundle', type: 'searchset', total: resource ? 1 : 0, entry: resource ? [{ resource }] : [] });
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/fhir+json' } });
export const appointment = (): Resource => ({ resourceType: 'Appointment', id: 'prior-appointment', meta: { versionId: '2', lastUpdated: recordedAt }, status: 'booked', start: '2026-10-20T15:00:00.000Z', participant: [{ actor: { reference: patientReference }, status: 'accepted' }], extension: [{ url: APPOINTMENT_TIMEZONE_EXTENSION, valueCode: 'America/New_York' }] });
export const plan = (text = 'Synthetic exact authored plan.'): Resource => ({ resourceType: 'DocumentReference', id: 'prior-plan', meta: { versionId: '3', lastUpdated: recordedAt }, status: 'current', docStatus: 'final', subject: { reference: patientReference }, date: recordedAt, author: [{ display: 'Synthetic clinician' }], category: [{ coding: [{ system: PLAN_CATEGORY.split('|')[0], code: PLAN_CATEGORY.split('|')[1] }] }], content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: Buffer.from(text).toString('base64') } }] });

export async function prior(topic: 'Q02' | 'Q08' = 'Q02', value = 'My knees hurt when I walk.') {
  const response: TopicResponse = { presented: true, answers: topic === 'Q02' ? { concern: { state: 'known', value, sourceIds: ['prior-turn'] } } : { medicines: { state: 'known', complete: true, sourceIds: ['prior-turn'], items: [{ id: 'medicine-1', answers: { name: { state: 'known', value, sourceIds: ['prior-turn'] } } }] } } };
  const capture = await buildNativeQuestionnaireCapture({ scenario: 'first-intake', topics: { [topic]: response }, validSourceIds: new Set(['prior-turn']) });
  const qr = await toNativeQuestionnaireResponse({ capture, validSourceIds: new Set(['prior-turn']), patient: patientReference, authored: recordedAt, confirmed: true, sourceDocumentReference: sourceReference });
  const meta = { versionId: '1', lastUpdated: recordedAt, tag: [{ system: DIGEST_SYSTEM, code: 'a'.repeat(64) }] };
  const sourceData = { schemaVersion: 1, patient: patientReference, submissionId: 'synthetic-prior', version: 1, sources: [{ id: 'prior-turn', patient: patientReference, kind: 'patient-statement', text: value, capturedAt: '2026-10-01T11:00:00.000Z', channel: 'text' }] };
  const source: Resource = { resourceType: 'DocumentReference', id: 'prior-sources', meta: structuredClone(meta), status: 'current', docStatus: 'final', subject: { reference: patientReference }, date: recordedAt, type: { coding: [{ system: 'urn:corvo:clinical:document-kind', code: 'patient-conversation-sources' }] }, identifier: [{ system: IDENTIFIER_SYSTEM, value: 'synthetic-prior.v1.sources' }], content: [{ attachment: { contentType: 'application/json', data: Buffer.from(JSON.stringify(sourceData)).toString('base64') } }] };
  const questionnaire: Resource = { ...qr, id: 'prior-response', meta: structuredClone(meta), identifier: { system: IDENTIFIER_SYSTEM, value: 'synthetic-prior.v1.response' }, extension: [...qr.extension, { url: `${NATIVE_EXTENSION}intake-completeness`, valueCode: 'partial' }] };
  return { questionnaire, source, sourceData, replaceSource: () => { source.content = [{ attachment: { contentType: 'application/json', data: Buffer.from(JSON.stringify(sourceData)).toString('base64') } }]; } };
}

/** The intended ordinary guided flow: real answer, review, confirmation and FHIR handoff compiler. */
export async function productionPrior() {
  const value = 'My knees hurt when I walk.', at = new Date().toISOString();
  const patient = { reference: patientReference, displayName: 'Synthetic patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
  const content = conversation({ mentalHealth: 'phq4', patients: { 'first-intake': patient } } as unknown as ClinicApiConfig);
  let draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: patientReference, scenario: 'first-intake', revision: 0, savedAt: at, createdAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
  draft = content.select(draft, 'Q02', 'concern');
  draft = content.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: 'Q02:concern', action: 'answer', text: value, channel: 'text' });
  draft.preview = await content.preview(draft, at); draft.phase = 'review';
  const final = await content.finalize(draft, at), compiled = await planHandoff(final.confirmation);
  const versioned = (resource: Resource, id: string): Resource => ({ ...resource, id, meta: { ...(resource.meta as object), versionId: '1', lastUpdated: at } });
  const source = versioned(compiled.components[0].resource, 'prior-sources'), questionnaire = versioned(compiled.components[1].resource, 'prior-response');
  (questionnaire.extension as Record<string, unknown>[]).find(extension => extension.url === `${NATIVE_EXTENSION}source-document`)!.valueReference = { reference: sourceReference };
  return { source, questionnaire, confirmation: final.confirmation };
}

/** Real transport, fake fetch: URL shape, abort deadlines and attempt counts remain observable. */
export function clientFor(resources: { questionnaire?: Resource; source?: Resource; appointment?: Resource; plan?: Resource } = {}, onRead?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace('/fhir/R4/', '') + url.search;
    const override = onRead?.(path, init);
    if (override) return override;
    if (path === sourceReference) return resources.source ? json(resources.source) : json({}, 404);
    if (path.startsWith('QuestionnaireResponse?')) return json(bundle(resources.questionnaire));
    if (path.startsWith('Appointment?')) return json(bundle(resources.appointment));
    if (path.startsWith('DocumentReference?')) return json(bundle(resources.plan));
    const resource = [resources.questionnaire, resources.source, resources.appointment, resources.plan].find(resource => resource && `${resource.resourceType}/${resource.id}/_history/${(resource.meta as { versionId: string }).versionId}` === path);
    return resource ? json(resource) : json({}, 404);
  });
  const client = new MedplumClient({ baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic-prior-context', mode: 'local', timeoutMs: 60000 }, fetcher);
  return { client, fetcher };
}
