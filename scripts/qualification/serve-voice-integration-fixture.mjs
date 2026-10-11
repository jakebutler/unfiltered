/** Isolated development fixture. Real loopback Medplum; no external providers or microphone. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket, { WebSocketServer } from 'ws';
import { fixtureFetchDiagnostics, fixtureAdmissionDiagnostics } from './voice-fixture-diagnostics.mjs';

assert(process.argv.slice(2).every(argument => argument === '--choice-tail'), 'only the disclosed choice-tail mode is supported');
const choiceTail = process.argv.includes('--choice-tail');
// The original fixture keeps its historical build and receipts. New source is
// emitted separately; this mode never imports or overwrites qualification-build.
const buildRoot = choiceTail ? '../../.voice-choice-build/' : '../../.qualification-build/';
const compiled = path => import(new URL(buildRoot + path, import.meta.url));
const { runtimeProvider } = await compiled('packages/clinic-api/src/runtime.js');
const { createClinicHandler } = await compiled('packages/clinic-api/src/handler.js');
const { createSpeechAccess } = await compiled('packages/clinic-api/src/speech-access.js');
const { createProviderAdmission, noUnits } = await compiled('packages/clinic-api/src/provider-admission.js');
const { speechAdmission } = await compiled('packages/clinic-api/src/bounded-providers.js');
const { readDraft } = await compiled('packages/clinic-api/src/store.js');
const { createNodeSpeechTransport } = await compiled('apps/clinic-server/src/speech.js');
const { nodeHttpHandler } = await compiled('apps/clinic-server/src/http.js');
const { conversation } = await compiled('packages/clinic-api/src/conversation.js');

const sourcePath = 'infra/local/.clinic-config.json';
assert(!(statSync(sourcePath).mode & 0o077), 'private local config required');
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
assert(['localhost', '127.0.0.1'].includes(new URL(source.medplumBaseUrl).hostname), 'loopback Medplum only');
const id = (choiceTail ? 'SP-F3-' : 'SP-F2-') + randomUUID(), origin = 'http://localhost:5190';
// localhost isolates this cookie from the ordinary 127.0.0.1 clinic demo.
const config = { ...source, origin, cookieSecret: randomBytes(48).toString('base64url') };
const outputDirectory = choiceTail ? `.voice-choice-build/receipts/${id}` : '.qualification-build/voice-integration';
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const receiptPath = `${outputDirectory}/${id}.json`;
writeFileSync(`${outputDirectory}/config.json`, JSON.stringify(config), { mode: 0o600 });
const report = { id, mode: choiceTail ? 'choice-tail' : 'original', startedAt: new Date().toISOString(), syntheticOnly: true, externalProviderRequests: 0, microphoneRequested: false, origin, policyId: id, requests: [], stt: [], tts: [], interpretations: [], controls: [] };
const saveReport = () => writeFileSync(receiptPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
saveReport();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
report.eventLoop = { resolutionMs: 20, samples: 0, maximumDelayMs: 0 };
const eventLoopTimer = setInterval(() => {
  report.eventLoop.samples++;
  report.eventLoop.maximumDelayMs = Math.max(report.eventLoop.maximumDelayMs, Math.round(eventLoop.max / 1e6));
  report.eventLoop.lastSampleAt = new Date().toISOString();
  eventLoop.reset(); saveReport();
}, 5000).unref();
const localFetch = fixtureFetchDiagnostics(config.medplumBaseUrl, report, saveReport);
const runtime = runtimeProvider(config, localFetch);
const units = extra => ({ ...noUnits(), ...extra });
const bound = (value, leaseMs) => ({ account: value, session: value, concurrency: 1, leaseMs });
const policy = { id, limits: {
  digitalocean: bound(units({ requests: choiceTail ? 4 : 10, inputBytes: choiceTail ? 524288 : 10000, outputTokens: choiceTail ? 16384 : 10240 }), choiceTail ? 60000 : 20000),
  deepgram: bound(units({ requests: choiceTail ? 40 : 12, audioSeconds: choiceTail ? 1200 : 720 }), 70000),
  elevenlabs: bound(units({ requests: choiceTail ? 40 : 10, characters: choiceTail ? 24000 : 12000 }), 35000),
} };
const admission = fixtureAdmissionDiagnostics(createProviderAdmission(async () => (await runtime()).client, policy), report, saveReport);
const access = createSpeechAccess(config, { runtime, enabled: true, adaptiveAvailable: true });
const phrases = [
  'I want more energy for walks with my family.',
  'My priority is playing outside with my children.',
  'I do not have any specific symptoms to discuss today.',
];
let fullFixture, fullTransport, compactDraft, heldTail;
if (choiceTail) {
  assert.equal(config.mentalHealth, 'phq4', 'the exact approved PHQ-4 local configuration is required');
  const content = conversation(config);
  phrases.push(...content.register.mentalHealthOption.choices.map(choice => choice.label), 'Yes', 'Confirm', 'No', 'Retry', 'Switch to text', 'Stop', 'I am fine', 'All zeros', 'I may hurt myself tonight.');
  fullFixture = await compiled('scripts/qualification/fixtures/adaptive-full-development.js');
  phrases.push(fullFixture.fullDevelopmentSource.text);
  const fullModule = await compiled('packages/clinic-api/src/adaptive-reply-full-compact.js');
  fullTransport = fullModule.fullCompactStreamProposer;
  compactDraft = fullModule.encodeFullCompactDraft;
}
report.disclosedUtterances = phrases; saveReport();
let armed = 0;
const fakeStt = new WebSocketServer({ host: '127.0.0.1', port: 8791, maxPayload: 16384 });
await once(fakeStt, 'listening');
fakeStt.on('connection', socket => {
  const item = { id: randomUUID(), openedAt: new Date().toISOString(), pcmBytes: 0, frames: 0, signalled: false, results: 0, closeStream: false };
  report.stt.push(item); saveReport();
  let finalTimer, phrase;
  socket.on('message', (data, binary) => {
    if (!binary) {
      assert.equal(JSON.parse(data.toString()).type, 'CloseStream'); item.closeStream = true; saveReport();
      socket.close(1000, 'synthetic-completed'); return;
    }
    item.pcmBytes += data.length; item.frames++;
    let active = false;
    for (let offset = 0; offset + 1 < data.length; offset += 2) if (Math.abs(data.readInt16LE(offset)) > 300) { active = true; break; }
    if (active && item.results === 0) {
      if (!item.signalled) {
        item.signalled = true; phrase = phrases[armed];
        socket.send(JSON.stringify({ type: 'SpeechStarted' }));
      }
      clearTimeout(finalTimer);
      finalTimer = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN || item.results) return;
        item.results++; item.text = phrase;
        socket.send(JSON.stringify({ type: 'Results', start: 0, duration: .45, is_final: true, speech_final: true, channel: { alternatives: [{ transcript: phrase }] } }));
        saveReport();
      }, 320);
    }
  });
  socket.once('close', (code) => { clearTimeout(finalTimer); item.closedAt = new Date().toISOString(); item.closeCode = code; saveReport(); });
  socket.on('error', () => undefined);
});
const encoded = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8:sample_rate=22050', '-af', 'volume=0.08', '-f', 'mp3', '-b:a', '32k', 'pipe:1'], { maxBuffer: 600000 });
assert.equal(encoded.status, 0, 'local tone encoding must succeed');
const mp3 = encoded.stdout;
const transport = createNodeSpeechTransport({ access, admission: speechAdmission(admission), deepgramApiKey: 'offline-fixture-no-key', elevenlabsApiKey: 'offline-fixture-no-key',
  connect(url) { assert.equal(new URL(url).hostname, 'api.deepgram.com'); return new WebSocket('ws://127.0.0.1:8791'); },
  async fetcher(url, init) {
    assert.equal(new URL(url).hostname, 'api.elevenlabs.io');
    const body = JSON.parse(init.body), item = { id: randomUUID(), text: body.text, bytes: 0, chunks: 0, canceled: false, startedAt: new Date().toISOString() };
    report.tts.push(item); saveReport();
    let offset = 0, canceled = false;
    const stream = new ReadableStream({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 80));
        if (canceled) return;
        if (offset >= mp3.length) { controller.close(); item.finishedAt = new Date().toISOString(); saveReport(); return; }
        const chunk = mp3.subarray(offset, offset + 2048); offset += chunk.length; item.bytes += chunk.length; item.chunks++;
        controller.enqueue(chunk);
      },
      cancel() { canceled = true; item.canceled = true; saveReport(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'audio/mpeg' } });
  },
});
const proposer = { async propose(context) {
  const lease = await admission.reserve({ provider: 'digitalocean', sessionId: context.binding.sessionId, requestId: context.binding.operationId, units: units({ requests: 1, inputBytes: 1000, outputTokens: 1024 }) });
  const index = phrases.indexOf(context.source.text);
  const item = { operationId: context.binding.operationId, sourceId: context.source.id, text: context.source.text, fixture: index, at: new Date().toISOString() };
  report.interpretations.push(item); saveReport();
  await lease.settle(index < 0 ? 'failed' : 'completed');
  assert(index >= 0, 'only exact disclosed synthetic utterances are interpreted');
  const [topicId, path, state] = index === 0 ? ['Q01', 'reason', 'known'] : index === 1 ? ['Q01', 'priority', 'known'] : ['Q02', 'concern', 'negative'];
  return { proposal: { schema: 1, facts: [{ topicId, path, state, transform: 'verbatim', evidence: [{ sourceId: context.source.id, start: 0, end: context.source.text.length }] }], newItems: [], completedLists: [], acts: [] }, receipt: { model: 'offline-deterministic-fixture', requestId: randomUUID() } };
} };
const streamProposer = choiceTail ? { async propose(context, manifest, run) {
  assert(phrases.includes(context.source.text), 'only exact disclosed synthetic utterances are interpreted');
  const item = { operationId: context.binding.operationId, sessionId: context.binding.sessionId, sourceId: context.source.id, text: context.source.text, at: new Date().toISOString(), syntheticTransport: true };
  report.interpretations.push(item); saveReport();
  const lease = await admission.reserve({ provider: 'digitalocean', sessionId: context.binding.sessionId, requestId: context.binding.operationId, units: units({ requests: 1, inputBytes: 131072, outputTokens: 4096 }) });
  const event = (content, finish = null) => `data: ${JSON.stringify({ id: item.operationId, model: 'qwen3.8-max', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
  const injectedFetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)), payload = JSON.parse(body.messages[1].content);
    const full = { id: payload.manifestId, messages: body.messages, targets: payload.targets };
    const isAuthoredFull = context.source.text === fullFixture.fullDevelopmentSource.text;
    const draft = isAuthoredFull ? fullFixture.representativeFullDraft(full) : { manifestId: full.id, claims: [], items: [], closures: [], acts: [], residual: payload.statements.map(statement => ({ evidence: [{ statementId: statement.id, quote: statement.text }], reason: 'ambiguous' })), sourceDisposition: 'partially-represented' };
    const advance = { manifestId: full.id, actionId: payload.actions.at(-1).id, controls: [], defer: [] };
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(event('{"advance":' + JSON.stringify(advance) + ',"draft":')));
      item.advanceEmittedAt = new Date().toISOString(); item.tail = isAuthoredFull ? 'held' : 'immediate'; saveReport();
      const finish = () => { controller.enqueue(encoder.encode(event(JSON.stringify(compactDraft(draft)) + '}') + event(null, 'stop') + 'data: [DONE]\n\n')); controller.close(); item.tail = 'released'; item.tailReleasedAt = new Date().toISOString(); saveReport(); };
      if (isAuthoredFull) { assert(!heldTail, 'only one held synthetic tail is allowed'); heldTail = { sessionId: context.binding.sessionId, operationId: item.operationId, finish, cancel() { controller.error(new Error('synthetic-fixture-stopped')); item.tail = 'canceled'; saveReport(); } }; }
      else finish();
    }, cancel() { if (heldTail?.operationId === item.operationId) heldTail = undefined; item.tail = 'canceled'; saveReport(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const result = await fullTransport({ endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', apiKey: 'offline-fixture-no-key', timeoutMs: 12000, maxOutputTokens: 4096, maxRequestBytes: 131072 }, { fetcher: injectedFetch }).propose(context, manifest, run);
    await lease.settle('completed'); return result;
  } catch (error) { await lease.settle('failed'); throw error; }
} } : undefined;
const handler = createClinicHandler(config, { runtime, adaptiveProposer: proposer, ...(choiceTail ? { adaptiveStreamProposer: streamProposer, adaptiveFullCapture: true, adaptiveTimeoutMs: 15000 } : {}), speechEnabled: true, fetcher: localFetch });
const server = createServer(nodeHttpHandler(async request => {
  const path = new URL(request.url).pathname;
  const started = performance.now();
  if (path === '/api/fixture/config' && request.method === 'GET') return Response.json({ id, mode: report.mode, phrases, syntheticOnly: true, externalProviderRequests: 0 }, { headers: { 'Cache-Control': 'no-store' } });
  if (path.startsWith('/api/fixture/')) {
    try {
      assert.equal(request.method, 'POST');
      const claims = await access.authenticate(request);
      if (path === '/api/fixture/control') {
        const input = await request.json();
        assert((choiceTail ? ['pulse', 'disconnect', 'prepare-phq', 'prepare-height', 'release-tail'] : ['pulse', 'disconnect']).includes(input.action)); assert(Number.isInteger(input.phrase) && input.phrase >= 0 && input.phrase < phrases.length);
        report.controls.push({ action: input.action, phrase: input.phrase, at: new Date().toISOString() });
        if (input.action === 'pulse') armed = input.phrase;
        else if (input.action === 'disconnect') for (const socket of fakeStt.clients) socket.terminate();
        else if (input.action === 'release-tail') { assert.equal(heldTail?.sessionId, claims.sessionId); const tail = heldTail; heldTail = undefined; tail.finish(); }
        else {
          const { draft } = await readDraft((await runtime()).client, claims.sessionId, claims.patient);
          assert.equal(draft.scenario, 'first-intake');
          const response = await handler(new Request(origin + '/api/clinic/topics', { method: 'POST', headers: { Origin: origin, Cookie: request.headers.get('cookie') ?? '', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: draft.revision, ...(input.action === 'prepare-phq' ? { topicId: 'Q16', slotPath: 'MH01' } : { topicId: 'Q04' }) }) }));
          assert.equal(response.status, 200, 'fixture topic selection must pass the actual topics contract');
          report.preparedPrompt = (await response.json()).currentPrompt;
        }
      } else {
        assert.equal(path, '/api/fixture/report');
        const { draft } = await readDraft((await runtime()).client, claims.sessionId, claims.patient);
        report.durable = { sessionId: draft.id, phase: draft.phase, revision: draft.revision, turns: draft.turns, requests: Object.keys(draft.requests), operations: Object.values(draft.adaptive?.operations ?? {}).map(item => ({ id: item.id, sourceId: item.sourceId, status: item.status, ...(choiceTail ? { stream: item.stream, queuedWaiting: item.queuedWaiting } : {}) })), ...(choiceTail ? { topics: draft.topics, safety: draft.safety, exchange: draft.adaptive?.exchange } : {}), confirmed: !!draft.confirmed };
      }
      saveReport(); return Response.json(path.endsWith('/report') ? report : { accepted: true }, { headers: { 'Cache-Control': 'no-store' } });
    } catch { return Response.json({ error: 'fixture-control-denied' }, { status: 403 }); }
  }
  const response = await transport.handle(request) ?? await handler(request);
  report.requests.push({ path, method: request.method, status: response.status, durationMs: Math.round(performance.now() - started), at: new Date().toISOString() }); saveReport();
  return response;
}));
server.on('upgrade', (request, socket, head) => {
  const item = { at: new Date().toISOString(), path: request.url, originMatches: request.headers.origin === origin, cookiePresent: Boolean(request.headers.cookie) };
  (report.upgrades ??= []).push(item); saveReport();
  const started = performance.now();
  void transport.upgrade(request, socket, head).then(() => { item.returnedMs = Math.round(performance.now() - started); saveReport(); }).catch(() => { item.failed = true; item.returnedMs = Math.round(performance.now() - started); saveReport(); socket.destroy(); });
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(8790, '127.0.0.1'); await once(server, 'listening');
await runtime();
console.log(JSON.stringify({ fixture: id, url: origin + '/voice-integration-fixture.html', receiptPath, policy: 'separate durable local fake-provider budget', externalProviderRequests: 0 }));
function close() { clearInterval(eventLoopTimer); eventLoop.disable(); report.finishedAt = new Date().toISOString(); if (heldTail) { const tail = heldTail; heldTail = undefined; tail.cancel(); } saveReport(); transport.close(); for (const socket of fakeStt.clients) socket.terminate(); fakeStt.close(); server.closeAllConnections(); server.close(); }
process.once('SIGINT', close); process.once('SIGTERM', close);
setTimeout(close, 45 * 60 * 1000).unref();
