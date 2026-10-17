/** Local root probe only. No app startup hook, policy provisioning or live fallback. */
import { constants } from 'node:fs';
import { open, lstat, writeFile, rename, appendFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { privateJson } from './private-json.mjs';
import { convexInterviewAuthority } from './interview-authority';
import { digitalOceanInterview, interviewMessages, runInterviewTurn, type InterviewScope } from './interview';
import { prepareDigitalOceanRequest, DO_ENDPOINT } from '../../../packages/clinical-core/src/digitalocean';
import { canonical } from '../../../packages/research-capture/src/proof';

export const liveGoalLimits = Object.freeze({ model: 'qwen3.8-max' as const, timeoutMs: 15_000, maxOutputTokens: 512, maxRequestBytes: 64_000 });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const scopeSchema = z.object({ sessionId: z.string(), promptId: z.string(), expectedRevision: z.number().int(), answerSourceId: z.string(), requestId: z.string() });
const checkpointSchema = z.object({ mode: z.literal('local-live-goal-interview'), id: z.string(), state: z.enum(['preparing', 'staged', 'previewed', 'dispatch-intent', 'readback', 'incomplete']), baseline: z.string(), tokenPath: z.string().optional(), sessionId: z.string().optional(), scope: scopeSchema.optional(), preview: z.object({ requestPath: z.string(), inputHash: z.string(), requestBytes: z.number(), contextHash: z.string(), model: z.literal('qwen3.8-max'), timeoutMs: z.literal(15_000), maxOutputTokens: z.literal(512) }).optional() }).passthrough();
type Checkpoint = z.infer<typeof checkpointSchema>;
type Options = { output: string; config: string; operator?: string; baseline?: string; allow?: boolean; approvedHash?: string; creditReservation?: string; credential?: string; allowDispatch?: boolean };
async function absent(path: string) { try { await lstat(path); throw new Error('Output already exists; read back rather than repeat'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
async function save(path: string, value: unknown) { const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
async function privateText(path: string, limit: number) { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const s = await file.stat(); if (!s.isFile() || s.mode & 0o077 || s.size > limit) throw new Error('Private bounded file required'); return await file.readFile('utf8'); } finally { await file.close(); } }
const localFetch: typeof fetch = (input, init) => { if (new URL(input instanceof Request ? input.url : String(input)).origin !== 'http://127.0.0.1:3210') throw new Error('Exact localhost only'); return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]) }); };
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: false, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
const answer = 'I could not find the delivery cost before confirming checkout.';
/** Side-effect-free reader: bundling never imports setup or resolves env beside
 * an emitted artifact. Read the existing exact worktree-local file only. */
export async function readGoalLocalEnvironment() {
  const text = await privateText(resolve('infra/research/.env.local'), 65_536), pairs = text.trim().split('\n').map(line => {
    const at = line.indexOf('='); if (at < 1) throw new Error('Invalid local configuration line'); return [line.slice(0, at), line.slice(at + 1).trimEnd()];
  });
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) throw new Error('Duplicate local configuration key');
  const env = Object.fromEntries(pairs);
  if (env.CONVEX_DEPLOY_KEY || env.CONVEX_DEPLOYMENT) throw new Error('Cloud configuration forbidden');
  return z.object({ CONVEX_SELF_HOSTED_URL: z.literal('http://127.0.0.1:3210'), CONVEX_SELF_HOSTED_ADMIN_KEY: z.string().min(1) }).parse(env);
}

/** Positive body-completion evidence is distinct from parsed provider/native success.
 * Partial bytes are retained on timeout; cancellation alone proves no model outcome. */
