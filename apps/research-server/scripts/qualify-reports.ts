/** Local synthetic acceptance only. Ordinary Password auth; no live providers. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { loadConfig, privateJson } from '../src/config';
import { startResearchServer } from '../src/server';
import { requireFreeListener } from '../src/listener';
import { digest } from '../../../packages/research-capture/src/contracts';
import { evidenceId, type Selection } from '../../../packages/research-core/src/analysis';
import { clientProjection } from '../../research/src/PublicationPreview';
import type { AnalysisRuntime } from '../src/analysis';

const fixturePassword = 'Synthetic-report-only-2026';
async function main() {
  if (!process.argv.includes('--allow-local-synthetic-reports')) throw new Error('Explicit synthetic-write flag required');
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const config = await loadConfig(resolve(arg('--config')));
  const credentials = await privateJson(resolve(arg('--operator'))) as { email: string; password: string };
  const output = resolve(arg('--output'));
  const id = randomUUID(), checks: { name: string; passed: true }[] = [];
  let phase = 'preflight', runtime: Awaited<ReturnType<typeof startResearchServer>> | undefined;
  const receipt: Record<string, unknown> = { id, startedAt: new Date().toISOString(), state: 'started', mode: 'synthetic-offline-fixture', realMediaDecoding: false, realDeviceCapture: false, providerCalls: 0, cloudCalls: 0, cash: 0, checks };
  const nativeFetch = globalThis.fetch;
  const boundedFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (![config.deployment, config.bindOrigin, config.publicOrigin].includes(url.origin as typeof config.deployment)) throw new Error('Non-loopback transport forbidden');
    return nativeFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) });
  };
  globalThis.fetch = boundedFetch;
  const operator = new ConvexHttpClient(config.deployment, { logger: false, fetch: boundedFetch });
  const guest = new ConvexHttpClient(config.deployment, { logger: false, fetch: boundedFetch });
  const save = async () => writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  const check = async (name: string, fn: () => Promise<void>) => { phase = name; receipt.phase = phase; await save(); await fn(); checks.push({ name, passed: true }); await save(); };
  let bearer: string | undefined, token: string | undefined, scope: { clientId: string; projectId: string } | undefined;
  const consent = { version: 'research-consent-1', storage: true, analysis: true, microphone: false, camera: false, screen: true, dom: false, shareDom: false, shareTranscript: true, shareAudio: false, shareCamera: false, shareScreen: true, retainApprovedExcerpts: true };
  const apiFetch = (path: string, init: RequestInit = {}, cookie = '') => boundedFetch(`${config.bindOrigin}/api/research${path}`, { ...init, headers: { Origin: config.publicOrigin, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string> ?? {}) } });
  const post = (path: string, value: unknown, auth = false) => { const body = JSON.stringify(value); return apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...(auth ? { Authorization: `Bearer ${bearer}` } : {}) }, body }); };
  let generated = 0, extracted = 0;
  let selections: Selection[] = [];
  const reservation = { id: `offline-native-${id}`, model: 'qwen3.8-max' as const, maxInputBytes: 64_000, maxOutputTokens: 1024, expiresAt: Date.now() + 120_000, live: false };
  const analysisRuntime: AnalysisRuntime = {
    reservations: [reservation], visionQualified: false,
    extractor: { async extract(bytes, offsetMs) { assert.equal(bytes.length, 4096); assert.equal(offsetMs, 100); extracted++; return { bytes: new Uint8Array([255, 216, 0, 1, 2, 255, 217]), mime: 'image/jpeg' }; } },
    provider: { classification: 'offline-fixture', model: reservation.model,
      async prepare(messages, admitted) { const wire = JSON.stringify({ messages, max_tokens: admitted.maxOutputTokens }); return { inputHash: await digest(new TextEncoder().encode(wire)), requestBytes: Buffer.byteLength(wire), maxOutputTokens: admitted.maxOutputTokens }; },
      async generate() { generated++; return { requestId: `offline-result-${id}`, model: reservation.model, findings: [
        { id: 'f1', type: 'self-report', statement: 'Synthetic participant reported delivery cost was difficult to find.', supports: [evidenceId(selections[0])], counterevidence: [], limitations: 'One fictional participant; fixture output is not model quality evidence.' },
        { id: 'f2', type: 'tentative-screen', statement: 'Synthetic selected frame is retained for inspection.', supports: [evidenceId(selections[1])], counterevidence: [], limitations: 'Fake decoder and fake provider. No actual screen interpretation or playable recording is established.' },
      ] }; },
    },
  };
  try {
    await requireFreeListener(() => boundedFetch(`${config.bindOrigin}/capture/health`));
    await check('normal operator auth and fresh consented synthetic session', async () => {
      const login = await operator.action(ref<'action'>('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: credentials.email, password: credentials.password } });
      assert(login.tokens?.token); bearer = login.tokens.token; operator.setAuth(bearer!);
      phase = 'create fresh synthetic client';
      const clientId = await operator.mutation(ref<'mutation'>('research:createClient'), { name: `Reports acceptance ${id}` });
      phase = 'create fresh synthetic project';
      const projectId = await operator.mutation(ref<'mutation'>('research:createProject'), { clientId, name: 'Synthetic selected evidence' }); scope = { clientId, projectId };
      phase = 'save synthetic study';
      await operator.mutation(ref<'mutation'>('research:saveStudy'), { ...scope, expectedRevision: 0, definition: { title: 'Synthetic report acceptance', introduction: 'Fictional fixture only.', goals: ['Inspect publication authority'], script: [{ id: 'q1', question: 'What did you notice?' }], prototypeUrl: null, repository: null } });
      phase = 'issue synthetic invitation';
      const invitation = await operator.action(ref<'action'>('invitations:create'), { ...scope, studyVersion: 1, requestId: `invite-${id}` }); token = invitation.token;
      phase = 'save synthetic consent and answer';
      await guest.mutation(ref<'mutation'>('participant:agree'), { token, expectedRevision: 0, consent });
      await guest.mutation(ref<'mutation'>('participant:answer'), { token, expectedRevision: 1, requestId: `answer-${id}`, questionId: 'q1', text: 'I could not find the delivery cost.', channel: 'text' });
      const rows = await operator.query(ref<'query'>('research:sessionSources'), { ...scope, sessionId: invitation.sessionId, paginationOpts: { numItems: 25, cursor: null } });
      const source = rows.page.find((row: { author: string }) => row.author === 'participant'); assert(source);
      selections = [{ sessionId: invitation.sessionId, id: source._id, kind: 'self-report', start: 0, end: source.text.length }];
      phase = 'start synthetic capture';
      const capture = await guest.mutation(ref<'mutation'>('capture:start'), { token });
      receipt.captureDeadline = capture.deadline; receipt.captureStartedAt = capture.startedAt;
      const bytes = new Uint8Array(4096).map((_v, index) => index % 251);
      phase = 'reserve synthetic media';
      const media = await guest.mutation(ref<'mutation'>('capture:reserve'), { token, requestId: `screen-${id}`, descriptor: { modality: 'screen', sequence: 0, startMs: 0, endMs: 1000, bytes: bytes.length, sha256: await digest(bytes), mime: 'video/webm', questionId: 'q1', sourceId: null } });
      runtime = await startResearchServer(config, analysisRuntime);
      const uploaded = await boundedFetch(`${config.bindOrigin}/capture/media/${media.id}`, { method: 'PUT', headers: { Origin: config.publicOrigin, 'X-Research-Participant': token!, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) }, body: bytes });
      assert.equal(uploaded.status, 200); assert.deepEqual(await uploaded.json(), { state: 'available' });
      await guest.mutation(ref<'mutation'>('capture:stop'), { token });
      selections.push({ sessionId: invitation.sessionId, id: media.id, kind: 'screen-observation', start: 100, end: 101 });
      receipt.fixture = { ...scope, sessionId: invitation.sessionId, sourceId: source._id, mediaId: media.id };
    });
    let analysisId: string;
    const request = { ...scope!, requestId: `analysis-${id}`, reservationId: reservation.id, selections };
    await check('native selected evidence analysis binds fake frame and exact one-time request', async () => {
      const response = await post('/analysis', request, true); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.state, 'ready'); analysisId = result.analysisId;
      const repeated = await post('/analysis', request, true); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).analysisId, analysisId); assert.equal(generated, 1); assert.equal(extracted, 1);
      const row = await operator.query(ref<'query'>('researchAnalysis:read'), { ...scope!, analysisId }); assert.equal(row.receipt.classification, 'offline-fixture'); assert.equal(row.receipt.maxOutputTokens, 1024); assert.equal(row.receipt.frames.length, 1); assert.equal(row.receipt.frames[0].atMs, 100);
      receipt.analysisId = analysisId;
    });
    const analysisScope = { ...scope!, analysisId: analysisId! };
    const rawGrants = [{ evidenceId: evidenceId(selections[0]), view: true, download: false }, { evidenceId: evidenceId(selections[1]), view: true, download: false }];
    let reviewRevision: number;
    await check('private review allowed incomplete but preview refuses uncovered citations', async () => {
      const row = await operator.query(ref<'query'>('researchAnalysis:read'), analysisScope);
      reviewRevision = await operator.mutation(ref<'mutation'>('researchAnalysis:saveReview'), { ...analysisScope, expectedRevision: row.revision, findings: row.findings, excerpts: [] });
      await assert.rejects(operator.query(ref<'query'>('researchReports:preview'), { ...analysisScope, reviewRevision, title: 'Synthetic fixture uncovered', grants: [] }));
      const reviewed = await operator.query(ref<'query'>('researchAnalysis:read'), analysisScope);
      reviewRevision = await operator.mutation(ref<'mutation'>('researchAnalysis:saveReview'), { ...analysisScope, expectedRevision: reviewed.revision, findings: reviewed.findings, excerpts: [{ evidenceId: evidenceId(selections[0]), text: reviewed.evidence[0].text }] });
    });
    async function publish(label: string) {
      const previousPhase = phase;
      phase = `preview ${label}`;
      const args = { ...analysisScope, reviewRevision: reviewRevision!, title: `Synthetic offline fixture · ${label}`, grants: rawGrants };
      const preview = await operator.query(ref<'query'>('researchReports:preview'), args);
      await assert.rejects(operator.mutation(ref<'mutation'>('researchReports:publish'), { ...args, previewHash: '0'.repeat(64), requestId: `wrong-${label}-${id}` }));
      phase = `publish ${label}`;
      const publication = await operator.mutation(ref<'mutation'>('researchReports:publish'), { ...args, previewHash: preview.previewHash, requestId: `publish-${label}-${id}` });
      phase = `share ${label}`;
      const response = await post('/shares', { ...scope!, reportId: publication.reportId, requestId: `share-${label}-${id}`, password: fixturePassword }, true); assert.equal(response.status, 200); const share = await response.json();
      phase = previousPhase; return { preview, publication, share };
    }
    async function unlock(slug: string) {
      const response = await post('/portal/unlock', { slug, password: fixturePassword }); assert.equal(response.status, 200);
      const setCookie = response.headers.get('set-cookie')!; assert(setCookie.includes('HttpOnly')); assert(setCookie.includes('SameSite=Strict')); assert(setCookie.includes('Path=/api/research/portal')); await response.body?.cancel();
      return setCookie.split(';')[0];
    }
    await check('exact preview publication portal aliases password and separate raw permissions', async () => {
      const { preview, publication, share } = await publish('permissions');
      const wrong = await post('/portal/unlock', { slug: share.slug, password: 'synthetic-wrong-password' }); assert.equal(wrong.status, 401); assert.equal(wrong.headers.get('set-cookie'), null); await wrong.body?.cancel();
      let cookie = await unlock(share.slug);
      const response = await apiFetch(`/portal/report?slug=${share.slug}`, {}, cookie); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0'); const report = await response.json();
      const projection = clientProjection(preview); for (const key of ['title', 'findings', 'excerpts', 'grants']) assert.deepEqual(report[key], projection[key as keyof typeof projection]);
      assert(report.evidence.every((e: { evidenceId: string; sessionLabel: string }) => /^e\d+$/.test(e.evidenceId) && e.sessionLabel === 'Session 1'));
      const mismatch = await apiFetch('/portal/report?slug=' + '0'.repeat(32), {}, cookie); assert.equal(mismatch.status, 409); await mismatch.body?.cancel();
      const source = await apiFetch(`/portal/source/e1?slug=${share.slug}&intent=view`, {}, cookie); assert.equal(source.status, 200); assert.equal(await source.text(), 'I could not find the delivery cost.');
      const download = await apiFetch(`/portal/source/e1?slug=${share.slug}&intent=download`, {}, cookie); assert.equal(download.status, 409); await download.body?.cancel();
      const range = await apiFetch(`/portal/source/e2?slug=${share.slug}&intent=view`, { headers: { Range: 'bytes=10-29' } }, cookie); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 20);
      await assert.rejects(operator.mutation(ref<'mutation'>('researchPortal:updateGrants'), { ...scope!, shareId: share.shareId, expectedRevision: 0, grants: [] }));
      const next = await operator.mutation(ref<'mutation'>('researchPortal:updateGrants'), { ...scope!, shareId: share.shareId, expectedRevision: 0, grants: [rawGrants[1]] }); assert.equal(next, 1);
      const oldSession = await apiFetch(`/portal/report?slug=${share.slug}`, {}, cookie); assert.equal(oldSession.status, 409); await oldSession.body?.cancel(); cookie = await unlock(share.slug);
      const removed = await apiFetch(`/portal/source/e1?slug=${share.slug}&intent=view`, {}, cookie); assert.equal(removed.status, 409); await removed.body?.cancel();
      await operator.mutation(ref<'mutation'>('researchPortal:revokeShare'), { ...scope!, shareId: share.shareId, expectedRevision: 1 });
      const revoked = await apiFetch(`/portal/report?slug=${share.slug}`, {}, cookie); assert.equal(revoked.status, 409); await revoked.body?.cancel();
      receipt.permissionsReportId = publication.reportId;
    });
    await check('report withdrawal immediately denies retained viewer cookie', async () => {
      const { publication, share } = await publish('withdrawal'); const cookie = await unlock(share.slug);
      await operator.mutation(ref<'mutation'>('researchReports:withdraw'), { ...scope!, reportId: publication.reportId });
      const response = await apiFetch(`/portal/report?slug=${share.slug}`, {}, cookie); assert.equal(response.status, 409); await response.body?.cancel();
      const reopened = await post('/portal/unlock', { slug: share.slug, password: fixturePassword }); assert.equal(reopened.status, 401); await reopened.body?.cancel();
      receipt.withdrawnReportId = publication.reportId;
    });
    const browser = await publish('rendered-acceptance');
    receipt.browser = { reportId: browser.publication.reportId, shareId: browser.share.shareId, slug: browser.share.slug, url: browser.share.url, preview: clientProjection(browser.preview) };
    receipt.state = 'native-passed-browser-pending'; delete receipt.phase; await save();
    console.log(JSON.stringify({ state: receipt.state, checks: checks.length, evidence: output, browserUrl: browser.share.url, fixtureClientId: scope!.clientId, fixtureProjectId: scope!.projectId }));
    if (process.argv.includes('--serve-for-browser')) await new Promise<void>(resolveDone => { process.once('SIGINT', resolveDone); process.once('SIGTERM', resolveDone); });
  } catch (error) {
    const detail = error as { name?: string; actual?: unknown; expected?: unknown };
    receipt.state = 'failed'; receipt.failure = { phase, code: 'native-boundary-check-failed', name: detail.name, ...(typeof detail.actual === 'number' ? { actual: detail.actual } : {}), ...(typeof detail.expected === 'number' ? { expected: detail.expected } : {}) }; process.exitCode = 1;
  } finally {
    if (receipt.state === 'failed' && token) {
      try { const current = await guest.query(ref<'query'>('participant:resume'), { token }); await guest.mutation(ref<'mutation'>('capture:changeConsent'), { token, expectedRevision: current.revision, consent: { ...consent, storage: false } }); receipt.failureCleanupWithdrawalConfirmed = true; }
      catch { receipt.failureCleanupWithdrawalConfirmed = false; }
    }
    try { await runtime?.close(); receipt.ownedGatewayStopped = true; } catch { receipt.ownedGatewayStopped = false; }
    if (bearer) { try { await operator.action(ref<'action'>('auth:signOut'), {}); receipt.operatorSignedOut = true; } catch { receipt.operatorSignedOut = false; } }
    globalThis.fetch = nativeFetch; receipt.finishedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ state: receipt.state, checks: checks.length, evidence: output, failure: receipt.failure }));
  }
}
void main().catch(() => { console.error('Reports acceptance preflight failed; private error withheld.'); process.exitCode = 1; });
