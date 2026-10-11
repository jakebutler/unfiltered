/** Root-owned local administration. Importing this module performs no actions. */
import { lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { localConfig } from './setup-local.mjs';
import { privateJson } from '../../apps/research-server/src/private-json.mjs';
import { boundedLocalFixtureFetch } from './continuous-voice-fixture.mjs';

export const goalFixturePolicy = Object.freeze({ enabled: true, allocatedCalls: 2, maxSessionCalls: 1, model: 'qwen3.8-max', maxInputBytes: 64_000, maxOutputTokens: 512 });
export const goalFixtureStudy = Object.freeze({ title: 'Synthetic goal-aware checkout interview', introduction: 'Synthetic typed answers and a deterministic clarification. No live model or voice provider.', goals: ['Understand whether people can find the delivery cost before confirming checkout.'], script: [{ id: 'q1', question: 'What did you notice about the delivery cost during checkout?' }, { id: 'q2', question: 'What would make the checkout clearer?' }], prototypeUrl: null, repository: null });
export const goalFixtureAnswer = 'I could not find the delivery cost before confirming checkout.';
async function absent(path) { try { await lstat(path); throw new Error('Fixture output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function directory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o077) throw new Error('Fixture directory must be private'); }
async function replace(path, value) { const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
function retained(value) {
  if (!value || value.mode !== 'local-deterministic-goal-interview' || typeof value.id !== 'string' || !Array.isArray(value.sessions) || value.sessions.length !== 1 || value.sessions.some(s => s.kind !== 'deterministic' || typeof s.sessionId !== 'string' || typeof s.tokenPath !== 'string') || !value.scope || typeof value.studyId !== 'string') throw new Error('Invalid retained goal fixture');
  return value;
}
function policyMatches(p) { return p && p.qualification === 'root-reviewed-research-interview' && Object.entries(goalFixturePolicy).every(([k, value]) => k === 'enabled' || p[k] === value); }
export async function runGoalInterviewFixture(mode, options, injected = {}) {
  if (!['prepare', 'readback', 'disable'].includes(mode) || options.allow !== true || !options.output) throw new Error('Explicit local goal fixture action and private output required');
  const output = resolve(options.output); if (mode === 'prepare') await absent(output);
  const env = await (injected.localConfig ?? localConfig)();
  if (env.CONVEX_SELF_HOSTED_URL !== 'http://127.0.0.1:3210' || !env.CONVEX_SELF_HOSTED_ADMIN_KEY) throw new Error('Exact local native authority required');
  const client = injected.client ?? (() => new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false, fetch: boundedLocalFixtureFetch(injected.fetch ?? fetch) }));
  const admin = client(); admin.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  const credentials = await (injected.privateJson ?? privateJson)(resolve(options.operator ?? fileURLToPath(new URL('./operator.private.json', import.meta.url))));
  if (!credentials || typeof credentials.email !== 'string' || typeof credentials.password !== 'string') throw new Error('Private normal operator credentials required');
  const operator = client(); let signedIn = false, checkpoint, phase = 'preflight';
  try {
    const prior = await admin.query(ref('researchInterviewFixture:readiness'), { sessionIds: [] });
    if (mode === 'prepare') {
      if (prior.policy !== null || prior.hasPriorEvidence || prior.activeAttempts || prior.activeTruncated) throw new Error('Existing interview policy or evidence cannot be replaced');
      await directory(dirname(output));
      checkpoint = { mode: 'local-deterministic-goal-interview', state: 'preparing', id: randomUUID(), createdAt: Date.now(), sessions: [], liveProviderCalls: 0, liveSessionAuthorized: false, policy: { ...goalFixturePolicy, expiresAt: Date.now() + 24 * 60 * 60_000 }, expectedFirstAnswer: goalFixtureAnswer, expectedSyntheticReply: { decision: 'follow-up', question: 'Where did you look for the delivery cost before confirming checkout?', goalIndex: 0, quote: 'delivery cost', sourceBinding: 'exact first accepted answer source ID' } };
      await writeFile(output, JSON.stringify(checkpoint, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } else {
      checkpoint = retained(await (injected.privateJson ?? privateJson)(output));
      if (!policyMatches(prior.policy) || prior.policy.expiresAt !== checkpoint.policy.expiresAt) throw new Error('Existing policy differs from retained fixture; inspect without replacement');
    }
    phase = 'normal operator authentication';
    const login = await operator.action(ref('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: credentials.email, password: credentials.password } });
    if (!login.tokens?.token) throw new Error('Operator authentication failed'); operator.setAuth(login.tokens.token); signedIn = true;
    if (mode === 'prepare') {
      phase = 'create synthetic study';
      const clientId = await operator.mutation(ref('research:createClient'), { name: `Goal fixture ${checkpoint.id}` });
      const projectId = await operator.mutation(ref('research:createProject'), { clientId, name: 'Goal-aware checkout acceptance' }); checkpoint.scope = { clientId, projectId };
      const study = await operator.mutation(ref('research:saveStudy'), { ...checkpoint.scope, expectedRevision: 0, definition: goalFixtureStudy });
      if (!study?.studyId) throw new Error('Ambiguous study acknowledgement; no replay'); checkpoint.studyId = study.studyId; checkpoint.studyDefinition = goalFixtureStudy; await replace(output, checkpoint);
      phase = 'create deterministic invitation';
      const invitation = await operator.action(ref('invitations:create'), { ...checkpoint.scope, studyVersion: 1, requestId: `goal-fixture-${checkpoint.id}` });
      if (!invitation.token || !invitation.sessionId) throw new Error('Ambiguous invitation acknowledgement; no replay');
      const tokenPath = join(dirname(output), `goal-${checkpoint.id}-deterministic.private.json`);
      await writeFile(tokenPath, JSON.stringify({ token: invitation.token, url: `http://127.0.0.1:5174/participate#token=${invitation.token}` }) + '\n', { mode: 0o600, flag: 'wx' });
      checkpoint.sessions.push({ kind: 'deterministic', sessionId: invitation.sessionId, invitationId: invitation.invitationId, tokenPath }); await replace(output, checkpoint);
      phase = 'immutable prospective interview policy';
      await admin.mutation(ref('researchInterview:provision'), checkpoint.policy); checkpoint.state = 'ready';
    }
    if (mode === 'disable') { phase = 'disable future admission'; await admin.mutation(ref('researchInterviewFixture:disable'), {}); checkpoint.state = 'disabled'; }
    phase = 'bounded native readback';
    checkpoint.native = await admin.query(ref('researchInterviewFixture:readiness'), { sessionIds: checkpoint.sessions.map(s => s.sessionId) });
    if (!policyMatches(checkpoint.native.policy) || checkpoint.native.policy.expiresAt !== checkpoint.policy.expiresAt) throw new Error('Prospective policy readback mismatch');
    checkpoint.syntheticOriginalReplies = [];
    for (const session of checkpoint.native.sessions) for (const attempt of session.attempts) {
      if (attempt.receipt?.requestId !== `synthetic-goal-${session.sessionId}`) continue;
      const reply = { decision: 'follow-up', question: checkpoint.expectedSyntheticReply.question, goalIndex: 0, sourceId: attempt.answerSourceId, quote: 'delivery cost' };
      const text = JSON.stringify(reply), outputHash = createHash('sha256').update(text).digest('hex');
      if (attempt.outputHash !== outputHash) throw new Error('Retained synthetic reply hash mismatch');
      checkpoint.syntheticOriginalReplies.push({ sessionId: session.sessionId, requestId: attempt.requestId, providerRequestId: attempt.receipt.requestId, text, outputHash });
    }
    checkpoint.sourceReadback = [];
    for (const session of checkpoint.sessions) {
      const access = await (injected.privateJson ?? privateJson)(session.tokenPath), guest = client();
      const resumed = await guest.query(ref('participant:resume'), { token: access.token });
      const sources = await operator.query(ref('research:sessionSources'), { ...checkpoint.scope, sessionId: session.sessionId, paginationOpts: { numItems: 25, cursor: null } });
      checkpoint.sourceReadback.push({ sessionId: session.sessionId, state: resumed.state, revision: resumed.revision, question: resumed.question, pendingInterview: resumed.pendingInterview, sources: sources.page.map(s => ({ sourceId: s.sourceId, questionId: s.questionId, author: s.author, channel: s.channel, text: s.text, supersedes: s.supersedes })), truncated: !sources.isDone });
    }
    checkpoint.checkedAt = Date.now(); checkpoint.phase = 'complete'; await replace(output, checkpoint);
    return { state: checkpoint.state, output, receiptHash: createHash('sha256').update(JSON.stringify({ native: checkpoint.native, sourceReadback: checkpoint.sourceReadback })).digest('hex') };
  } catch (error) {
    if (checkpoint) { checkpoint.state = 'incomplete'; checkpoint.phase = phase; checkpoint.checkedAt = Date.now(); await replace(output, checkpoint); }
    throw error;
  } finally {
    if (signedIn) {
      let operatorSignedOut = false; try { await operator.action(ref('auth:signOut'), {}); operatorSignedOut = true; } catch { /* Never replay an uncertain action. */ }
      if (checkpoint) { checkpoint.operatorSignedOut = operatorSignedOut; await replace(output, checkpoint); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  try {
    const result = await runGoalInterviewFixture(process.argv[2], { allow: process.argv.includes('--allow-local-deterministic-goal-interview'), output: value('--output'), operator: value('--operator') });
    console.log(`Local deterministic goal fixture ${result.state}; receipt SHA256 ${result.receiptHash}. Private invitation retained. Administration action made no provider calls.`);
  } catch { console.error('Goal fixture action failed; inspect the private checkpoint before retrying. No uncertain action was replayed.'); process.exitCode = 1; }
}