export function captureLiveResponse(path: string, expectedInputHash: string, nativeFetch: typeof fetch = fetch) {
  const status = { started: false, headersReceived: false, bodyComplete: false, httpSettled: false, aborted: false, bytes: 0, bodyHash: null as string | null, httpStatus: null as number | null, error: null as string | null };
  const captured: typeof fetch = async (input, init) => {
    if (String(input) !== `${DO_ENDPOINT}/v1/chat/completions` || hash(String(init?.body)) !== expectedInputHash || status.started || init?.signal?.aborted) throw new Error('Unreviewed or repeated inference dispatch');
    status.started = true;
    const signal = AbortSignal.any([AbortSignal.timeout(liveGoalLimits.timeoutMs), ...(init?.signal ? [init.signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, remove = () => {}, created = false;
    const rawHash = createHash('sha256');
    try {
      await writeFile(path, new Uint8Array(), { mode: 0o600, flag: 'wx' });
      created = true;
      const stop = new Promise<never>((_, reject) => { const fail = () => { status.aborted = true; reject(new Error('live-http-deadline')); }; signal.addEventListener('abort', fail, { once: true }); remove = () => signal.removeEventListener('abort', fail); if (signal.aborted) fail(); }); void stop.catch(() => undefined);
      // A race deadline is not proof that a fetch/body promise has settled.
      const pending = nativeFetch(input, { ...init, signal, redirect: 'error' });
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().then(() => { status.httpSettled = true; }, () => {}); }, () => { status.httpSettled = true; });
      const response = await Promise.race([pending, stop]); status.headersReceived = true; status.httpStatus = response.status;
      reader = response.body?.getReader(); if (!reader) throw new Error('Missing inference response body');
      const chunks: Uint8Array[] = [];
      for (;;) {
        const reading = reader.read(); void reading.catch(() => { status.httpSettled = true; });
        const next = await Promise.race([reading, stop]); if (next.done) break;
        if (status.bytes + next.value.length > 64_000) { const partial = next.value.slice(0, 64_000 - status.bytes); await appendFile(path, partial); rawHash.update(partial); status.bytes += partial.length; throw new Error('live-response-over-64000'); }
        await appendFile(path, next.value); rawHash.update(next.value); status.bytes += next.value.length; chunks.push(next.value);
      }
      status.bodyComplete = true; status.httpSettled = true;
      return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' } });
    } catch (e) { status.error = (e as Error).message === 'live-response-over-64000' ? 'response-bound' : 'http-outcome-unconfirmed'; throw e; }
    finally { if (created) status.bodyHash = rawHash.digest('hex'); remove(); void reader?.cancel().then(() => { status.httpSettled = true; }, () => {}); }
  };
  return { fetch: captured, status };
}

export async function runLiveGoalFixture(mode: string, options: Options) {
  if (mode === 'offline-bootstrap-check' && !options.allow && !options.allowDispatch) return { state: 'offline-bootstrap-ready', providerDispatch: false, ...liveGoalLimits };
  if (!['prepare', 'preview', 'dispatch', 'readback', 'disable'].includes(mode) || !options.allow || !options.output || !options.config) throw new Error('Explicit local live goal action required');
  const output = resolve(options.output), cfg = z.object({ deployment: z.literal('http://127.0.0.1:3210'), publicOrigin: z.literal('http://127.0.0.1:5174'), gatewaySecret: z.string().regex(/^[a-f0-9]{64,128}$/) }).parse(await privateJson(resolve(options.config)));
  const env = await readGoalLocalEnvironment();
  const client = () => new ConvexHttpClient(cfg.deployment, { logger: false, fetch: localFetch }), admin = client();
  // Local administration method exists on the pinned runtime but is intentionally
  // absent from the public browser-client declaration. No client receives this key.
  const localAdmin = admin as ConvexHttpClient & { setAdminAuth(token: string): void };
  if (typeof localAdmin.setAdminAuth !== 'function') throw new Error('Pinned local admin client unavailable');
  localAdmin.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  const readiness = (sessionIds: string[]) => admin.query(ref<'query'>('researchInterviewFixture:readiness'), { sessionIds });
  const baselinePath = mode === 'prepare' ? options.baseline : undefined;
  if (mode === 'prepare') { await absent(output); if (!baselinePath) throw new Error('Retained GF1 checkpoint required'); }
  let checkpoint: Checkpoint;
  if (mode === 'prepare') {
    const baseline = z.object({ mode: z.literal('local-deterministic-goal-interview'), policy: z.object({ expiresAt: z.number() }), sessions: z.array(z.object({ sessionId: z.string() })).length(1) }).parse(await privateJson(resolve(baselinePath!)));
    const existing = await readiness([baseline.sessions[0].sessionId]);
    if (!existing.policy?.enabled || existing.policy.allocatedCalls !== 2 || existing.policy.chargedCalls !== 1 || existing.policy.maxSessionCalls !== 1 || existing.policy.model !== liveGoalLimits.model || existing.policy.maxInputBytes !== 64_000 || existing.policy.maxOutputTokens !== 512 || existing.policy.expiresAt !== baseline.policy.expiresAt || existing.policy.expiresAt <= Date.now() || existing.activeAttempts || existing.activeTruncated || existing.sessions[0]?.chargedCalls !== 1 || existing.sessions[0].truncated || existing.sessions[0].attempts.length !== 1 || existing.sessions[0].attempts[0].state !== 'ready' || existing.sessions[0].attempts[0].active) throw new Error('GF1 remaining allowance differs; never reset/re-enable');
    const parent = await lstat(dirname(output)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Error('Private runtime directory required');
    checkpoint = { mode: 'local-live-goal-interview', id: randomUUID(), state: 'preparing', baseline: resolve(baselinePath!), policyAtPreparation: existing.policy };
    await writeFile(output, JSON.stringify(checkpoint, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const credentials = z.object({ email: z.string(), password: z.string() }).parse(await privateJson(resolve(options.operator ?? 'infra/research/operator.private.json'))), operator = client(); let signedIn = false;
    try {
      const login = await operator.action(ref<'action'>('auth:signIn'), { provider: 'password', params: { flow: 'signIn', ...credentials } }); if (!login.tokens?.token) throw new Error('Normal authentication failed'); operator.setAuth(login.tokens.token); signedIn = true;
      const clientId = await operator.mutation(ref<'mutation'>('research:createClient'), { name: `Live goal probe ${checkpoint.id}` }), projectId = await operator.mutation(ref<'mutation'>('research:createProject'), { clientId, name: 'Bounded live checkout clarification' });
      const definition = { title: 'Bounded live goal interview probe', introduction: 'Synthetic typed participant input. One bounded live model clarification may follow; no voice provider.', goals: ['Understand whether people can find the delivery cost before confirming checkout.'], script: [{ id: 'q1', question: 'What did you notice about the delivery cost during checkout?' }, { id: 'q2', question: 'What would make the checkout clearer?' }], prototypeUrl: null, repository: null };
      const study = await operator.mutation(ref<'mutation'>('research:saveStudy'), { clientId, projectId, expectedRevision: 0, definition }); checkpoint.study = { clientId, projectId, studyId: study.studyId, definition }; await save(output, checkpoint);
      const invitation = await operator.action(ref<'action'>('invitations:create'), { clientId, projectId, studyVersion: 1, requestId: `live-goal-${checkpoint.id}` });
      checkpoint.sessionId = invitation.sessionId; checkpoint.tokenPath = join(dirname(output), `live-goal-${checkpoint.id}.private.json`);
      await writeFile(checkpoint.tokenPath!, JSON.stringify({ token: invitation.token, url: `http://127.0.0.1:5174/participate#token=${invitation.token}` }) + '\n', { mode: 0o600, flag: 'wx' }); await save(output, checkpoint);
      const guest = client(); await guest.mutation(ref<'mutation'>('participant:agree'), { token: invitation.token, expectedRevision: 0, consent });
      const s = await guest.query(ref<'query'>('participant:resume'), { token: invitation.token });
      await guest.mutation(ref<'mutation'>('participant:answer'), { token: invitation.token, expectedRevision: s.revision, requestId: `live-goal-answer-${checkpoint.id}`, questionId: 'q1', text: answer, channel: 'text' });
      const staged = await guest.query(ref<'query'>('participant:resume'), { token: invitation.token }); if (!staged.pendingInterview) throw new Error('Accepted synthetic input is not pending');
      checkpoint.scope = staged.pendingInterview.scope; checkpoint.syntheticInput = { consent, answer }; checkpoint.state = 'staged'; await save(output, checkpoint);
    } catch (e) { checkpoint.state = 'incomplete'; await save(output, checkpoint); throw e; }
    finally { if (signedIn) { try { await operator.action(ref<'action'>('auth:signOut'), {}); checkpoint.operatorSignedOut = true; } catch { checkpoint.operatorSignedOut = false; } await save(output, checkpoint); } }
    return { state: checkpoint.state };
  }
  checkpoint = checkpointSchema.parse(await privateJson(output));
  if (!checkpoint.sessionId || !checkpoint.tokenPath) throw new Error('Incomplete preparation; inspect, never replay');
  const access = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await privateJson(checkpoint.tokenPath)), authority = convexInterviewAuthority(cfg.deployment, cfg.gatewaySecret, access.token);
  if (mode === 'preview') {
    if (checkpoint.state !== 'staged' || !checkpoint.scope) throw new Error('Preview already retained or dispatch uncertain');
    const context = await authority.inspect(checkpoint.scope as InterviewScope), wire = await prepareDigitalOceanRequest({ endpoint: DO_ENDPOINT, apiKey: 'review-only-no-network', ...liveGoalLimits, responseFormat: 'json' }, interviewMessages(context));
    const requestPath = `${output}.request.private.json`; await writeFile(requestPath, wire.body, { mode: 0o600, flag: 'wx' });
    checkpoint.preview = { requestPath, inputHash: hash(wire.body), requestBytes: wire.requestBytes, contextHash: hash(canonical(context)), model: liveGoalLimits.model, timeoutMs: 15_000, maxOutputTokens: 512 }; checkpoint.state = 'previewed'; await save(output, checkpoint); return { state: checkpoint.state, ...checkpoint.preview };
  }
  if (mode === 'dispatch') {
    const p = checkpoint.preview;
    if (checkpoint.state !== 'previewed' || !checkpoint.scope || !p || !options.allowDispatch || options.approvedHash !== p.inputHash || !/^[a-zA-Z0-9_-]{8,128}$/.test(options.creditReservation ?? '') || !options.credential) throw new Error('Exact approved request and prospective credit reservation required');
    const original = await privateText(p.requestPath, 64_000); if (hash(original) !== p.inputHash || Buffer.byteLength(original) !== p.requestBytes) throw new Error('Reviewed request file changed');
    const context = await authority.inspect(checkpoint.scope as InterviewScope); if (hash(canonical(context)) !== p.contextHash) throw new Error('Reviewed context changed');
    const apiKey = z.object({ apiKey: z.string().min(1).max(4096) }).parse(await privateJson(resolve(options.credential))).apiKey;
    const current = await readiness([checkpoint.sessionId]); if (!current.policy?.enabled || current.policy.allocatedCalls !== 2 || current.policy.chargedCalls !== 1 || current.policy.maxSessionCalls !== 1 || current.policy.model !== liveGoalLimits.model || current.policy.maxInputBytes !== 64_000 || current.policy.maxOutputTokens !== 512 || current.policy.expiresAt <= Date.now() || current.activeAttempts || current.activeTruncated || current.sessions[0].chargedCalls !== 0 || current.sessions[0].truncated || current.sessions[0].attempts.length) throw new Error('Remaining credit is no longer available');
    const rawPath = `${output}.response.private.json`; await absent(rawPath);
    await writeFile(`${output}.intent.private.json`, JSON.stringify({ request: p, scope: checkpoint.scope, creditReservation: options.creditReservation, approvedAt: Date.now() }) + '\n', { mode: 0o600, flag: 'wx' });
    checkpoint.state = 'dispatch-intent'; await save(output, checkpoint);
    const capture = captureLiveResponse(rawPath, p.inputHash), provider = digitalOceanInterview({ endpoint: DO_ENDPOINT, apiKey, ...liveGoalLimits }, capture.fetch);
    const bound = { ...provider, prepare: async (...args: Parameters<typeof provider.prepare>) => { const prepared = await provider.prepare(...args); if (prepared.inputHash !== p.inputHash || prepared.requestBytes !== p.requestBytes || prepared.maxOutputTokens !== 512) throw new Error('Actual wire differs from root review'); return prepared; } };
    try { checkpoint.result = await runInterviewTurn(authority, { enabled: true, provider: bound }, checkpoint.scope as InterviewScope, new AbortController().signal); }
    catch { checkpoint.result = { state: 'unknown', message: 'Inspect native state; no dispatch retry' }; }
    checkpoint.rawResponse = { path: rawPath, ...capture.status }; await save(output, checkpoint);
  }
  if (mode === 'disable') await admin.mutation(ref<'mutation'>('researchInterviewFixture:disable'), {});
  checkpoint.native = await readiness([checkpoint.sessionId]); checkpoint.participant = await client().query(ref<'query'>('participant:resume'), { token: access.token });
  const participant = checkpoint.participant as { consent?: unknown }; if (participant.consent) checkpoint.sources = await client().query(ref<'query'>('participant:sources'), { token: access.token, paginationOpts: { numItems: 25, cursor: null } });
  checkpoint.checkedAt = Date.now(); await save(output, checkpoint);
  return { state: 'readback', receiptHash: hash(canonical({ native: checkpoint.native, result: checkpoint.result ?? null, rawResponse: checkpoint.rawResponse ?? null })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  void runLiveGoalFixture(process.argv[2], { output: value('--output') ?? '', config: value('--config') ?? '', baseline: value('--baseline'), operator: value('--operator'), allow: process.argv.includes('--allow-local-live-goal-probe'), approvedHash: value('--approved-request-sha256'), creditReservation: value('--credit-reservation'), credential: value('--credential'), allowDispatch: process.argv.includes('--allow-one-reviewed-do-call') }).then(result => { console.log(JSON.stringify(result)); }, () => { console.error('Live goal probe action failed. Retain private intent/response and inspect native state; no replay.'); process.exitCode = 1; });
}
