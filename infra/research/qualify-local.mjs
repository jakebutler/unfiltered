import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { localConfig } from './setup-local.mjs';

const env = await localConfig();
const secrets = JSON.parse(await readFile(new URL('./operator.private.json', import.meta.url), 'utf8'));
const guest = new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false });
const operator = new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false });
const id = randomUUID(), checks = [];
const receipt = { id, startedAt: new Date().toISOString(), scope: 'isolated-self-hosted-convex', url: env.CONVEX_SELF_HOSTED_URL, checks, cloudMutations: 0, providerCalls: 0, cash: 0 };
const run = async (name, fn) => { await fn(); checks.push({ name, passed: true }); };
const paginationOpts = { numItems: 2, cursor: null };
const definition = { title: 'Fictional checkout study', introduction: 'Synthetic qualification only.', goals: ['Understand checkout expectations'], script: [{ id: 'expectation', question: 'What do you expect here?' }, { id: 'confusion', question: 'What was confusing?' }], prototypeUrl: 'https://example.com/prototype', repository: null };
const consent = { version: 'research-consent-1', storage: true, analysis: true, microphone: false, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
try {
  await run('anonymous operator access denied', () => assert.rejects(guest.query(ref('research:clients'), { paginationOpts })));
  await run('closed public enrollment', () => assert.rejects(guest.action(ref('auth:signIn'), { provider: 'password', params: { flow: 'signUp', email: 'intruder@example.test', password: 'not-a-real-secret-qualification-only' } })));
  await run('wrong password denied', () => assert.rejects(guest.action(ref('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: secrets.email, password: 'not-the-operator-password' } })));
  const signed = await guest.action(ref('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: secrets.email, password: secrets.password } });
  assert(signed.tokens?.token); operator.setAuth(signed.tokens.token);
  await run('native password token resolves named operator', async () => assert.equal((await operator.query(ref('research:me'), {})).name, secrets.name));
  const clientId = await operator.mutation(ref('research:createClient'), { name: `Synthetic A ${id}` });
  const clientB = await operator.mutation(ref('research:createClient'), { name: `Synthetic B ${id}` });
  const projectId = await operator.mutation(ref('research:createProject'), { clientId, name: 'Checkout' });
  await operator.mutation(ref('research:saveStudy'), { clientId, projectId, expectedRevision: 0, definition });
  await run('cross-client study identifiers denied', () => assert.rejects(operator.query(ref('research:readStudy'), { clientId: clientB, projectId, version: 1 })));
  const invite = await operator.action(ref('invitations:create'), { clientId, projectId, studyVersion: 1, requestId: `invite-${id}` });
  assert(invite.token); const token = invite.token;
  await run('duplicate invite cannot create another session or recover plaintext', async () => {
    const duplicate = await operator.action(ref('invitations:create'), { clientId, projectId, studyVersion: 1, requestId: `invite-${id}` });
    assert.equal(duplicate.sessionId, invite.sessionId); assert.equal(duplicate.token, null);
  });
  await operator.mutation(ref('research:saveStudy'), { clientId, projectId, expectedRevision: 1, definition: { ...definition, title: 'Version two' } });
  await run('issued session retains original immutable study', async () => assert.equal((await guest.query(ref('participant:resume'), { token })).title, definition.title));
  await run('consent is required before accepting answers', () => assert.rejects(guest.mutation(ref('participant:answer'), { token, expectedRevision: 0, requestId: 'answer-before-consent', questionId: 'expectation', text: 'This must not be saved', channel: 'text' })));
  await guest.mutation(ref('participant:agree'), { token, expectedRevision: 0, consent });
  const answer = { token, expectedRevision: 1, requestId: `answer-${id}`, questionId: 'expectation', text: '  I expected delivery options.\n', channel: 'text' };
  const first = await guest.mutation(ref('participant:answer'), answer);
  await run('lost acknowledgement replay preserves one immutable source', async () => assert.deepEqual(await guest.mutation(ref('participant:answer'), answer), first));
  await run('reused request cannot overwrite prior source', () => assert.rejects(guest.mutation(ref('participant:answer'), { ...answer, text: 'Malicious replacement' })));
  await run('stale revision cannot advance interview', () => assert.rejects(guest.mutation(ref('participant:answer'), { ...answer, requestId: `stale-${id}`, questionId: 'confusion' })));
  const correction = await guest.mutation(ref('participant:correct'), { token, expectedRevision: 2, requestId: `correct-${id}`, sourceId: first.sourceId, text: 'I expected delivery dates, specifically.' });
  await run('source pages are bounded and correction retains original text', async () => {
    const firstPage = await guest.query(ref('participant:sources'), { token, paginationOpts });
    assert.equal(firstPage.page.length, 2); assert.equal(firstPage.isDone, false); assert.equal(firstPage.page[1].text, answer.text);
    const nextPage = await guest.query(ref('participant:sources'), { token, paginationOpts: { ...paginationOpts, cursor: firstPage.continueCursor } });
    assert(nextPage.page.some(source => source.sourceId === correction.sourceId && source.supersedes === first.sourceId));
  });
  await guest.mutation(ref('participant:transition'), { token, expectedRevision: 3, state: 'paused' });
  const reconnected = new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false });
  await run('new client resumes durable paused session and next question', async () => {
    const current = await reconnected.query(ref('participant:resume'), { token }); assert.equal(current.state, 'paused'); assert.equal(current.question.id, 'confusion');
  });
  await guest.mutation(ref('participant:transition'), { token, expectedRevision: 4, state: 'active' });
  await guest.mutation(ref('participant:answer'), { token, expectedRevision: 5, requestId: `answer2-${id}`, questionId: 'confusion', text: 'The shipping cost appeared late.', channel: 'text' });
  await guest.mutation(ref('participant:transition'), { token, expectedRevision: 6, state: 'completed' });
  await run('completed session has readable operator sources', async () => {
    const state = await guest.query(ref('participant:resume'), { token }); assert.equal(state.state, 'completed');
    const sources = await operator.query(ref('research:sessionSources'), { clientId, projectId, sessionId: invite.sessionId, paginationOpts: { cursor: null, numItems: 25 } }); assert.equal(sources.page.length, 5);
  });
  await run('wrong client cannot read a completed source', () => assert.rejects(operator.query(ref('research:sessionSources'), { clientId: clientB, projectId, sessionId: invite.sessionId, paginationOpts })));
  await operator.mutation(ref('invitations:revoke'), { clientId, projectId, invitationId: invite.invitationId });
  await run('revocation terminates capability read and mutation', async () => {
    await assert.rejects(guest.query(ref('participant:resume'), { token }));
    await assert.rejects(guest.mutation(ref('participant:correct'), { token, expectedRevision: 7, requestId: `revoked-${id}`, sourceId: first.sourceId, text: 'Must not save' }));
  });
  const raceInvite = await operator.action(ref('invitations:create'), { clientId, projectId, studyVersion: 1, requestId: `race-${id}` });
  await guest.mutation(ref('participant:agree'), { token: raceInvite.token, expectedRevision: 0, consent });
  await run('concurrent different answers admit exactly one revision', async () => {
    const raced = await Promise.allSettled(['A', 'B'].map(label => guest.mutation(ref('participant:answer'), { token: raceInvite.token, expectedRevision: 1, requestId: `race-${label}-${id}`, questionId: 'expectation', text: `Answer ${label}`, channel: 'text' })));
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(raced.filter(r => r.status === 'rejected').length, 1);
    const current = await guest.query(ref('participant:resume'), { token: raceInvite.token }); assert.equal(current.revision, 2); assert.equal(current.question.id, 'confusion');
  });
  await run('concurrent exact replay returns the same receipt', async () => {
    const same = { token: raceInvite.token, expectedRevision: 2, requestId: `race-same-${id}`, questionId: 'confusion', text: 'Identical concurrent answer', channel: 'text' };
    const [a, b] = await Promise.all([guest.mutation(ref('participant:answer'), same), guest.mutation(ref('participant:answer'), same)]); assert.deepEqual(a, b);
  });
  await operator.mutation(ref('invitations:revoke'), { clientId, projectId, invitationId: raceInvite.invitationId });
  await operator.action(ref('auth:signOut'), {});
  await run('sign out immediately revokes old access token at domain boundary', () => assert.rejects(operator.query(ref('research:me'), {})));
  receipt.state = 'passed'; receipt.clientId = clientId; receipt.projectId = projectId; receipt.sessionId = invite.sessionId; receipt.sourceId = first.sourceId;
} catch (error) {
  receipt.state = 'failed'; receipt.failure = { name: error.name, message: String(error.message).replaceAll(secrets.password, '[redacted]').slice(0, 1200) };
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  const directory = new URL('../../docs/implementation/evidence/', import.meta.url); await mkdir(directory, { recursive: true });
  const output = new URL(`research-${id}.json`, directory); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ state: receipt.state, passedChecks: checks.length, evidence: output.pathname, failure: receipt.failure }));
}
