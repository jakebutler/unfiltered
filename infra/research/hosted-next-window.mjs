/** Exact-target, read-only preflight. Import and source checks make zero cloud calls. */
import { createHash } from 'node:crypto';
import { open, writeFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import dotenv from 'dotenv';
import { boundedFetch } from './setup-cloud.mjs';

export const BASE = Object.freeze({ deploymentId: 'dpl_7oDJbkUfPheAf55UDV2iY9hx93U2', origin: 'https://corvo-research-demo.vercel.app', nativeSourceSha256: 'bbddf43098d5a17791c475c02634ba373b3e878baaef4d03688137cc7f76e266', speechDefinitionSha256: '8f6290e0fe458e26400afa90fc088deadb179da1495ae020c4d6511858ec12a4', target: 'https://elegant-crane-662.convex.cloud' });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(root, 'infra/cloud/.private/research-next-window-20261010');
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const fail = () => { throw Error('Research eligibility unavailable; inspect retained private observation'); };
export function validateInput(input, now = Date.now()) {
  if (input?.schema !== 1 || !isDeepStrictEqual(input.baseline, BASE) || !identifier(input.receiptName) || !identifier(input.newGrantName) || !identifier(input.sessionId) || !identifier(input.studyId) || !identifier(input.ownerId) || !identifier(input.question?.id) || typeof input.question.text !== 'string' || input.question.text.length < 1 || input.question.text.length > 1200 || !Number.isSafeInteger(input.sessionRevision) || input.sessionRevision < 0 || typeof input.participantPath !== 'string') fail();
  if (!Number.isSafeInteger(input.liveBaseline?.at) || now - input.liveBaseline.at < 0 || now - input.liveBaseline.at > 300_000 || input.liveBaseline.providersOff !== true || !isDeepStrictEqual(input.liveBaseline.identity, BASE)) fail();
  if (input.newGrantName.startsWith('study-') || ['research-hosted-stt-diagnostic-a3', 'research-hosted-stt-diagnostic-a2', 'research-hosted-e2e-speech-a1'].includes(input.newGrantName)) fail();
  return input;
}
async function privateText(path, max = 65_536) {
  const absolute = resolve(root, path); if (!absolute.startsWith(join(root, 'infra') + '/')) fail();
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await handle.stat(); if (!s.isFile() || s.mode & 0o077 || s.size > max) fail(); return await handle.readFile('utf8'); } finally { await handle.close(); }
}
async function admin() {
  const env = dotenv.parse(await privateText('infra/research/.env.cloud-bootstrap/push-exact.cloud.env'));
  if (env.CONVEX_SELF_HOSTED_URL !== BASE.target || !env.CONVEX_SELF_HOSTED_ADMIN_KEY || Object.keys(env).length !== 2) fail();
  const client = new ConvexHttpClient(BASE.target, { logger: false, fetch: (i, n) => boundedFetch(fetch, BASE.target, i, n) }); client.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY); return client;
}
const query = (client, name, args) => client.query(ref(name), args);
/** Bounded full-table pages are used only to prove absence. Incomplete inventory fails closed. */
async function table(client, name) {
  const result = await query(client, '_system/cli/tableData', { table: name, order: 'asc', paginationOpts: { cursor: null, numItems: 32 } });
  if (!Array.isArray(result?.page) || result.page.length > 32 || result.isDone !== true) fail(); return result.page;
}
export function assess(input, o) {
  const session = o.session, reasons = [];
  if (session.sessionId !== input.sessionId || session.welcome?.scope?.studyId !== input.studyId || session.welcome?.purpose !== 'participant' || session.state !== 'active' || session.revision !== input.sessionRevision || session.question?.id !== input.question.id || session.question?.question !== input.question.text || session.questionCount !== 1 || session.pendingInterview || session.consent?.microphone !== true || session.consent?.storage !== true || session.consent?.analysis !== true) reasons.push('participant-question-consent-diff');
  if (o.admissions.some(row => row.studyId === input.studyId)) reasons.push('ordinary-study-admission-present');
  if (o.envelopes.some(row => row.ownerId === input.ownerId && row.enabled)) reasons.push('owner-enabled-envelope-present');
  if (o.grants.some(row => row.studyId === input.studyId && row.enabled && row.expiresAt > o.at)) reasons.push('existing-study-grant-active');
  if (o.prospective.grant !== null) reasons.push('prospective-grant-name-exists');
  const sessionRow = o.sessions.find(row => row._id === input.sessionId);
  if (!sessionRow || sessionRow.ownerId !== input.ownerId || sessionRow.studyId !== input.studyId || sessionRow.purpose !== undefined || sessionRow.revision !== session.revision) reasons.push('native-session-owner-diff');
  const g = o.oldA3.grant;
  if (g?.studyId !== input.studyId || g?.enabled !== false || g?.chargedSeconds !== 60 || g?.chargedCharacters !== 17 || o.oldA3.sessions.length !== 1 || o.oldA3.sessions[0].truncated) reasons.push('historical-A3-diff');
  const retained = o.oldA3.sessions[0]?.attempts ?? [];
  if (!retained.some(a => a.requestId === '0e42401b-237e-4a7f-9606-dc6dc34a9a1e' && a.provider === 'deepgram' && a.state === 'unknown' && a.reservedSeconds === 60) || !retained.some(a => a.requestId === '0add2ffb-2809-4977-8669-b943f22579b6' && a.provider === 'elevenlabs' && a.state === 'completed' && a.reservedCharacters === 17)) reasons.push('historical-attempts-diff');
  for (const a of o.attempts.filter(a => a.active)) {
    const identity = a.transportLease;
    const slot = identity && o.gateway.slots.find(row => row.lease.leaseId === identity.leaseId);
    const settled = slot && (slot.lease.generation > identity.generation || slot.lease.generation === identity.generation && slot.lease.requestId === identity.requestId && slot.lease.owner === identity.owner && slot.workStarted === false && slot.lease.expiresAt === 0);
    if (!settled || !['unknown', 'interrupted'].includes(a.state)) reasons.push('historical-active-transport-unresolved');
  }
  if (retained.some(a => a.active && !o.attempts.some(row => row.requestId === a.requestId))) reasons.push('historical-native-attempt-missing');
  if (o.gateway.slots.some(slot => slot.workStarted)) reasons.push('gateway-work-active');
  return { eligible: reasons.length === 0, reasons };
}
export async function preflight(path) {
  const inputBytes = await privateText(path), input = validateInput(JSON.parse(inputBytes));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Exclusive intent is created before credential reads or any remote query.
  const prefix = join(directory, input.receiptName);
  await writeFile(prefix + '.intent.private.json', JSON.stringify({ at: Date.now(), inputSha256: sha(inputBytes), baseline: BASE, mode: 'read-only', maximumRequests: 10, mutations: 0, providerCalls: 0 }) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    const client = await admin(), participant = JSON.parse(await privateText(input.participantPath));
    if (!/^[a-f0-9]{64}$/.test(participant.token ?? '')) fail();
    const anon = new ConvexHttpClient(BASE.target, { logger: false, fetch: (i, n) => boundedFetch(fetch, BASE.target, i, n) });
    // Sequential, ten bounded queries maximum; no retries and no historical helpers.
    const o = { at: Date.now(), session: await query(anon, 'participant:resume', { token: participant.token }), admissions: await table(client, 'researchStudyAdmission'), envelopes: await table(client, 'researchReadinessEnvelopes'), grants: await table(client, 'researchSpeechGrants'), sessions: await table(client, 'researchSessions'), attempts: await table(client, 'researchSpeechAttempts'), prospective: await query(client, 'researchSpeechGrants:readiness', { name: input.newGrantName, sessionIds: [] }), oldA3: await query(client, 'researchSpeechGrants:readiness', { name: 'research-hosted-stt-diagnostic-a3', sessionIds: [input.sessionId] }), gateway: await query(client, 'researchGatewayLeases:readiness', { allocationId: 'research-cloud-20261010-e2e-cont-a1' }), allocationBinding: await query(client, '_system/cli/queryEnvironmentVariables:get', { name: 'RESEARCH_HOSTED_GATEWAY_ALLOCATION' }) };
    const decision = assess(input, o);
    await writeFile(prefix + '.receipt.private.json', JSON.stringify({ schema: 1, inputSha256: sha(inputBytes), ...decision, observation: o, mutations: 0, providerCalls: 0 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { state: decision.eligible ? 'isolated-fixture-eligible-no-activation' : 'ineligible-stop', reasons: decision.reasons, sessionId: input.sessionId, revision: o.session.revision, questionCharacters: o.session.question?.question.length ?? 0, oldChargedSeconds: o.oldA3.grant?.chargedSeconds, oldChargedCharacters: o.oldA3.grant?.chargedCharacters, receipt: prefix + '.receipt.private.json', mutations: 0, providerCalls: 0 };
  } catch {
    await writeFile(prefix + '.unknown.private.json', JSON.stringify({ at: Date.now(), state: 'bounded-readback-unresolved', mutations: 0, providerCalls: 0 }) + '\n', { flag: 'wx', mode: 0o600 }); throw Error('Read-only preflight incomplete; retain original intent and do not infer eligibility');
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { if (process.argv.length !== 4 || process.argv[2] !== 'preflight') fail(); const receipt = await preflight(process.argv[3]); console.log(JSON.stringify(receipt)); if (receipt.state !== 'isolated-fixture-eligible-no-activation') process.exitCode = 1; }
  catch { console.error('Research read-only preflight stopped. Keep original private intent; no automatic retry.'); process.exitCode = 1; }
}
