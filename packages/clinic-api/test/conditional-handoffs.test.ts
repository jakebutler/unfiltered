import { getNativeQuestionnaireDefinition } from '../../clinic-content/src/native-questionnaire.js';
import { expect, it } from 'vitest';
import { digest } from '../../clinical-core/src/domain.js';
import { MedplumClient, type DeliveryQualification } from '../../clinical-core/src/medplum.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
import { handoffs } from '../src/handoffs.js';
import { conversation } from '../src/conversation.js';
import { createDraft, readDraft, saveDraft } from '../src/store.js';
import type { ClinicApiConfig, Draft, StaffAssignment } from '../src/types.js';
import { createClinicHandler } from '../src/handler.js';
import { cookies } from '../src/cookies.js';
const fixture = { reference: 'Patient/synthetic', displayName: 'Synthetic Patient', description: 'Technical synthetic fixture', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/admin' } };
const roles = ['physician', 'registered-dietitian', 'administrative'] as const;
const actors: StaffAssignment[] = roles.map((role, index) => ({ membershipId: `staff-${index}`, profile: `Practitioner/staff-${index}`, policy: 'AccessPolicy/synthetic', role, name: `Synthetic staff ${index}`, patients: [fixture.reference], careTeams: [Object.values(fixture.careTeams)[index]] }));
const config = { origin: 'http://127.0.0.1:5173', projectId: 'synthetic-project', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', medplumBaseUrl: 'http://127.0.0.1:8103/', cookieSecret: 'synthetic-cookie-key-at-least32characters', mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, fixture])), staff: actors } as ClinicApiConfig;
async function setup(scenario: Draft['scenario'] = 'first-intake') {
  const native = mockFhir({ atomic: false }), client = new MedplumClient({ baseUrl: 'http://127.0.0.1:8103/fhir/R4/', accessToken: 'synthetic-token', mode: 'local', timeoutMs: 1000 }, native.fetcher);
  const definition = await getNativeQuestionnaireDefinition();
  const questionnaire = (await client.request('Questionnaire', 'POST', definition.questionnaire)).body as { id: string; meta: { versionId: string } };
  config.nativeQuestionnaire = { ...definition.binding, reference: `Questionnaire/${questionnaire.id}/_history/${questionnaire.meta.versionId}` };
  client.config.nativeQuestionnaire = config.nativeQuestionnaire;
  const q: DeliveryQualification = { deliveryContract: 'conditional-resumable-v1', baseUrl: client.config.baseUrl, mode: 'local', credentialFingerprint: await digest(client.config.accessToken), conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true, qualifiedAt: new Date().toISOString() };
  const content = conversation(config), now = new Date().toISOString();
  let draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: fixture.reference, scenario, revision: 1, savedAt: now, createdAt: now, phase: 'conversation', turns: [{ id: 'synthetic-source', role: 'patient', text: 'Synthetic clinical concern: needs medical review.', at: now, channel: 'text' }], topics: {}, requests: {}, version: 1 };
  if (scenario === 'billing') { draft = content.select(draft, 'W05', 'issueType'); const prompt = content.view(draft).currentPrompt!; draft = content.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: prompt.id, action: 'answer', text: 'bill-question' }); }
  draft.preview = await content.preview(draft); draft.phase = 'review'; draft.confirmed = await content.finalize(draft); draft.preview = undefined; draft.phase = 'confirmed';
  await createDraft(client, draft);
  return { native, client, q, content, draft, h: handoffs(config), id: `${draft.id}.v1` };
}
it('discovers confirmed intent without a snapshot and shows zero-Task anchors to MD and RD', async () => {
  const f = await setup(), before = await f.h.view(f.client, f.client, actors[0], f.id);
  expect(before).toMatchObject({ deliveryState: 'pending', anchorsVerified: false, sources: [], topics: [], canResume: true });
  expect((await f.h.queue(f.client, f.client, actors[0])).recovery).toEqual([expect.objectContaining({ id: f.id, anchorsVerified: false })]);
  const failing = new MedplumClient(f.client.config, async (input, init) => init?.method === 'POST' && String(input).endsWith('/Task') ? new Response('{}', { status: 503 }) : f.native.fetcher(input, init));
  const md = await f.h.resume(failing, f.client, actors[0], f.id, f.q), rd = await f.h.view(f.client, f.client, actors[1], f.id);
  expect(md).toMatchObject({ deliveryState: 'incomplete', anchorsVerified: true, allowedActions: [] }); expect(md.sources).toHaveLength(1); expect(rd.sources).toEqual(md.sources); expect(md.work.every(work => work.status === 'pending')).toBe(true);
  expect((await f.h.queue(f.client, f.client, actors[0])).recovery[0]).toMatchObject({ id: f.id, anchorsVerified: true });
});
it('records own verified review with a sibling missing, keeps stable replay identity and detects native external changes', async () => {
  const f = await setup(); await f.h.snapshot(f.client, f.draft);
  const failing = new MedplumClient(f.client.config, async (input, init) => { const body = init?.body ? JSON.parse(String(init.body)) : {}; return init?.method === 'POST' && body.owner?.reference === fixture.careTeams.nutrition ? new Response('{}', { status: 503 }) : f.native.fetcher(input, init); });
  await failing.deliver(f.draft.confirmed!.confirmation, f.q);
  const partial = await f.h.view(f.client, f.client, actors[0], f.id), own = partial.work.find(work => work.id === 'medical')!;
  const input = { actionId: crypto.randomUUID(), workId: 'medical', expectedVersion: 1, expectedWorkVersion: own.revision, outcome: 'reviewed' as const, note: 'Synthetic confirmed medical review.' };
  const first = await f.h.action(f.client, f.client, actors[0], f.id, input);
  expect(first.deliveryState).toBe('incomplete'); expect(first.work.find(work => work.id === 'medical')?.status).toBe('reviewed');
  const writes = f.native.counters.writes; await f.h.action(f.client, f.client, actors[0], f.id, input); expect(f.native.counters.writes).toBe(writes);
  await expect(f.h.action(f.client, f.client, actors[0], f.id, { ...input, note: 'Different content' })).rejects.toMatchObject({ code: 'action-id-conflict' });
  await expect(f.h.action(f.client, f.client, actors[1], f.id, input)).rejects.toMatchObject({ code: 'own-work-not-received' });
  const later = { ...input, actionId: crypto.randomUUID(), expectedWorkVersion: first.work.find(work => work.id === 'medical')!.revision, outcome: 'needs-information' as const, note: 'Synthetic second action.' };
  const second = await f.h.action(f.client, f.client, actors[0], f.id, later);
  expect((await f.h.action(f.client, f.client, actors[0], f.id, input)).work.find(work => work.id === 'medical')?.history).toHaveLength(2);
  const receipt = await f.client.check(f.draft.confirmed!.confirmation), reference = receipt.resources[`${f.draft.id}.v1.work.medical`], task = f.native.resources.get(reference)!;
  await f.client.request(reference, 'PUT', { ...task, status: 'completed' }, { 'If-Match': `W/"${second.work.find(work => work.id === 'medical')!.revision}"` });
  const external = (await f.h.view(f.client, f.client, actors[0], f.id)).work.find(work => work.id === 'medical')!;
  expect(external.status).toBe('external-change'); expect(external.history).toHaveLength(2); expect(external.author).toBeUndefined(); expect(external.outcome).toBeUndefined();
});
it('recovers a lost CAS response and rejects concurrent/stale actions without reapplication', async () => {
  const f = await setup(); await f.h.snapshot(f.client, f.draft); await f.client.deliver(f.draft.confirmed!.confirmation, f.q);
  const view = await f.h.view(f.client, f.client, actors[0], f.id), input = { actionId: crypto.randomUUID(), workId: 'medical', expectedVersion: 1, expectedWorkVersion: view.work.find(work => work.id === 'medical')!.revision, outcome: 'reviewed' as const, note: 'Synthetic lost-response action.' };
  let lost = false;
  const lossy = new MedplumClient(f.client.config, async (url, init) => { const response = await f.native.fetcher(url, init); if (!lost && init?.method === 'PUT' && response.ok) { lost = true; throw new Error('lost accepted response'); } return response; });
  const recovered = await f.h.action(lossy, f.client, actors[0], f.id, input); expect(lost).toBe(true); expect(recovered.work.find(work => work.id === 'medical')?.history).toHaveLength(1);
  const base = { ...input, expectedWorkVersion: recovered.work.find(work => work.id === 'medical')!.revision };
  const attempts = await Promise.allSettled([f.h.action(f.client, f.client, actors[0], f.id, { ...base, actionId: crypto.randomUUID(), note: 'Concurrent A' }), f.h.action(f.client, f.client, actors[0], f.id, { ...base, actionId: crypto.randomUUID(), note: 'Concurrent B' })]);
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await f.h.view(f.client, f.client, actors[0], f.id)).work.find(work => work.id === 'medical')?.history).toHaveLength(2);
});
it('serializes confirmed sanitized admin logistics and does not expose clinical sources or notes', async () => {
  const f = await setup('billing'); await f.h.snapshot(f.client, f.draft); await f.client.deliver(f.draft.confirmed!.confirmation, f.q);
  expect(f.draft.confirmed!.confirmation.submission.administrativeLogistics).toEqual({ kind: 'billing', issueType: 'bill-question' });
  const admin = await f.h.view(f.client, f.client, actors[2], f.id); expect(admin.sources).toEqual([]); expect(admin.topics[0].details?.[0].text).toBe('bill-question'); expect(JSON.stringify(admin)).not.toContain('Synthetic clinical concern');
  const task = [...f.native.resources.values()].find(resource => resource.resourceType === 'Task' && (resource.owner as { reference: string }).reference === fixture.careTeams.administrative)!;
  expect(task).not.toHaveProperty('focus'); expect(task).not.toHaveProperty('input'); expect(JSON.stringify(task)).not.toContain('QuestionnaireResponse/');
});
it('resuming a frozen v1 never saves over an active v2 correction and receipt GET performs zero writes', async () => {
  const f = await setup(); await f.h.snapshot(f.client, f.draft);
  const failing = new MedplumClient(f.client.config, async (url, init) => init?.method === 'POST' && String(url).endsWith('/Task') ? new Response('{}', { status: 503 }) : f.native.fetcher(url, init));
  await failing.deliver(f.draft.confirmed!.confirmation, f.q);
  const stored = await readDraft(f.client, f.draft.id, f.draft.patient), correction = f.content.select(stored.draft, 'Q01', 'reason'); correction.revision++; correction.savedAt = new Date().toISOString(); await saveDraft(f.client, stored, correction);
  const active = await readDraft(f.client, f.draft.id, f.draft.patient); await f.h.resume(f.client, f.client, actors[0], f.id, f.q); expect((await readDraft(f.client, f.draft.id, f.draft.patient)).draft).toEqual(active.draft);
  const jar = cookies(config.cookieSecret, false), cookie = (await jar.issue('clinic_patient', { kind: 'patient', sessionId: f.draft.id, patient: f.draft.patient, scenario: f.draft.scenario, identityConfirmed: true, expires: Date.now() + 60000 })).split(';')[0];
  const handler = createClinicHandler(config, { fetcher: f.native.fetcher, runtime: async () => ({ client: f.client, qualification: f.q }) }), writes = f.native.counters.writes;
  const response = await handler(new Request(`${config.origin}/api/clinic/receipt`, { headers: { cookie } })); expect(response.status).toBe(200); expect(f.native.counters.writes).toBe(writes); expect((await readDraft(f.client, f.draft.id, f.draft.patient)).draft.version).toBe(2);
});
