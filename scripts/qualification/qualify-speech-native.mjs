/** Root-only synthetic native HTTP/WS qualification. No browser microphone or auto retries. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadEnvFile } from 'node:process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { runtimeProvider } from '../../.qualification-build/packages/clinic-api/src/runtime.js';
import { createClinicHandler } from '../../.qualification-build/packages/clinic-api/src/handler.js';
import { createSpeechAccess } from '../../.qualification-build/packages/clinic-api/src/speech-access.js';
import { createProviderAdmission, noUnits } from '../../.qualification-build/packages/clinic-api/src/provider-admission.js';
import { speechAdmission } from '../../.qualification-build/packages/clinic-api/src/bounded-providers.js';
import { createNodeSpeechTransport } from '../../.qualification-build/apps/clinic-server/src/speech.js';
import { nodeHttpHandler } from '../../.qualification-build/apps/clinic-server/src/http.js';
import { createVoiceDraft, reduceVoiceDraft, voiceTurnInput } from '../../.qualification-build/packages/speech/src/turn.js';

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const id = arg('--id'), envPath = arg('--env');
assert(/^SP-N[1-9][0-9]*$/.test(id ?? ''), 'unique qualification ID required');
assert(envPath && isAbsolute(envPath) && !(statSync(envPath).mode & 0o077), 'private absolute env file required');
assert(readFileSync('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md', 'utf8').includes(`| ${id} /`), 'shared reservation required');
assert(!(statSync('infra/local/.clinic-config.json').mode & 0o077), 'private clinic config required');
const config = JSON.parse(readFileSync('infra/local/.clinic-config.json', 'utf8'));
assert(['localhost', '127.0.0.1'].includes(new URL(config.medplumBaseUrl).hostname), 'local synthetic Medplum only');
const prior = JSON.parse(readFileSync('docs/implementation/evidence/SP-Q1.json', 'utf8'));
const mp3 = readFileSync('.qualification-build/speech/SP-Q1.mp3');
assert.equal(createHash('sha256').update(mp3).digest('hex'), prior.operations[0].sha256, 'retain original synthetic fixture identity');
const decoded = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { input: mp3, maxBuffer: 2_000_000 });
assert.equal(decoded.status, 0, 'local fixture decode required');
const pcm = decoded.stdout;
assert(pcm.length > 0 && pcm.length < 1_800_000, 'bounded synthetic PCM required');
loadEnvFile(envPath);
assert(process.env.DEEPGRAM_API_KEY && process.env.ELEVENLABS_API_KEY, 'speech keys required');
const report = { id, startedAt: new Date().toISOString(), state: 'reserved', noRetries: true, syntheticOnly: true, actualBrowserMicrophone: false, reservation: { elevenlabsCharacters: 1200, deepgramCreditsUsd: 0.05, deepgramSeconds: 60, cashUsd: 0 }, operations: [], checks: [] };
const path = `docs/implementation/evidence/${id}.json`;
writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const save = () => writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
const units = (extra) => ({ ...noUnits(), requests: 1, ...extra });
const limit = (u, leaseMs) => ({ account: u, session: u, concurrency: 1, leaseMs });
const policy = { id, limits: { digitalocean: limit(noUnits(), 20000), deepgram: limit(units({ audioSeconds: 60 }), 70000), elevenlabs: limit(units({ characters: 1200 }), 35000) } };
const runtime = runtimeProvider(config, fetch);
const admission = createProviderAdmission(async () => (await runtime()).client, policy);
const access = createSpeechAccess(config, { runtime, enabled: true, adaptiveAvailable: false });
let ttsCalls = 0, sttCalls = 0;
const transport = createNodeSpeechTransport({ access, admission: speechAdmission(admission), deepgramApiKey: process.env.DEEPGRAM_API_KEY, elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
  fetcher: async (url, init) => {
    assert.equal(++ttsCalls, 1, 'one TTS dispatch only');
    const operation = { provider: 'elevenlabs', state: 'dispatched', dispatchedAt: new Date().toISOString() };
    report.operations.push(operation); save();
    const response = await fetch(url, init);
    operation.httpStatus = response.status; operation.requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id'); operation.state = 'headers-received'; save();
    return response;
  },
  connect: (url, options) => {
    assert.equal(++sttCalls, 1, 'one STT dispatch only');
    report.operations.push({ provider: 'deepgram', state: 'dispatched', dispatchedAt: new Date().toISOString() }); save();
    return new WebSocket(url, options);
  },
});
const handler = createClinicHandler(config, { runtime, speechEnabled: true });
const server = createServer(nodeHttpHandler(async request => await transport.handle(request) ?? await handler(request)));
server.on('upgrade', (request, socket, head) => void transport.upgrade(request, socket, head).catch(() => socket.destroy()));
let ws, cookie = '';
try {
  const entitlement = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(entitlement.status, 200);
  const sub = await entitlement.json();
  assert(sub.tier === 'free' && !sub.can_extend_character_limit && sub.character_limit - sub.character_count >= 1450, 'free allowance including unreconciled prior reservation required');
  report.elevenlabsBefore = { tier: sub.tier, used: sub.character_count, limit: sub.character_limit, canExtend: sub.can_extend_character_limit }; save();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body, headers = {}) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin: config.origin, cookie, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const nextCookie = response.headers.get('set-cookie'); if (nextCookie) cookie = nextCookie.split(';')[0];
    return response;
  }
  assert.equal((await request('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true })).status, 201);
  const confirmed = await request('/api/clinic/confirm-identity', { confirmed: true }); assert.equal(confirmed.status, 200);
  const session = await confirmed.json(); report.sessionId = session.id; report.prompt = session.currentPrompt; save();
  const out = { requestId: crypto.randomUUID(), sessionId: session.id, expectedRevision: session.revision, sourceId: session.currentPrompt.id };
  assert.equal((await request('/api/clinic/speech/output', out, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal(ttsCalls, 0); report.checks.push('cross-origin TTS denied before provider'); save();
  const started = performance.now(), audio = await request('/api/clinic/speech/output', out);
  assert.equal(audio.status, 200); assert(audio.headers.get('content-type')?.startsWith('audio/mpeg'));
  const reader = audio.body.getReader(); let bytes = 0, chunks = 0, firstChunkMs;
  for (;;) { const { done, value } = await reader.read(); if (done) break; firstChunkMs ??= Math.round(performance.now() - started); bytes += value.byteLength; chunks++; assert(bytes <= 600000); }
  assert(bytes > 0); report.tts = { characters: session.currentPrompt.text.length, firstChunkMs, completeMs: Math.round(performance.now() - started), bytes, chunks, audiblePlaybackMeasured: false }; save();
  // Duplicate uses the same request ID; durable admission must deny it without another provider request.
  const duplicate = await request('/api/clinic/speech/output', out); assert(duplicate.status >= 400); assert.equal(ttsCalls, 1); report.checks.push('TTS duplicate denied without redispatch');
  const events = [], connectedAt = performance.now(); let firstFinalMs;
  ws = new WebSocket(base.replace('http:', 'ws:') + '/api/clinic/speech/input', { headers: { origin: config.origin, cookie }, handshakeTimeout: 5000 });
  ws.on('error', () => undefined);
  const ended = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('bounded-stt-timeout')); }, 65000);
    ws.on('message', raw => { const event = JSON.parse(raw.toString()); events.push(event); if (event.type === 'recognition' && event.segment.isFinal) firstFinalMs ??= Math.round(performance.now() - connectedAt); if (event.type === 'error') { clearTimeout(timeout); reject(new Error('provider-speech-error')); } if (event.type === 'ended') { clearTimeout(timeout); resolve(event); } });
    ws.on('close', () => { clearTimeout(timeout); if (!events.some(event => event.type === 'ended')) reject(new Error('stt-closed-without-receipt')); });
  });
  // Attach immediately so an early socket error cannot become an unhandled promise rejection.
  ended.catch(() => undefined);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'start', requestId: crypto.randomUUID(), sessionId: session.id, promptId: session.currentPrompt.id, expectedRevision: session.revision }));
  const readyDeadline = Date.now() + 15000;
  while (!events.some(event => event.type === 'ready') && ws.readyState === WebSocket.OPEN && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  const ready = events.find(event => event.type === 'ready'); assert(ready && ready.maxCaptureMs > pcm.length / 32);
  for (let offset = 0; offset < pcm.length; offset += 3200) { assert.equal(ws.readyState, WebSocket.OPEN); ws.send(pcm.subarray(offset, offset + 3200)); await new Promise(resolve => setTimeout(resolve, 100)); }
  ws.send(JSON.stringify({ type: 'finish' }));
  const end = await ended; assert.equal(end.outcome, 'completed');
  const answerId = crypto.randomUUID();
  let voiceDraft = createVoiceDraft({ requestId: answerId, sessionId: session.id, promptId: session.currentPrompt.id, expectedRevision: session.revision });
  for (const event of events) if (event.type === 'recognition') voiceDraft = reduceVoiceDraft(voiceDraft, { type: 'recognition', generation: voiceDraft.generation, segment: event.segment });
  voiceDraft = reduceVoiceDraft(voiceDraft, { type: 'finish' });
  const text = voiceDraft.text;
  assert(text.length > 0); report.stt = { audioBytes: pcm.length, audioSeconds: pcm.length / 32000, readyMs: ready.maxCaptureMs, firstFinalMs, totalMs: Math.round(performance.now() - connectedAt), transcript: text, expectedText: prior.syntheticText, events }; save();
  const afterSpeech = await (await request('/api/clinic/session')).json(); assert.equal(afterSpeech.revision, session.revision); report.checks.push('recognition alone did not persist an answer');
  // Session recovery deliberately returns to the identity screen; reconfirm before a mutation.
  assert.equal((await request('/api/clinic/confirm-identity', { confirmed: true })).status, 200);
  const normalize = value => value.toLowerCase().replace(/two hundred thirty[ -]five/g, '235').replace(/two hundred thirty/g, '230').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(normalize(text), normalize(prior.syntheticText), 'synthetic transcript must match the known fixture before test submission');
  voiceDraft = reduceVoiceDraft(voiceDraft, { type: 'send' });
  const reviewedInput = { ...voiceTurnInput(voiceDraft), channel: 'confirmed-transcript' };
  report.answerAttempt = { requestId: answerId, expectedRevision: session.revision, promptId: session.currentPrompt.id, state: 'intent-recorded' }; save();
  const sent = await request('/api/clinic/turns', reviewedInput); report.answerAttempt.httpStatus = sent.status; save(); assert.equal(sent.status, 200); const saved = await sent.json();
  assert(saved.turns.some(turn => turn.role === 'patient' && turn.text.endsWith(`: ${text}`) && turn.channel === 'confirmed-transcript'));
  const replay = await request('/api/clinic/turns', reviewedInput); assert.equal(replay.status, 200); assert.equal((await replay.json()).revision, saved.revision);
  report.checks.push('fixture-matching synthetic transcript explicitly submitted once with source channel; same answer ID replay did not duplicate');
  report.answerAttempt.state = 'saved-and-deduplicated'; save();
  assert.equal(ttsCalls, 1); assert.equal(sttCalls, 1);
  report.state = 'native-path-received-needs-transcription-review';
} catch (error) {
  report.state = 'failed-or-unresolved'; report.errorCode = error instanceof assert.AssertionError ? 'qualification-assertion' : /^[a-z-]+$/.test(error?.message ?? '') ? error.message : 'qualification-error'; process.exitCode = 1;
} finally {
  ws?.terminate(); transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()));
  report.finishedAt = new Date().toISOString(); report.providerCalls = { tts: ttsCalls, stt: sttCalls }; save();
  console.log(JSON.stringify({ receipt: path, state: report.state, providerCalls: report.providerCalls, checks: report.checks, errorCode: report.errorCode, tts: report.tts, stt: report.stt ? { firstFinalMs: report.stt.firstFinalMs, totalMs: report.stt.totalMs, audioSeconds: report.stt.audioSeconds, transcript: report.stt.transcript } : undefined }));
}
