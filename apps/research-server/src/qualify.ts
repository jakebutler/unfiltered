/** Native local boundary qualification. Synthetic bytes, real Convex functions,
 * real HTTP child process and private filesystem. Never imported by the server. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { loadConfig, privateJson } from './config';
import { convexCaptureAuthority } from '../../../packages/research-capture/src/convex-authority';
import { LocalPrivateObjectStore } from '../../../packages/research-capture/src/local-store';
import { digest, validObjectKey } from '../../../packages/research-capture/src/contracts';
import { requireFreeListener } from './listener';

type Check = { name: string; passed: true; [key: string]: unknown };
async function main() {
  const arg = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  if (!process.argv.includes('--allow-local-synthetic-capture') || !arg('--config') || !arg('--operator') || !arg('--server') || !arg('--output')) throw new Error('Explicit local synthetic write flag, config, operator, server and output required');
  const configPath = resolve(arg('--config')!), config = await loadConfig(configPath);
  const serverPath = resolve(arg('--server')!), output = resolve(arg('--output')!);
  const credentials = await privateJson(resolve(arg('--operator')!)) as { email: string; password: string };
  if (typeof credentials.email !== 'string' || typeof credentials.password !== 'string' || !credentials.password) throw new Error('Private operator credentials required');
  const cancelled = new AbortController(), overall = AbortSignal.timeout(300_000);
  const signal = AbortSignal.any([cancelled.signal, overall]);
  const cancel = () => cancelled.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const transport: typeof fetch = (input, init) => {
    const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    if (![config.deployment, config.bindOrigin].includes(origin as typeof config.deployment)) throw new Error('Qualification target changed');
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]) });
  };
  const operator = new ConvexHttpClient(config.deployment, { logger: false, fetch: transport });
  const guest = new ConvexHttpClient(config.deployment, { logger: false, fetch: transport });
  const authority = convexCaptureAuthority(config.deployment, config.gatewaySecret, { signal });
  const store = new LocalPrivateObjectStore(config.objectDirectory);
  const checks: Check[] = [], id = randomUUID();
  let child: ChildProcess | undefined, phase = 'preflight', token: string | undefined, bearer: string | undefined;
  let scope: { clientId: string; projectId: string; sessionId: string } | undefined;
  let fullWithdrawal = false, revision = 1;
  const consent = { version: 'research-consent-1', storage: true, analysis: true, microphone: true, camera: true, screen: false, dom: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
  const receipt: Record<string, unknown> = { id, state: 'started', startedAt: new Date().toISOString(), scope: 'isolated-local-research-capture', syntheticBytes: true, realBrowserMedia: false, deployment: config.deployment, bindOrigin: config.bindOrigin, checks, cloudMutations: 0, providerCalls: 0, cash: 0 };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  const save = async () => { await writeFile(output, JSON.stringify(receipt, null, 2) + '\n'); };
  const check = async (name: string, fn: () => Promise<Record<string, unknown> | void>) => {
    phase = name; receipt.currentPhase = name; await save();
    const details = await fn(); checks.push({ name, passed: true, ...details }); await save();
  };
  const delay = async (ms: number) => {
    signal.throwIfAborted();
    await new Promise<void>((resolveWait, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('Qualification cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveWait(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  const poll = async (predicate: () => Promise<boolean>, maximumMs = 15_000) => {
    const deadline = Date.now() + maximumMs;
    while (!await predicate()) { if (Date.now() >= deadline) throw new Error('Bounded readback timed out'); await delay(500); }
  };
  const stop = async (crash = false) => {
    const current = child; child = undefined;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    await new Promise<void>((resolveExit, reject) => {
      const timeout = setTimeout(() => { current.kill('SIGKILL'); reject(new Error('Owned gateway did not exit')); }, 8000);
      current.once('exit', () => { clearTimeout(timeout); resolveExit(); });
      current.kill(crash ? 'SIGKILL' : 'SIGTERM');
    });
  };
  const start = async () => {
    // An occupied listener never becomes an owned process and is never terminated.
    await requireFreeListener(() => transport(`${config.bindOrigin}/capture/health`));
    child = spawn(process.execPath, ['--max-old-space-size=1024', serverPath, '--config', configPath], { stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' } });
    let startupError = false; child.once('error', () => { startupError = true; });
    await poll(async () => {
      if (startupError || child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Owned gateway startup failed');
      try { const response = await transport(`${config.bindOrigin}/capture/health`); return response.ok && (await response.json()).service === 'research-capture-local'; } catch { return false; }
    });
  };
  const mediaUrl = (mediaId: string, alternateScope = scope!) => `${config.bindOrigin}/capture/media/${mediaId}?${new URLSearchParams(alternateScope)}`;
  const request = (mediaId: string, init: RequestInit = {}, alternateScope = scope!) => transport(mediaUrl(mediaId, alternateScope), { ...init, headers: { Origin: config.publicOrigin, ...(init.headers as Record<string, string> ?? {}) } });
  const upload = (mediaId: string, bytes: Uint8Array) => request(mediaId, { method: 'PUT', headers: { 'X-Research-Participant': token!, 'Content-Length': String(bytes.length), 'Content-Type': 'application/octet-stream' }, body: bytes as BodyInit });
  const marker = async (key: string) => { validObjectKey(key); assert.equal(await readFile(join(config.objectDirectory, key.replaceAll('/', '_')), 'utf8'), 'null\n'); };
  try {
    assert(config.maxSegmentBytes >= 4_000_000, 'Native stream revocation proof needs a multi-chunk segment');
    phase = 'listener availability before synthetic mutations';
    await requireFreeListener(() => transport(`${config.bindOrigin}/capture/health`));
    await check('native operator login and synthetic participant consent', async () => {
      const login = await operator.action(ref<'action'>('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: credentials.email, password: credentials.password } });
      assert(login.tokens?.token); bearer = login.tokens.token; operator.setAuth(bearer!);
      const clientId = await operator.mutation(ref<'mutation'>('research:createClient'), { name: `Capture native ${id}` });
      const projectId = await operator.mutation(ref<'mutation'>('research:createProject'), { clientId, name: 'Synthetic capture boundary' });
      await operator.mutation(ref<'mutation'>('research:saveStudy'), { clientId, projectId, expectedRevision: 0, definition: { title: 'Synthetic capture qualification', introduction: 'No real participant or device.', goals: ['Private capture lifecycle'], script: [{ id: 'q1', question: 'Synthetic first question?' }], prototypeUrl: null, repository: null } });
      const invitation = await operator.action(ref<'action'>('invitations:create'), { clientId, projectId, studyVersion: 1, requestId: `capture-${id}` });
      assert(invitation.token); token = invitation.token; scope = { clientId, projectId, sessionId: invitation.sessionId };
      receipt.fixture = { ...scope, invitationId: invitation.invitationId };
      await guest.mutation(ref<'mutation'>('participant:agree'), { token, expectedRevision: 0, consent });
      await guest.mutation(ref<'mutation'>('capture:start'), { token });
    });
    const bytes = new Uint8Array(4096).map((_value, index) => index % 251), sha256 = await digest(bytes);
    const descriptor = { modality: 'camera', sequence: 0, startMs: 0, endMs: 1000, bytes: bytes.length, sha256, mime: 'video/webm', questionId: 'q1', sourceId: null };
    const media = await guest.mutation(ref<'mutation'>('capture:reserve'), { token, requestId: `retry-${id}`, descriptor });
    const original = await authority.inspect(token!, media.id);
    const capacityBefore = await guest.query(ref<'query'>('capture:status'), { token });
    await check('native reserve and incorrect checksum retain one recoverable logical segment', async () => {
      await start();
      const invalid = bytes.slice(); invalid[0] ^= 255;
      const failed = await upload(media.id, invalid); assert.equal(failed.status, 409); await failed.body?.cancel();
      const row = await authority.inspect(token!, media.id);
      assert.equal(row.state, 'uploading'); assert.equal(row.attempt, 0); assert.equal(await store.head(row.key), null);
      return { mediaId: media.id, attempt: row.attempt, nativePutStatus: failed.status };
    });
    await check('failed attempt survives gateway crash and rotates only after lease and old-key fence', async () => {
      const failed = await authority.inspect(token!, media.id);
      await stop(true);
      assert(failed.leaseUntil <= Date.now() + 60_000, 'Unexpected writer lease');
      await delay(Math.max(0, failed.leaseUntil + 250 - Date.now()));
      await start();
      const response = await request(media.id, { method: 'POST', headers: { 'X-Research-Participant': token! } });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { state: 'reserved', attempt: 1 });
      const successor = await authority.inspect(token!, media.id);
      assert.equal(successor.attempt, 1); assert.notEqual(successor.key, original.key); await marker(original.key);
      assert.equal(await authority.finalize(media.id, 0, { bytes: bytes.length, sha256, mime: 'video/webm' }), false);
      const same = await guest.mutation(ref<'mutation'>('capture:reserve'), { token, requestId: `retry-${id}`, descriptor });
      assert.equal(same.id, media.id); assert.equal(same.sourceId, media.sourceId);
      assert.equal((await guest.query(ref<'query'>('capture:status'), { token })).bytesRemaining, capacityBefore.bytesRemaining);
      const uploaded = await upload(media.id, bytes); assert.equal(uploaded.status, 200); assert.deepEqual(await uploaded.json(), { state: 'available' });
      return { gatewayCrashed: true, successorAttempt: 1, sourceIdentityPreserved: true, reservedBytesPreserved: true, staleFinalizeDenied: true };
    });
    await check('authenticated native read, byte range and isolation boundaries', async () => {
      const response = await request(media.id, { headers: { Authorization: `Bearer ${bearer}` } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.equal(await digest(new Uint8Array(await response.arrayBuffer())), sha256);
      const ranged = await request(media.id, { headers: { Authorization: `Bearer ${bearer}`, Range: 'bytes=10-29' } });
      assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), `bytes 10-29/${bytes.length}`); assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), bytes.slice(10, 30));
      const anonymous = await request(media.id); assert.equal(anonymous.status, 409); await anonymous.body?.cancel();
      const fetchMetadata = { 'Sec-Fetch-Site': 'same-origin', Referer: `${config.publicOrigin}/interview/synthetic` };
      const normalized = await transport(mediaUrl(media.id), { headers: { ...fetchMetadata, Authorization: `Bearer ${bearer}` } });
      assert.equal(normalized.status, 200); assert.equal(await digest(new Uint8Array(await normalized.arrayBuffer())), sha256);
      const wrongBearer = await transport(mediaUrl(media.id), { headers: { ...fetchMetadata, Authorization: 'Bearer synthetic-invalid-token' } });
      assert.equal(wrongBearer.status, 409); await wrongBearer.body?.cancel();
      const foreignClient = await operator.mutation(ref<'mutation'>('research:createClient'), { name: `Other capture client ${id}` });
      const foreign = await request(media.id, { headers: { Authorization: `Bearer ${bearer}` } }, { ...scope!, clientId: foreignClient }); assert.equal(foreign.status, 409); await foreign.body?.cancel();
      const wrongOrigin = await request(media.id, { headers: { Authorization: `Bearer ${bearer}`, Origin: 'http://127.0.0.1:9999' } }); assert.equal(wrongOrigin.status, 403); await wrongOrigin.body?.cancel();
      const reconcile = await request(media.id, { method: 'POST', headers: { 'X-Research-Participant': token! } }); assert.equal(reconcile.status, 200); assert.deepEqual(await reconcile.json(), { state: 'available' });
      return { authenticatedDigestMatches: true, rangeBytes: 20, anonymousDenied: true, otherClientDenied: true, wrongOriginDenied: true, missingOriginMetadataFacadeRead: true, normalizedWrongBearerDenied: true, reconciliationWithoutReupload: true };
    });
    let cameraKey = (await authority.inspect(token!, media.id)).key;
    await check('available bytes and authenticated read survive owned gateway restart', async () => {
      await stop(); await start();
      const response = await request(media.id, { headers: { Authorization: `Bearer ${bearer}` } }); assert.equal(response.status, 200);
      assert.equal(await digest(new Uint8Array(await response.arrayBuffer())), sha256);
      assert.equal((await authority.inspect(token!, media.id)).key, cameraKey);
    });
    const streamBytes = new Uint8Array(4_000_000).map((_value, index) => (index * 7) % 251), streamDigest = await digest(streamBytes);
    const stream = await guest.mutation(ref<'mutation'>('capture:reserve'), { token, requestId: `stream-${id}`, descriptor: { ...descriptor, modality: 'microphone', mime: 'audio/webm', bytes: streamBytes.length, sha256: streamDigest } });
    let microphoneKey = (await authority.inspect(token!, stream.id)).key;
    await check('withdrawal during actual HTTP body consumption ends the next protected chunks', async () => {
      const uploaded = await upload(stream.id, streamBytes); assert.equal(uploaded.status, 200); await uploaded.body?.cancel();
      // Native response streaming retains the gateway's backpressure and per-chunk
      // Convex reauthorization. No test hook or fake store delays the transport.
      const response = await request(stream.id, { headers: { Authorization: `Bearer ${bearer}` } }); assert.equal(response.status, 200); assert(response.body);
      const reader = response.body.getReader(); let received = 0, denied = false;
      try {
        const first = await reader.read(); assert(!first.done); received += first.value.length;
        await guest.mutation(ref<'mutation'>('capture:changeConsent'), { token, expectedRevision: revision++, consent: { ...consent, microphone: false } });
        try { while (true) { const next = await reader.read(); if (next.done) break; received += next.value.length; } } catch { denied = true; }
      } finally { await reader.cancel().catch(() => undefined); }
      assert(denied, 'Native stream completed after withdrawal'); assert(received > 0 && received < streamBytes.length, 'Revoked stream emitted every byte');
      const fresh = await request(stream.id, { headers: { Authorization: `Bearer ${bearer}` } }); assert.equal(fresh.status, 409); await fresh.body?.cancel();
      const retained = await request(media.id, { headers: { Authorization: `Bearer ${bearer}` } }); assert.equal(retained.status, 200); await retained.body?.cancel();
      return { receivedBytes: received, reservedBytes: streamBytes.length, bodyTerminated: true, subsequentReadDenied: true, stillConsentedCameraReadable: true };
    });
    await check('persisted withdrawal while gateway is offline is retired by startup cleanup', async () => {
      await stop();
      await guest.mutation(ref<'mutation'>('capture:changeConsent'), { token, expectedRevision: revision++, consent: { ...consent, microphone: false, storage: false } }); fullWithdrawal = true;
      await poll(async () => (await authority.cleanup()).some(row => row.id === media.id));
      const pending = await authority.cleanup(); assert(pending.some(row => row.id === media.id && row.key === cameraKey));
      assert(await store.head(cameraKey), 'Private camera bytes disappeared without their cleanup receipt');
      await start();
      await poll(async () => await store.head(cameraKey) === null && await store.head(microphoneKey) === null);
      await poll(async () => !(await authority.cleanup()).some(row => row.id === media.id || row.id === stream.id));
      await marker(cameraKey); await marker(microphoneKey); await marker(original.key);
      await assert.rejects(store.putIfAbsent(original.key, bytes, { bytes: bytes.length, sha256, mime: 'video/webm' }));
      await assert.rejects(store.putIfAbsent(cameraKey, bytes, { bytes: bytes.length, sha256, mime: 'video/webm' }));
      return { persistedIntentSeenWhileOffline: true, startupWorkerRetirementConfirmed: true, currentAndPriorAttemptMarkersPreserved: true, lateConditionalWritesDenied: true };
    });
    await check('retirement remains permanent after another gateway restart', async () => {
      await stop(); await start(); await marker(cameraKey); await marker(microphoneKey); await marker(original.key);
      assert.equal(await store.head(cameraKey), null); assert.equal(await store.head(microphoneKey), null);
      const denied = await request(media.id, { headers: { Authorization: `Bearer ${bearer}` } }); assert.equal(denied.status, 409); await denied.body?.cancel();
      return { persistedFilesystemRetirement: true, withdrawnNativeReadDenied: true };
    });
    receipt.state = 'passed';
  } catch {
    receipt.state = 'failed'; receipt.failure = { phase, code: signal.aborted ? 'cancelled-or-deadline' : 'native-boundary-check-failed' }; process.exitCode = 1;
  } finally {
    // No unconditional resubmission: unknown mutation results stop the proof.
    // A fresh bounded resume must establish the current revision before a
    // distinct cleanup withdrawal. Never replay the failed operation itself.
    if (token && !fullWithdrawal && !signal.aborted) {
      try {
        const resumed = await guest.query(ref<'query'>('participant:resume'), { token });
        await guest.mutation(ref<'mutation'>('capture:changeConsent'), { token, expectedRevision: resumed.revision, consent: { ...consent, storage: false } });
        receipt.failureCleanupWithdrawalConfirmed = true;
      } catch { receipt.failureCleanupWithdrawalConfirmed = false; }
    }
    try { await stop(); receipt.ownedGatewayStopped = true; } catch { receipt.ownedGatewayStopped = false; receipt.state = 'failed'; process.exitCode = 1; }
    if (bearer && !signal.aborted) { try { await operator.action(ref<'action'>('auth:signOut'), {}); receipt.operatorSignedOut = true; } catch { receipt.operatorSignedOut = false; } }
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    receipt.finishedAt = new Date().toISOString(); delete receipt.currentPhase; await save();
    console.log(JSON.stringify({ state: receipt.state, checks: checks.length, evidence: output, failure: receipt.failure }));
  }
}
void main().catch(() => { console.error('Capture qualification preflight failed; no secret-bearing error text emitted.'); process.exitCode = 1; });
