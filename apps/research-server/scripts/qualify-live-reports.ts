/** Root-only local tracer. Importing this module performs no work. No automatic inference replay. */
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { lstat, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { loadConfig, privateJson } from '../src/config';
import { parseAnalysisConfig, assembleAnalysisRuntime } from '../src/analysis-config';
import { startResearchServer } from '../src/server';
import { requireFreeListener } from '../src/listener';
import { hashValue, evidenceId, type Selection } from '../../../packages/research-core/src/analysis';
import { clientProjection } from '../../research/src/PublicationPreview';
import { canonicalPath, bounded, exclusive, fingerprints, fixture, ledger, limits, sha, transcript, assertResume, assertReviewWindow, reviewedDocument, reviewSchema, oneShot, inspectGenerated, confirmsInvalidation } from './report-trace-boundary';

type Scope = { clientId: string; projectId: string };
type State = { id: string; phase: string; token: string; scope: Scope; sessionId: string; analysisId?: string; analysisHash?: string; revision?: number; reviewUntil?: number; reportId?: string; shareId?: string; selections: Selection[] };
type Options = { id: string; configPath: string; operatorPath: string; analysisConfigPath?: string; envPath?: string; reviewPath?: string; expectedHash?: string; expectedRevision?: number };
const consent = { version: 'research-consent-1', storage: true, analysis: true, microphone: false, camera: false, screen: true, dom: false, shareDom: false, shareTranscript: true, shareAudio: false, shareCamera: false, shareScreen: true, retainApprovedExcerpts: false };
export async function preflight(id: string, expiresAt: number) {
  assert(Number.isSafeInteger(expiresAt) && expiresAt > Date.now() + limits.timeoutMs && expiresAt <= Date.now() + 24 * 60 * 60_000, 'Explicit bounded root expiry required');
  const frozen = await fixture(), value = { id, state: 'reserved-not-dispatched', providerCalls: 0, preparedAt: new Date().toISOString(), expiresAt, reservationId: `${id}-analysis`, limits, ledger: await ledger(id, expiresAt), modules: await fingerprints(), qualificationHash: frozen.qualificationHash, source: frozen.source, transcriptHash: sha(transcript), reviewWindowMs: 30 * 60_000 };
  await exclusive(id, 'PREFLIGHT', value); return { id, state: value.state, providerCalls: 0, output: canonicalPath(id, 'PREFLIGHT') };
}
async function currentPreflight(id: string) {
  const value = JSON.parse((await bounded(canonicalPath(id, 'PREFLIGHT'), 64_000)).toString());
  assert(value.id === id && value.state === 'reserved-not-dispatched' && value.providerCalls === 0 && value.reservationId === `${id}-analysis` && JSON.stringify(value.limits) === JSON.stringify(limits) && value.reviewWindowMs === 30 * 60_000 && value.expiresAt > Date.now() + limits.timeoutMs, 'Current finalized preflight required');
  const frozen = await fixture(); assert(frozen.qualificationHash === value.qualificationHash && JSON.stringify(frozen.source) === JSON.stringify(value.source) && value.transcriptHash === sha(transcript), 'Qualification fixture changed');
  assert(JSON.stringify(await ledger(id, value.expiresAt)) === JSON.stringify(value.ledger) && JSON.stringify(await fingerprints()) === JSON.stringify(value.modules), 'Ledger or implementation changed since preflight'); return { value, frozen };
}
async function context(options: Options) {
  const config = await loadConfig(resolve(options.configPath)), nativeFetch = globalThis.fetch;
  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); assert([config.deployment, config.bindOrigin, config.publicOrigin].includes(url.origin as typeof config.deployment), 'Only isolated loopback APIs allowed');
    return nativeFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(url.pathname === '/api/research/analysis' ? 130_000 : 30_000), ...(init?.signal ? [init.signal] : [])]) });
  };
  globalThis.fetch = localFetch;
  const operator = new ConvexHttpClient(config.deployment, { logger: false, fetch: localFetch }), guest = new ConvexHttpClient(config.deployment, { logger: false, fetch: localFetch }); let bearer = '';
  const statePath = resolve(dirname(resolve(options.configPath)), `${options.id}-resume.json`);
  return { config, operator, guest, statePath, nativeFetch, localFetch,
    async login() { const c = await privateJson(resolve(options.operatorPath)) as { email: string; password: string }; const result = await operator.action(ref<'action'>('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: c.email, password: c.password } }); assert(result.tokens?.token, 'Normal operator login required'); bearer = result.tokens.token; operator.setAuth(bearer); },
    api(path: string, init: RequestInit = {}, cookie = '') { return localFetch(`${config.bindOrigin}/api/research${path}`, { ...init, headers: { Origin: config.publicOrigin, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string> ?? {}) } }); },
    post(path: string, value: unknown, auth = false) { const body = JSON.stringify(value); return this.api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...(auth ? { Authorization: `Bearer ${bearer}` } : {}) }, body }); },
    async close(runtime?: Awaited<ReturnType<typeof startResearchServer>>) { const result = { ownedGatewayStopped: false, operatorSignedOut: false }; if (runtime) try { await runtime.close(); result.ownedGatewayStopped = true; } catch { /* preserve false */ } if (bearer) try { await operator.action(ref<'action'>('auth:signOut'), {}); result.operatorSignedOut = true; } catch { /* preserve false */ } globalThis.fetch = nativeFetch; return result; },
    async saveState(value: State, first = false) { await writeFile(statePath, JSON.stringify(value) + '\n', { ...(first ? { flag: 'wx' } : {}), mode: 0o600 }); },
  };
}
async function terminalCleanup(ctx: Awaited<ReturnType<typeof context>>, state: State | undefined) {
  const result = { captureStopped: false, reportWithdrawn: false, storageWithdrawn: false, sourceReadDenied: false, privateResumeRemoved: false };
  if (!state) return result;
  try { await ctx.guest.mutation(ref<'mutation'>('capture:stop'), { token: state.token }); result.captureStopped = true; } catch { /* may already be stopped; not asserted */ }
  // Readback after an ambiguous publish prevents an orphan publication without replaying it.
  try { if (!state.reportId) { const found = await ctx.operator.query(ref<'query'>('researchReports:requestStatus'), { ...state.scope, requestId: `${state.id}-publish` }); if (found) state.reportId = found.reportId; } if (state.reportId) await ctx.operator.mutation(ref<'mutation'>('researchReports:withdraw'), { ...state.scope, reportId: state.reportId }); result.reportWithdrawn = true; } catch { /* retain failure honestly */ }
  try { const current = await ctx.guest.query(ref<'query'>('participant:resume'), { token: state.token }); await ctx.guest.mutation(ref<'mutation'>('capture:changeConsent'), { token: state.token, expectedRevision: current.revision, consent: { ...consent, storage: false } }); result.storageWithdrawn = true; } catch { /* explicit root cleanup can use retained token */ }
  if (result.storageWithdrawn && state.analysisId) result.sourceReadDenied = await confirmsInvalidation(() => ctx.operator.query(ref<'query'>('researchAnalysis:read'), { ...state.scope, analysisId: state.analysisId }));
  if (result.storageWithdrawn && result.reportWithdrawn) try { await unlink(ctx.statePath); result.privateResumeRemoved = true; } catch { /* preserve false */ }
  return result;
}
export async function analyzeOnce(options: Options) {
  const { value: prepared, frozen } = await currentPreflight(options.id);
  await exclusive(options.id, 'ANALYSIS-INTENT', { id: options.id, state: 'local-source-creation-intent', at: new Date().toISOString(), preflightHash: sha(await bounded(canonicalPath(options.id, 'PREFLIGHT'), 64_000)), noRetries: true });
  let ctx: Awaited<ReturnType<typeof context>> | undefined, runtime: Awaited<ReturnType<typeof startResearchServer>> | undefined, state: State | undefined, calls = 0, outcome: any = { id: options.id, state: 'failed', providerCalls: 0 }, phase = 'startup';
  try {
    ctx = await context(options); await requireFreeListener(() => ctx!.localFetch(`${ctx!.config.bindOrigin}/capture/health`));
    assert(options.analysisConfigPath && options.envPath, 'Explicit root private config/env paths required');
    const config = parseAnalysisConfig(await privateJson(resolve(options.analysisConfigPath)));
    assert(config.enabled && config.reservations.length === 1 && config.timeoutMs === limits.timeoutMs && config.maxRequestBytes === limits.maxInputBytes, 'Exactly one bounded live reservation required');
    const reservation = config.reservations[0]; assert(reservation.id === prepared.reservationId && reservation.maxInputBytes === limits.maxInputBytes && reservation.maxOutputTokens === limits.maxOutputTokens && reservation.expiresAt === prepared.expiresAt, 'Private reservation differs from preflight');
    const envInfo = await lstat(resolve(options.envPath)); assert(envInfo.isFile() && !envInfo.isSymbolicLink() && !(envInfo.mode & 0o077), 'Private runtime env required');
    loadEnvFile(resolve(options.envPath)); const key = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY; assert(key, 'Private model key unavailable');
    const observed = oneShot(ctx.nativeFetch, key, async wire => {
      const fresh = await currentPreflight(options.id); assert(fresh.value.expiresAt > Date.now() + limits.timeoutMs, 'Reservation expired');
      const status = await ctx!.operator.query(ref<'query'>('researchAnalysis:requestStatus'), { ...state!.scope, requestId: `${options.id}-analysis-request` }); assert(status?.analysisId, 'Native admitted request identity unavailable');
      state!.analysisId = status.analysisId; await ctx!.saveState(state!);
      const row = await ctx!.operator.query(ref<'query'>('researchAnalysis:read'), { ...state!.scope, analysisId: status.analysisId });
      assert(row.state === 'dispatching' && row.receipt.inputHash === sha(wire) && row.receipt.requestBytes === Buffer.byteLength(wire) && row.receipt.maxOutputTokens === limits.maxOutputTokens && row.receipt.frames.length === 1, 'Native admitted receipt differs from wire');
      const frame = row.receipt.frames[0]; assert(frame.mediaHash === frozen.source.mediaHash && frame.imageHash === frozen.source.imageHash && frame.atMs === frozen.source.atMs && frame.bytes === frozen.source.imageBytes, 'Actual private frame differs from DO-V1 fixture');
      await exclusive(options.id, 'DISPATCH', { id: options.id, at: new Date().toISOString(), calls: 1, analysisId: row.analysisId, manifestHash: row.manifestHash, inputHash: sha(wire), requestBytes: Buffer.byteLength(wire), frame, ledger: fresh.value.ledger, modules: fresh.value.modules }); calls = 1;
    }, value => exclusive(options.id, 'RESPONSE', value));
    runtime = await startResearchServer(ctx.config, assembleAnalysisRuntime(config, () => key, observed));
    await ctx.login(); phase = 'native-source-creation';
    const clientId = await ctx.operator.mutation(ref<'mutation'>('research:createClient'), { name: `Live synthetic trace ${options.id}` }), projectId = await ctx.operator.mutation(ref<'mutation'>('research:createProject'), { clientId, name: 'Fictional source-linked report qualification' }), scope = { clientId, projectId };
    await ctx.operator.mutation(ref<'mutation'>('research:saveStudy'), { ...scope, expectedRevision: 0, definition: { title: 'Synthetic transcript and one sampled frame', introduction: 'Fictional fixture; not participant or clinical evidence.', goals: ['Return two separate findings: one exact participant self-report and one tentative-screen observation citing its selected timestamp. Quote only text readable in the actual image. Each limitation must state this is a fictional fixture and one sampled frame cannot establish user actions, emotions, DOM behavior or causality. The transcript claim and visible screen are distinct evidence; acknowledge their limited relationship.'], script: [{ id: 'q1', question: 'What did you notice?' }], prototypeUrl: null, repository: null } });
    const invite = await ctx.operator.action(ref<'action'>('invitations:create'), { ...scope, studyVersion: 1, requestId: `${options.id}-invite` });
    state = { id: options.id, phase: 'source-creation', scope, sessionId: invite.sessionId, token: invite.token, selections: [] }; await ctx.saveState(state, true);
    await ctx.guest.mutation(ref<'mutation'>('participant:agree'), { token: state.token, expectedRevision: 0, consent });
    await ctx.guest.mutation(ref<'mutation'>('participant:answer'), { token: state.token, expectedRevision: 1, requestId: `${options.id}-answer`, questionId: 'q1', text: transcript, channel: 'text' });
    const sources = await ctx.operator.query(ref<'query'>('research:sessionSources'), { ...scope, sessionId: invite.sessionId, paginationOpts: { numItems: 25, cursor: null } }), source = sources.page.find((s: any) => s.author === 'participant'); assert(source?.text === transcript);
    const capture = await ctx.guest.mutation(ref<'mutation'>('capture:start'), { token: state.token }); outcome.captureDeadline = capture.deadline;
    const media = await ctx.guest.mutation(ref<'mutation'>('capture:reserve'), { token: state.token, requestId: `${options.id}-screen`, descriptor: { modality: 'screen', sequence: 0, startMs: frozen.source.segmentStartMs, endMs: frozen.source.segmentEndMs, bytes: frozen.bytes.length, sha256: frozen.source.mediaHash, mime: 'video/webm', questionId: 'q1', sourceId: null } });
    const upload = await ctx.localFetch(`${ctx.config.bindOrigin}/capture/media/${media.id}`, { method: 'PUT', headers: { Origin: ctx.config.publicOrigin, 'X-Research-Participant': state.token, 'Content-Type': 'application/octet-stream', 'Content-Length': String(frozen.bytes.length) }, body: new Uint8Array(frozen.bytes) }); assert.equal(upload.status, 200); assert.equal((await upload.json()).state, 'available');
    await ctx.guest.mutation(ref<'mutation'>('capture:stop'), { token: state.token }); outcome.captureStopped = true;
    state.selections = [{ sessionId: invite.sessionId, id: source._id, kind: 'self-report', start: 0, end: transcript.length }, { sessionId: invite.sessionId, id: media.id, kind: 'screen-observation', start: frozen.source.atMs, end: frozen.source.atMs + 1 }]; await ctx.saveState(state);
    phase = 'live-analysis';
    // The provider hook reads the native request identity before dispatch. Never issue a second POST.
    const response = await ctx.post('/analysis', { ...scope, requestId: `${options.id}-analysis-request`, reservationId: reservation.id, selections: state.selections }, true); assert.equal(response.status, 200); const result = await response.json(); state.analysisId = result.analysisId;
    const row = await ctx.operator.query(ref<'query'>('researchAnalysis:read'), { ...scope, analysisId: result.analysisId }); outcome.nativeAnalysis = row;
    assert.equal(result.state, 'ready'); assert.equal(calls, 1); assert.equal(row.receipt.classification, 'live'); inspectGenerated(row.findings, row.evidence);
    const providerResponse = JSON.parse((await bounded(canonicalPath(options.id, 'RESPONSE'), 512_000)).toString()); assert(providerResponse.complete && Number.isSafeInteger(providerResponse.usage?.completion_tokens) && providerResponse.usage.completion_tokens <= limits.maxOutputTokens, 'Bounded complete provider accounting required');
    state.phase = 'awaiting-root-review'; state.analysisHash = await hashValue(row); state.revision = row.revision; state.reviewUntil = Date.now() + prepared.reviewWindowMs; await ctx.saveState(state);
    outcome = { ...outcome, state: 'awaiting-root-review', analysisId: row.analysisId, analysisHash: state.analysisHash, revision: row.revision, reviewUntil: state.reviewUntil, fixture: { ...scope, sessionId: state.sessionId, selections: state.selections }, generatedFindingsReviewed: false };
  } catch { outcome.state = calls ? 'unknown-or-failed-terminal' : 'failed-before-dispatch'; outcome.failure = { phase, code: 'trace-boundary-failed' }; }
  finally {
    outcome.providerCalls = calls;
    if (ctx && outcome.state !== 'awaiting-root-review') outcome.cleanup = await terminalCleanup(ctx, state);
    if (ctx) outcome.shutdown = await ctx.close(runtime); outcome.finishedAt = new Date().toISOString(); await exclusive(options.id, 'ANALYSIS', outcome);
  }
  return { id: options.id, state: outcome.state, providerCalls: calls, output: canonicalPath(options.id, 'ANALYSIS') };
}

