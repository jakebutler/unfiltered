import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import WebSocket from 'ws';
import { localConfig } from './setup-local.mjs';

const env = await localConfig(); // Exact loopback URL and private-file permissions, never hosted.
const secrets = JSON.parse(await readFile(new URL('./operator.private.json', import.meta.url), 'utf8'));
const guest = new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false });
const operator = new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false });
const admin = new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false }); admin.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
const id = randomUUID(), checks = [], clients = [], subscriptionEvents = [];
const receipt = { id, startedAt: new Date().toISOString(), scope: 'isolated-self-hosted-convex', url: env.CONVEX_SELF_HOSTED_URL, checks, subscriptionEvents, cloudMutations: 0, providerCalls: 0, cash: 0 };
let phase = 'setup';
const run = async (name, fn) => { phase = name; const details = await fn(); checks.push({ name, passed: true, ...(details ?? {}) }); };
const setFixture = async enabled => {
  const response = await fetch(`${env.CONVEX_SELF_HOSTED_URL}/api/update_environment_variables`, { method: 'POST', headers: { Authorization: `Convex ${env.CONVEX_SELF_HOSTED_ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: [{ name: 'RESEARCH_LIFECYCLE_QUALIFICATION', value: enabled ? 'local-only' : null }] }) });
  assert(response.ok, 'Local fixture environment change failed');
};
const within = (promise, ms, description) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(description)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
function observe(client, query, args, expected) {
  let initialResolve, initialReject, deniedResolve, deniedReject;
  let first = false;
  const initial = new Promise((resolve, reject) => { initialResolve = resolve; initialReject = reject; });
  const denied = new Promise((resolve, reject) => { deniedResolve = resolve; deniedReject = reject; });
  denied.catch(() => {});
  const unsubscribe = client.onUpdate(ref(query), args, result => {
    if (!first) { try { expected(result); first = true; initialResolve(); } catch (error) { initialReject(error); } }
  }, error => {
    subscriptionEvents.push({ query, at: Date.now(), hadInitialResult: first, expectedDenial: error.data === 'Access unavailable' });
    if (!first) initialReject(new Error('Subscription failed before initial result'));
    else if (error.data === 'Access unavailable') deniedResolve(Date.now());
    else deniedReject(new Error('Subscription failed for a non-lifecycle reason'));
  });
  return { initial, denied, unsubscribe };
}
try {
  await setFixture(true);
  const signed = await operator.action(ref('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: secrets.email, password: secrets.password } });
  assert(signed.tokens?.token); operator.setAuth(signed.tokens.token);
  const clientId = await operator.mutation(ref('research:createClient'), { name: `Lifecycle qualification ${id}` });
  const projectId = await operator.mutation(ref('research:createProject'), { clientId, name: 'Local lifecycle fixture' });
  await operator.mutation(ref('research:saveStudy'), { clientId, projectId, expectedRevision: 0, definition: { title: 'Lifecycle fixture', introduction: 'Fictional local retention check.', goals: ['Expiry and source deletion'], script: [{ id: 'q1', question: 'First synthetic prompt?' }, { id: 'q2', question: 'Second synthetic prompt?' }], prototypeUrl: null, repository: null } });
  const invitation = await operator.action(ref('invitations:create'), { clientId, projectId, studyVersion: 1, requestId: `lifecycle-${id}` });
  const token = invitation.token;
  assert(token);
  const consent = { version: 'research-consent-1', storage: true, analysis: true, microphone: false, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
  await guest.mutation(ref('participant:agree'), { token, expectedRevision: 0, consent });
  const original = await guest.mutation(ref('participant:answer'), { token, expectedRevision: 1, requestId: `answer-${id}`, questionId: 'q1', text: 'Synthetic original words to delete.', channel: 'text' });
  await guest.mutation(ref('participant:correct'), { token, expectedRevision: 2, requestId: `correct-${id}`, sourceId: original.sourceId, text: 'Synthetic corrected words to delete.' });
  await run('internal fixture is unavailable to participant capability and normal operator', async () => {
    await assert.rejects(guest.mutation(ref('lifecycleQualification:prepare'), { invitationId: invitation.invitationId }));
    await assert.rejects(operator.mutation(ref('lifecycleQualification:prepare'), { invitationId: invitation.invitationId }));
  });
  const prepareStartedAt = Date.now();
  const deadlines = await admin.mutation(ref('lifecycleQualification:prepare'), { invitationId: invitation.invitationId });
  const prepareFinishedAt = Date.now();
  const localEarliestExpiry = prepareStartedAt + deadlines.expiresAt - deadlines.preparedAt;
  const localLatestExpiry = prepareFinishedAt + deadlines.expiresAt - deadlines.preparedAt;
  const localEarliestRetention = prepareStartedAt + deadlines.retainUntil - deadlines.preparedAt;
  const localLatestRetention = prepareFinishedAt + deadlines.retainUntil - deadlines.preparedAt;
  Object.assign(receipt, { prepareStartedAt, prepareFinishedAt, localEarliestExpiry, localLatestExpiry, localEarliestRetention, localLatestRetention, clientId, projectId, sessionId: invitation.sessionId, invitationId: invitation.invitationId, deadlines });
  const participantWatch = new ConvexClient(env.CONVEX_SELF_HOSTED_URL, { webSocketConstructor: WebSocket, logger: false });
  const operatorWatch = new ConvexClient(env.CONVEX_SELF_HOSTED_URL, { webSocketConstructor: WebSocket, logger: false });
  clients.push(participantWatch, operatorWatch);
  operatorWatch.setAuth(async () => signed.tokens.token);
  const expiry = observe(participantWatch, 'participant:resume', { token }, result => assert.equal(result.expiresAt, deadlines.expiresAt));
  const retention = observe(operatorWatch, 'research:sessionSources', { clientId, projectId, sessionId: invitation.sessionId, paginationOpts: { cursor: null, numItems: 25 } }, result => {
    assert.equal(result.page.length, 4);
    assert(result.page.some(s => s.author === 'interviewer'));
    assert(result.page.some(s => s.text === 'Synthetic original words to delete.'));
    assert(result.page.some(s => s.text === 'Synthetic corrected words to delete.'));
  });
  await run('live WebSocket subscriptions initially read the scoped session and four immutable sources', async () => { await within(Promise.all([expiry.initial, retention.initial]), 5000, 'Initial subscriptions timed out'); });
  await run('quiet participant subscription invalidates at scheduled invitation expiry without a client request', async () => {
    const deniedAt = await within(expiry.denied, 22_000, 'Invitation subscription did not expire');
    assert(deniedAt >= localEarliestExpiry); assert(deniedAt - localLatestExpiry < 5000);
    const persisted = await admin.query(ref('lifecycleQualification:inspect'), { sessionId: invitation.sessionId, invitationId: invitation.invitationId });
    assert(persisted.invitationExpiredAt >= deadlines.expiresAt);
    return { deniedAt, maxDelayAfterDeadlineMs: deniedAt - localEarliestExpiry, minDelayAfterDeadlineMs: deniedAt - localLatestExpiry, invitationExpiredAt: persisted.invitationExpiredAt };
  });
  expiry.unsubscribe();
  await run('retention schedule survives isolated research backend restart', async () => {
    assert(Date.now() < deadlines.retainUntil - 5000);
    await promisify(execFile)('docker', ['--context', 'colima-unfiltered-s0', 'compose', '-f', 'infra/research/compose.yml', 'restart', 'backend'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 20_000 });
    return { isolatedBackendRestarted: true };
  });
  await run('operator source subscription invalidates at retention deadline after reconnect', async () => {
    const deniedAt = await within(retention.denied, 28_000, 'Retention subscription did not expire');
    assert(deniedAt >= localEarliestRetention); assert(deniedAt - localLatestRetention < 5000);
    return { deniedAt, maxDelayAfterDeadlineMs: deniedAt - localEarliestRetention, minDelayAfterDeadlineMs: deniedAt - localLatestRetention };
  });
  retention.unsubscribe();
  await run('all prompt, original and correction rows are physically gone; only tombstone metadata remains', async () => {
    const state = await admin.query(ref('lifecycleQualification:inspect'), { sessionId: invitation.sessionId, invitationId: invitation.invitationId });
    assert.deepEqual(state, { invitationExpiredAt: state.invitationExpiredAt, retentionState: 'purged', sourceCount: 0, physicalSourceCount: 0, hasConsent: false, purgedAt: state.purgedAt });
    assert(state.purgedAt >= deadlines.retainUntil);
    return state;
  });
  await run('post-retention HTTP reads and writes are denied', async () => {
    await assert.rejects(operator.query(ref('research:sessionSources'), { clientId, projectId, sessionId: invitation.sessionId, paginationOpts: { cursor: null, numItems: 25 } }));
    await assert.rejects(guest.mutation(ref('participant:correct'), { token, expectedRevision: 3, requestId: `late-${id}`, sourceId: original.sourceId, text: 'Must never save.' }));
  });
  await operator.action(ref('auth:signOut'), {});
  receipt.state = 'passed';
} catch (error) {
  receipt.state = 'failed'; receipt.failure = { phase, name: error.name, ...(error.message === 'Subscription failed for a non-lifecycle reason' ? { reason: 'unexpected-subscription-error' } : {}) }; process.exitCode = 1;
} finally {
  for (const client of clients) await client.close();
  if (receipt.state === 'failed' && receipt.sessionId) {
    try { receipt.postFailureLifecycleState = await admin.query(ref('lifecycleQualification:inspect'), { sessionId: receipt.sessionId, invitationId: receipt.invitationId }); } catch { /* Retain original failure without exposing provider error text. */ }
  }
  try { await setFixture(false); receipt.fixtureDisabledAfterRun = true; } catch { receipt.fixtureDisabledAfterRun = false; receipt.state = 'failed'; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  const output = new URL(`../../docs/implementation/evidence/research-lifecycle-${id}.json`, import.meta.url);
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ state: receipt.state, checks: checks.length, failure: receipt.failure, evidence: output.pathname, fixtureDisabledAfterRun: receipt.fixtureDisabledAfterRun }));
}
