/** Explicit root-owned local fixture administration; never run by application startup. */
import { lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { localConfig } from './setup-local.mjs';
import { privateJson } from '../../apps/research-server/src/private-json.mjs';

export const continuousFixtureGrant = Object.freeze({ allocatedSeconds: 180, allocatedCharacters: 600, maxSessionSeconds: 180, maxSessionCharacters: 600 });
async function absent(path) { try { await lstat(path); throw new Error('Fixture output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function privateDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Fixture directory must be mode0700'); }
async function replacePrivate(path, value) { const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
function checkCheckpoint(value) {
  if (!value || value.mode !== 'local-synthetic-continuous-voice' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.grantName ?? '') || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.allocationId) || !Array.isArray(value.sessions) || value.sessions.length !== 1 || value.sessions.some(s => typeof s.sessionId !== 'string' || typeof s.tokenPath !== 'string')) throw new Error('Invalid retained fixture checkpoint');
  return value;
}
export function boundedLocalFixtureFetch(nativeFetch) {
  return (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== 'http://127.0.0.1:3210') throw new Error('Non-local voice fixture transport forbidden');
    return nativeFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]) });
  };
}
export async function runContinuousVoiceFixture(mode, options, injected = {}) {
  if (!['prepare', 'readback', 'disable'].includes(mode) || options.allow !== true || !options.output || !/^[a-zA-Z0-9_-]{8,128}$/.test(options.grantName ?? '')) throw new Error('Explicit local synthetic voice action and output required');
  const output = resolve(options.output); if (mode === 'prepare') await absent(output);
  const env = await (injected.localConfig ?? localConfig)();
  if (env.CONVEX_SELF_HOSTED_URL !== 'http://127.0.0.1:3210' || !env.CONVEX_SELF_HOSTED_ADMIN_KEY) throw new Error('Only exact isolated localhost authority is allowed');
  const nativeFetch = injected.fetch ?? fetch;
  const boundedFetch = boundedLocalFixtureFetch(nativeFetch);
  const client = injected.client ?? (() => new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false, fetch: boundedFetch }));
  const admin = client(); admin.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  const credentials = await (injected.privateJson ?? privateJson)(resolve(options.operator ?? fileURLToPath(new URL('./operator.private.json', import.meta.url))));
  if (!credentials || typeof credentials.email !== 'string' || typeof credentials.password !== 'string') throw new Error('Private normal operator credentials required');
  const operator = client(); let signedIn = false;
  let checkpoint, phase = 'preflight';
  try {
    if (mode === 'prepare') {
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(options.allocationId ?? '')) throw new Error('Explicit prospective allocation identifier required');
      const prior = await admin.query(ref('researchSpeechGrants:readiness'), { name: options.grantName, sessionIds: [] }); if (prior.grant !== null) throw new Error('Existing named speech grant cannot be reset');
      const gateway = await admin.query(ref('researchGatewayLeases:readiness'), { allocationId: options.allocationId }); if (gateway.allocation !== null) throw new Error('Existing native allocation cannot be reset');
      await privateDirectory(dirname(output));
      checkpoint = { mode: 'local-synthetic-continuous-voice', state: 'preparing', id: randomUUID(), grantName: options.grantName, allocationId: options.allocationId, createdAt: Date.now(), providerCalls: 0, cloudCalls: 0, sessions: [] };
      await writeFile(output, JSON.stringify(checkpoint, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } else { checkpoint = checkCheckpoint(await (injected.privateJson ?? privateJson)(output)); if (checkpoint.grantName !== options.grantName) throw new Error('Named grant does not match retained checkpoint'); }
    phase = 'normal operator authentication';
    const login = await operator.action(ref('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: credentials.email, password: credentials.password } });
    if (!login.tokens?.token) throw new Error('Normal operator authentication failed'); operator.setAuth(login.tokens.token); signedIn = true;
    if (mode === 'prepare') {
      phase = 'create synthetic study';
      const clientId = await operator.mutation(ref('research:createClient'), { name: `Synthetic continuous voice ${checkpoint.id}` });
      const projectId = await operator.mutation(ref('research:createProject'), { clientId, name: 'Synthetic continuous conversation acceptance' }); checkpoint.scope = { clientId, projectId };
      const study = await operator.mutation(ref('research:saveStudy'), { ...checkpoint.scope, expectedRevision: 0, definition: { title: 'Synthetic continuous voice fixture', introduction: 'Fixed synthetic tone and transcript. No real microphone or provider.', goals: ['Verify three automatic spoken turns and exact final wording review'], script: [{ id: 'q1', question: 'What did you expect after checkout?' }, { id: 'q2', question: 'What would make the receipt clearer?' }, { id: 'q3', question: 'What should happen next?' }], prototypeUrl: null, repository: null } });
      if (!study?.studyId) throw new Error('Study acknowledgement is ambiguous; no replay'); checkpoint.studyId = study.studyId; await replacePrivate(output, checkpoint);
      for (let i = 0; i < 1; i++) {
        phase = `issue synthetic invitation ${i + 1}`;
        const invitation = await operator.action(ref('invitations:create'), { ...checkpoint.scope, studyVersion: 1, requestId: `continuous-voice-${checkpoint.id}-${i}` }); if (!invitation.token) throw new Error('Invitation acknowledgement is ambiguous; no replay');
        const tokenPath = join(dirname(output), `continuous-voice-${checkpoint.id}-${i + 1}.private.json`);
        await writeFile(tokenPath, JSON.stringify({ token: invitation.token, url: `http://127.0.0.1:5174/participate/synthetic-voice#token=${invitation.token}` }) + '\n', { mode: 0o600, flag: 'wx' });
        checkpoint.sessions.push({ sessionId: invitation.sessionId, invitationId: invitation.invitationId, tokenPath }); await replacePrivate(output, checkpoint);
      }
      phase = 'prospective named study speech grant'; checkpoint.grantId = await admin.mutation(ref('researchSpeechGrants:provision'), { name: checkpoint.grantName, studyId: checkpoint.studyId, enabled: true, ...continuousFixtureGrant, expiresAt: Date.now() + 30 * 60_000 }); await replacePrivate(output, checkpoint);
      phase = 'prospective native allocation'; await admin.mutation(ref('researchGatewayLeases:provisionAllocation'), { allocationId: checkpoint.allocationId, expiresAt: Date.now() + 30 * 60_000, requestLimit: 36, readByteLimit: 1, storageOperationLimit: 1 });
      checkpoint.state = 'ready';
    }
    if (mode === 'disable') { phase = 'disable future admission'; await admin.mutation(ref('researchSpeechGrants:disable'), { name: checkpoint.grantName }); checkpoint.state = 'disabled'; }
    phase = 'bounded native readback';
    checkpoint.speech = await admin.query(ref('researchSpeechGrants:readiness'), { name: checkpoint.grantName, sessionIds: checkpoint.sessions.map(s => s.sessionId) });
    checkpoint.gateway = await admin.query(ref('researchGatewayLeases:readiness'), { allocationId: checkpoint.allocationId });
    checkpoint.sourceReadback = [];
    for (const session of checkpoint.sessions) {
      const access = await (injected.privateJson ?? privateJson)(session.tokenPath);
      const guest = client();
      const resumed = await guest.query(ref('participant:resume'), { token: access.token });
      const review = resumed.consent ? await guest.query(ref('participant:reviewSnapshot'), { token: access.token }) : null;
      const sources = await operator.query(ref('research:sessionSources'), { ...checkpoint.scope, sessionId: session.sessionId, paginationOpts: { numItems: 25, cursor: null } });
      checkpoint.sourceReadback.push({ sessionId: session.sessionId, state: resumed.state, revision: resumed.revision, questionId: resumed.question?.id ?? null, review, sources: sources.page.filter(s => ['unreviewed-transcript', 'spoken-answer', 'confirmed-transcript', 'text'].includes(s.channel)).map(s => ({ sourceId: s.sourceId, questionId: s.questionId, channel: s.channel, text: s.text, supersedes: s.supersedes })), truncated: !sources.isDone });
    }
    checkpoint.phase = 'complete'; checkpoint.checkedAt = Date.now(); await replacePrivate(output, checkpoint);
    return { state: checkpoint.state, output, tokenPaths: checkpoint.sessions.map(s => s.tokenPath) };
  } catch (error) {
    if (checkpoint) { checkpoint.state = 'incomplete'; checkpoint.phase = phase; checkpoint.checkedAt = Date.now(); await replacePrivate(output, checkpoint); }
    throw error;
  } finally {
    if (signedIn) {
      let operatorSignedOut = false;
      try { await operator.action(ref('auth:signOut'), {}); operatorSignedOut = true; } catch { /* Never replay an uncertain signed action. */ }
      if (checkpoint) { checkpoint.operatorSignedOut = operatorSignedOut; await replacePrivate(output, checkpoint); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  try {
    const result = await runContinuousVoiceFixture(process.argv[2], { allow: process.argv.includes('--allow-local-synthetic-continuous-voice'), output: value('--output'), allocationId: value('--allocation'), grantName: value('--grant'), operator: value('--operator') });
    console.log(`Local synthetic continuous voice fixture ${result.state}; private receipt and invitations saved. No provider calls.`);
  } catch { console.error('Local synthetic continuous voice fixture action failed; inspect its private checkpoint before retrying. No action was replayed.'); process.exitCode = 1; }
}