export async function publishReviewed(options: Options, cleanupOnly = false) {
  // Exclusive phase fence precedes any auth/mutation. A failed/unknown publish is never replayed.
  const statePath = resolve(dirname(resolve(options.configPath)), `${options.id}-resume.json`), state = await privateJson(statePath) as State;
  if (!cleanupOnly) assertResume(options.id, JSON.parse((await bounded(canonicalPath(options.id, 'ANALYSIS'), 256_000)).toString()), state);
  else assert(state.id === options.id && state.scope && state.token, 'Same private trace state required');
  if (!cleanupOnly) assert(options.reviewPath && options.expectedHash && Number.isSafeInteger(options.expectedRevision), 'Explicit root review document/hash/revision required');
  const frozenReview = cleanupOnly ? undefined : reviewSchema.parse(JSON.parse((await bounded(resolve(options.reviewPath!), 64_000)).toString()));
  await exclusive(options.id, cleanupOnly ? 'CLEANUP-INTENT' : 'PUBLISH-INTENT', { id: options.id, analysisId: state.analysisId, analysisHash: state.analysisHash, revision: state.revision, expectedHash: options.expectedHash ?? null, expectedRevision: options.expectedRevision ?? null, reviewDocumentHash: frozenReview ? await hashValue(frozenReview) : null, at: new Date().toISOString(), providerCalls: 0 });
  let ctx: Awaited<ReturnType<typeof context>> | undefined, runtime: Awaited<ReturnType<typeof startResearchServer>> | undefined; const receipt: any = { id: options.id, state: 'failed', providerCalls: 0, checks: [] }; let phase = 'startup';
  try {
    ctx = await context(options); await requireFreeListener(() => ctx!.localFetch(`${ctx!.config.bindOrigin}/capture/health`)); await ctx.login(); runtime = await startResearchServer(ctx.config); // Provider OFF, even if env still has a key.
    if (!cleanupOnly) {
      const row = await ctx.operator.query(ref<'query'>('researchAnalysis:read'), { ...state.scope, analysisId: state.analysisId }), document = await reviewedDocument(frozenReview, options.id, row, options.expectedHash!, options.expectedRevision!);
      assert(options.expectedHash === state.analysisHash && options.expectedRevision === state.revision, 'Review differs from retained analysis');
      phase = 'save-explicit-root-review'; assertReviewWindow(state); const reviewRevision = await ctx.operator.mutation(ref<'mutation'>('researchAnalysis:saveReview'), { ...state.scope, analysisId: state.analysisId, expectedRevision: row.revision, findings: document.findings, excerpts: document.excerpts });
      assertReviewWindow(state); const args = { ...state.scope, analysisId: state.analysisId, reviewRevision, title: document.title, grants: document.grants }, preview = await ctx.operator.query(ref<'query'>('researchReports:preview'), args);
      phase = 'publish-exact-reviewed-preview'; assertReviewWindow(state); const publication = await ctx.operator.mutation(ref<'mutation'>('researchReports:publish'), { ...args, previewHash: preview.previewHash, requestId: `${options.id}-publish` }); state.reportId = publication.reportId; await ctx.saveState(state); receipt.publication = publication; receipt.previewHash = preview.previewHash; receipt.reviewDocumentHash = await hashValue(document);
      const textId = evidenceId(state.selections[0]), screenId = evidenceId(state.selections[1]), textGrant = document.grants.find(g => g.evidenceId === textId), screenGrant = document.grants.find(g => g.evidenceId === screenId);
      assert(textGrant?.view && !textGrant.download && screenGrant?.view && screenGrant.download, 'Trace review must explicitly approve transcript view-only and full-screen view/download');
      phase = 'password-portal'; assertReviewWindow(state); const password = `Synthetic-${options.id}-portal-only`, shared = await ctx.post('/shares', { ...state.scope, reportId: state.reportId, requestId: `${options.id}-share`, password }, true); assert.equal(shared.status, 200); const share = await shared.json(); state.shareId = share.shareId; await ctx.saveState(state);
      const unlocked = await ctx.post('/portal/unlock', { slug: share.slug, password }); assert.equal(unlocked.status, 200); const cookieHeader = unlocked.headers.get('set-cookie')!; assert(cookieHeader.includes('HttpOnly') && cookieHeader.includes('SameSite=Strict')); await unlocked.body?.cancel(); const cookie = cookieHeader.split(';')[0];
      const reportResponse = await ctx.api(`/portal/report?slug=${share.slug}`, {}, cookie); assert.equal(reportResponse.status, 200); const report = await reportResponse.json(), projection = clientProjection(preview);
      for (const key of ['title', 'clientName', 'projectName', 'findings', 'excerpts', 'grants']) assert.deepEqual(report[key], projection[key as keyof typeof projection]);
      const download = await ctx.api(`/portal/download?slug=${share.slug}`, {}, cookie); assert.equal(download.status, 200); assert.deepEqual(await download.json(), report);
      const textAlias = report.evidence.find((e: any) => e.kind === 'self-report').evidenceId, screenAlias = report.evidence.find((e: any) => e.kind === 'screen-observation').evidenceId;
      const text = await ctx.api(`/portal/source/${textAlias}?slug=${share.slug}&intent=view`, {}, cookie); assert.equal(text.status, 200); assert.equal(await text.text(), transcript);
      const denied = await ctx.api(`/portal/source/${textAlias}?slug=${share.slug}&intent=download`, {}, cookie); assert.equal(denied.status, 409); await denied.body?.cancel();
      const recording = await ctx.api(`/portal/source/${screenAlias}?slug=${share.slug}&intent=download`, {}, cookie); assert.equal(recording.status, 200); const frozen = await fixture(); assert.equal(sha(new Uint8Array(await recording.arrayBuffer())), frozen.source.mediaHash);
      const range = await ctx.api(`/portal/source/${screenAlias}?slug=${share.slug}&intent=view`, { headers: { Range: 'bytes=10-29' } }, cookie); assert.equal(range.status, 206); assert.deepEqual(new Uint8Array(await range.arrayBuffer()), new Uint8Array(frozen.bytes.subarray(10, 30))); receipt.checks.push('exact frozen report download and independent transcript/media grants');
      await ctx.operator.mutation(ref<'mutation'>('researchPortal:revokeShare'), { ...state.scope, shareId: state.shareId, expectedRevision: 0 }); const revoked = await ctx.api(`/portal/report?slug=${share.slug}`, {}, cookie); assert.equal(revoked.status, 409); await revoked.body?.cancel(); receipt.checks.push('share revocation denies existing cookie'); receipt.state = 'portal-passed';
    } else receipt.state = 'explicit-cleanup';
  } catch { receipt.failure = { phase, code: 'trace-review-publication-boundary-failed' }; }
  finally { if (ctx) { receipt.cleanup = await terminalCleanup(ctx, state); receipt.shutdown = await ctx.close(runtime); } receipt.finishedAt = new Date().toISOString(); await exclusive(options.id, cleanupOnly ? 'CLEANUP' : 'PUBLISH', receipt); }
  return { id: options.id, state: receipt.state, providerCalls: 0, cleanup: receipt.cleanup, output: canonicalPath(options.id, cleanupOnly ? 'CLEANUP' : 'PUBLISH') };
}
// Explicit CLI only; no defaults to live mode or inherited config activation.
const modes = ['--preflight', '--analyze-once', '--publish-reviewed', '--cleanup'].filter(mode => process.argv.includes(mode));
if (modes.length) {
  assert(modes.length === 1, 'Exactly one root trace phase required');
  const arg = (name: string) => { const index = process.argv.indexOf(name); assert(index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `Explicit ${name} required`); return process.argv[index + 1]; };
  const id = arg('--id');
  if (modes[0] === '--preflight') console.log(JSON.stringify(await preflight(id, Date.parse(arg('--expires-at')))));
  else {
    const options: Options = { id, configPath: arg('--config'), operatorPath: arg('--operator') };
    if (modes[0] === '--analyze-once') { assert(process.argv.includes('--allow-one-live-analysis-call'), 'Explicit root live-call authorization flag required'); options.analysisConfigPath = arg('--analysis-config'); options.envPath = arg('--env'); console.log(JSON.stringify(await analyzeOnce(options))); }
    else if (modes[0] === '--publish-reviewed') { assert(process.argv.includes('--confirm-reviewed'), 'Explicit root human review confirmation required'); options.reviewPath = arg('--review'); options.expectedHash = arg('--expected-analysis-hash'); options.expectedRevision = Number(arg('--expected-revision')); console.log(JSON.stringify(await publishReviewed(options))); }
    else console.log(JSON.stringify(await publishReviewed(options, true)));
  }
}
