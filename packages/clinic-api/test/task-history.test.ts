import { expect, it } from 'vitest';
import { canonicalJson, digest } from '../../clinical-core/src/domain.js';
import { ACTION_HISTORY_EXTENSION } from '../../clinical-core/src/fhir.js';
import { MedplumClient, fhirResource } from '../../clinical-core/src/medplum.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
import { appendAction, signAction, verifiedTaskHistory, type ActionScope } from '../src/task-history.js';
const secret = 'synthetic-private-history-key'.repeat(3);
async function setup() {
  const native = mockFhir(), client = new MedplumClient({ baseUrl: 'http://127.0.0.1:8103/fhir/R4/', accessToken: 'synthetic', mode: 'local', timeoutMs: 1000 }, native.fetcher);
  const task = fhirResource((await client.request('Task', 'POST', { resourceType: 'Task', status: 'requested', intent: 'order' })).body), reference = `Task/${task.id}`;
  const scope: ActionScope = { project: 'synthetic-project', task: reference, patient: 'Patient/synthetic', submissionId: crypto.randomUUID(), version: 1, digest: 'a'.repeat(64), workId: 'medical', owner: 'CareTeam/medical' };
  const action = await signAction(secret, { schema: 1, actionId: crypto.randomUUID(), fingerprint: 'b'.repeat(64), scope, priorTaskVersion: '1', previousHistoryDigest: await digest([]), name: 'Synthetic MD', membership: 'named-member', member: 'Practitioner/md', role: 'physician', at: new Date().toISOString(), outcome: 'reviewed', submissionId: scope.submissionId, version: 1, digest: scope.digest, workId: 'medical', note: 'Synthetic explicit review.' });
  const saved = fhirResource((await client.request(reference, 'PUT', appendAction(task, action), { 'If-Match': 'W/"1"' })).body);
  return { native, client, scope, action, saved, reference };
}
it('authenticates history and attributes only the native revision created by that action', async () => {
  const f = await setup(); expect((await verifiedTaskHistory(f.client, f.saved, f.scope, secret)).latest?.actionId).toBe(f.action.actionId);
  const external = fhirResource((await f.client.request(f.reference, 'PUT', { ...f.saved, status: 'completed' }, { 'If-Match': 'W/"2"' })).body);
  expect(await verifiedTaskHistory(f.client, external, f.scope, secret)).toMatchObject({ external: true, latest: undefined, entries: [f.action] });
});
it('rejects removal of authenticated action history rather than treating it as an absent review', async () => {
  const f = await setup();
  const truncated = fhirResource((await f.client.request(f.reference, 'PUT', { ...f.saved, extension: [] }, { 'If-Match': 'W/"2"' })).body);
  await expect(verifiedTaskHistory(f.client, truncated, f.scope, secret)).rejects.toMatchObject({ code: 'work-history-integrity-unavailable' });
});
it('rejects an older valid signed prefix and binds actions to exact Task/project/patient', async () => {
  const f = await setup();
  const { signature: _, ...firstPayload } = f.action;
  const later = await signAction(secret, { ...firstPayload, actionId: crypto.randomUUID(), fingerprint: 'c'.repeat(64), priorTaskVersion: '2', previousHistoryDigest: await digest([f.action]), outcome: 'resolved', note: 'Synthetic resolution.' });
  const second = fhirResource((await f.client.request(f.reference, 'PUT', appendAction(f.saved, later), { 'If-Match': 'W/"2"' })).body);
  const oldPrefix = fhirResource((await f.client.request(f.reference, 'PUT', { ...second, extension: [{ url: ACTION_HISTORY_EXTENSION, valueString: canonicalJson([f.action]) }] }, { 'If-Match': 'W/"3"' })).body);
  await expect(verifiedTaskHistory(f.client, oldPrefix, f.scope, secret)).rejects.toThrow('work-history-integrity-unavailable');
  await expect(verifiedTaskHistory(f.client, oldPrefix, { ...f.scope, patient: 'Patient/other' }, secret)).rejects.toThrow('work-history-integrity-unavailable');
});
it('rejects forged actor/note/signature entries and history outages', async () => {
  const f = await setup();
  const forged = fhirResource((await f.client.request(f.reference, 'PUT', { ...f.saved, extension: [{ url: ACTION_HISTORY_EXTENSION, valueString: canonicalJson([{ ...f.action, member: 'Practitioner/forged', note: 'Forged review' }]) }] }, { 'If-Match': 'W/"2"' })).body);
  await expect(verifiedTaskHistory(f.client, forged, f.scope, secret)).rejects.toThrow('work-history-integrity-unavailable');
  const unavailable = new MedplumClient(f.client.config, async () => new Response('{}', { status: 503 }));
  await expect(verifiedTaskHistory(unavailable, forged, f.scope, secret)).rejects.toThrow();
});
