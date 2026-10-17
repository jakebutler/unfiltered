/** Root-only one-shot qualification. This module does nothing without an explicit CLI mode. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digitalOceanAnalysis, type AnalysisReservation } from '../src/analysis';
import { jpegDimensions } from '../src/frames';
import { candidate, validateVisionResult, visionEnvelope } from './prepare-vision';
import { DO_ENDPOINT, prepareDigitalOceanRequest, type DigitalOceanConfig } from '../../../packages/clinical-core/src/digitalocean';
import { TransportError, type Fetch } from '../../../packages/clinical-core/src/transport';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const ledgerPath = '/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md';
const fingerprintPaths = ['apps/research-server/scripts/dispatch-vision.ts', 'apps/research-server/scripts/prepare-vision.ts', 'apps/research-server/scripts/frame-fixture.ts', 'apps/research-server/src/analysis.ts', 'apps/research-server/src/frames.ts', 'packages/research-core/src/analysis.ts', 'packages/research-capture/src/contracts.ts', 'packages/research-capture/src/proof.ts', 'packages/clinical-core/src/digitalocean.ts', 'packages/clinical-core/src/transport.ts', 'packages/clinical-core/src/domain.ts'];
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
async function bounded(path: string, cap: number): Promise<Buffer> { assert(isAbsolute(path), 'Absolute artifact path required'); const info = await stat(path); assert(info.isFile() && info.size > 0 && info.size <= cap, 'Artifact exceeds bound'); return readFile(path); }
async function fingerprints() { const entries = []; for (const path of fingerprintPaths) entries.push({ path, sha256: hash(await bounded(resolve(workspace, path), 1_000_000)) }); return entries; }
async function ledgerRow(id: string) {
  assert(/^DO-V[1-9][0-9]*$/.test(id), 'Explicit unique primary-ledger ID required');
  const rows = (await bounded(ledgerPath, 1_000_000)).toString('utf8').split('\n').filter(line => line.startsWith(`| ${id} /`));
  assert(rows.length === 1 && rows[0].includes('qwen3.8-max'), 'Unique primary-ledger model reservation required');
  const cells = rows[0].split('|').slice(1, -1).map(cell => cell.trim()), caps = (cells[3] ?? '').replace(/[\s,]/g, '').toLowerCase();
  assert(cells.length === 8 && /^(reserved|prospective)/i.test(cells[7]) && /(?:1|one)(?:inference)?call/.test(caps) && caps.includes('64000') && caps.includes('1024') && /15s|15000ms/.test(caps), 'Prospective ledger must bind one call/64000 wire bytes/1024 tokens/15s');
  return { path: ledgerPath, rowHash: hash(rows[0]) };
}
async function frozenInput(directory: string) {
  assert(isAbsolute(directory), 'Absolute candidate directory required');
  const receiptBytes = await bounded(resolve(directory, 'DO-V1-PREFLIGHT.json'), 32_000), receipt = JSON.parse(receiptBytes.toString('utf8'));
  assert(receipt.id === 'DO-V1-PREFLIGHT' && receipt.state === 'unreserved-candidate' && receipt.dispatched === false && receipt.providerCalls === 0 && JSON.stringify(receipt.limits) === JSON.stringify(candidate), 'Expected zero-dispatch candidate required');
  assert(receipt.sources?.length === 1, 'One source required'); const source = receipt.sources[0];
  const video = await bounded(resolve(directory, 'DO-V1-SYNTHETIC.webm'), 8_000_000), frame = await bounded(resolve(directory, 'DO-V1-FRAME.jpg'), candidate.frameBytes), oldWire = (await bounded(resolve(directory, 'DO-V1-REQUEST.json'), candidate.maxInputBytes)).toString('utf8');
  assert(hash(video) === source.mediaHash && video.length === source.bytes && hash(frame) === source.imageHash && frame.length === source.imageBytes, 'Frozen source/frame hashes differ');
  assert(source.atMs === 1250 && source.offsetMs === 250 && source.segmentStartMs === 1000 && source.segmentEndMs === 2000 && JSON.stringify(jpegDimensions(frame)) === JSON.stringify(source.geometry), 'Frozen source time/geometry differs');
  const { messages, evidence } = visionEnvelope(source.mediaHash, frame), config: DigitalOceanConfig = { endpoint: DO_ENDPOINT, apiKey: 'offline-preflight-not-a-credential', model: candidate.model, maxOutputTokens: candidate.maxOutputTokens, maxRequestBytes: candidate.maxInputBytes, timeoutMs: candidate.timeoutMs, responseFormat: 'json' };
  const prepared = await prepareDigitalOceanRequest(config, messages);
  assert(prepared.body === oldWire && hash(prepared.body) === receipt.inputHash && prepared.requestBytes === receipt.requestBytes, 'Fresh envelope differs from frozen request');
  return { receiptHash: hash(receiptBytes), source, messages, evidence, config, body: prepared.body, inputHash: hash(prepared.body), requestBytes: prepared.requestBytes };
}
export async function finalizeVision(directory: string, id: string, expiresAt: number, output: string) {
  assert(Number.isSafeInteger(expiresAt) && expiresAt > Date.now() + candidate.timeoutMs && expiresAt <= Date.now() + 24 * 60 * 60_000, 'Explicit fresh reservation expiry required');
  const input = await frozenInput(directory), ledger = await ledgerRow(id), modules = await fingerprints();
  const reservation: AnalysisReservation = { id, model: candidate.model, maxInputBytes: candidate.maxInputBytes, maxOutputTokens: candidate.maxOutputTokens, expiresAt, live: true };
  const exact = await digitalOceanAnalysis(input.config).prepare(input.messages, reservation);
  assert(exact.inputHash === input.inputHash && exact.requestBytes === input.requestBytes && exact.maxOutputTokens === candidate.maxOutputTokens, 'Adapter differs from finalized reservation');
  const preflight = { kind: 'root-reserved-vision-preflight', id, preparedAt: new Date().toISOString(), state: 'reserved-not-dispatched', providerCalls: 0, directory, reservation, limits: candidate, ledger, modules, candidateHash: input.receiptHash, source: input.source, inputHash: input.inputHash, requestBytes: input.requestBytes };
  assert(output === resolve(workspace, 'docs/implementation/evidence', `${id}-PREFLIGHT.json`), 'Canonical exclusive ledger-ID preflight path required'); await writeFile(output, JSON.stringify(preflight, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return preflight;
}
export async function dispatchVision(preflightPath: string, envPath: string, output: string, fetcher: Fetch = fetch) {
  const preflight = JSON.parse((await bounded(preflightPath, 64_000)).toString('utf8'));
  assert(preflightPath === resolve(workspace, 'docs/implementation/evidence', `${preflight.id}-PREFLIGHT.json`) && output === resolve(workspace, 'docs/implementation/evidence', `${preflight.id}.json`), 'Canonical exclusive ledger-ID receipt paths required');
  assert(preflight.kind === 'root-reserved-vision-preflight' && preflight.state === 'reserved-not-dispatched' && preflight.providerCalls === 0 && JSON.stringify(preflight.limits) === JSON.stringify(candidate), 'Finalized root preflight required');
  assert(preflight.reservation.id === preflight.id && preflight.reservation.model === candidate.model && preflight.reservation.live === true && preflight.reservation.maxInputBytes === candidate.maxInputBytes && preflight.reservation.maxOutputTokens === candidate.maxOutputTokens && Number.isSafeInteger(preflight.reservation.expiresAt) && preflight.reservation.expiresAt > Date.now() + candidate.timeoutMs, 'Finalized reservation expired or differs');
  const input = await frozenInput(preflight.directory);
  assert(input.receiptHash === preflight.candidateHash && input.inputHash === preflight.inputHash && input.requestBytes === preflight.requestBytes && JSON.stringify(input.source) === JSON.stringify(preflight.source), 'Current artifacts differ from finalized preflight');
  assert(JSON.stringify(await ledgerRow(preflight.id)) === JSON.stringify(preflight.ledger) && JSON.stringify(await fingerprints()) === JSON.stringify(preflight.modules), 'Ledger or implementation changed since preflight');
  assert(isAbsolute(envPath) && isAbsolute(output), 'Absolute private env and receipt paths required'); const envInfo = await stat(envPath); assert(envInfo.isFile() && !(envInfo.mode & 0o077), 'Private env file mode required');
  // Exclusive intent precedes credential loading or network. Any existing receipt forbids redispatch.
  const report: Record<string, unknown> = { id: preflight.id, startedAt: new Date().toISOString(), state: 'intent', calls: 0, cashUsd: 0, noRetries: true, reservation: preflight.reservation, limits: candidate, ledger: preflight.ledger, implementationFingerprints: preflight.modules, inputHash: input.inputHash, requestBytes: input.requestBytes, source: input.source };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
  let apiKey = '', completed = false;
  try {
    loadEnvFile(envPath); apiKey = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY || ''; assert(apiKey, 'Model key unavailable');
    const config = { ...input.config, apiKey }, adapter = digitalOceanAnalysis(config, async (url, init) => {
      assert(report.calls === 0 && String(url) === `${DO_ENDPOINT}/v1/chat/completions` && init?.method === 'POST' && init.body === input.body && Buffer.byteLength(init.body, 'utf8') <= candidate.maxInputBytes, 'One exact reserved dispatch only');
      assert(preflight.reservation.expiresAt > Date.now() + candidate.timeoutMs && JSON.stringify(await ledgerRow(preflight.id)) === JSON.stringify(preflight.ledger) && JSON.stringify(await fingerprints()) === JSON.stringify(preflight.modules), 'Reservation, ledger or implementation changed before dispatch');
      report.calls = 1; report.state = 'dispatched'; report.dispatchedAt = new Date().toISOString(); await save();
      const response = await fetcher(url, init), chunks: Buffer[] = []; let count = 0, overflow = false, complete = false, readFailed = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try { reader = response.body?.getReader(); if (reader) for (;;) { const next = await reader.read(); if (next.done) { complete = true; break; } const remaining = Math.max(0, 256_000 - count); chunks.push(Buffer.from(next.value.slice(0, remaining))); count += next.value.length; if (count > 256_000) { overflow = true; break; } } }
      catch { readFailed = true; }
      finally { void reader?.cancel().catch(() => undefined); }
      const raw = Buffer.concat(chunks), text = raw.toString('utf8').split(apiKey).join('[REDACTED]');
      report.response = { status: response.status, complete, capturedBytes: raw.length, rawText: text, sha256: hash(raw) };
      try { const body = JSON.parse(text); report.usage = body.usage ? { prompt_tokens: body.usage.prompt_tokens ?? null, completion_tokens: body.usage.completion_tokens ?? null, total_tokens: body.usage.total_tokens ?? null } : null; } catch { report.usage = null; } await save();
      if (overflow) throw new TransportError('response-too-large');
      if (readFailed) throw new TransportError(init.signal?.aborted ? 'timeout' : 'network');
      return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
    });
    const exact = await adapter.prepare(input.messages, preflight.reservation); assert(exact.inputHash === input.inputHash && exact.requestBytes === input.requestBytes && exact.maxOutputTokens === candidate.maxOutputTokens, 'Final wire cap/hash differs');
    const result = await adapter.generate(input.messages, preflight.reservation); completed = true;
    const usage = report.usage as { completion_tokens?: unknown } | null; assert(usage && Number.isSafeInteger(usage.completion_tokens) && Number(usage.completion_tokens) <= candidate.maxOutputTokens && Number(usage.completion_tokens) >= 0, 'Returned completion accounting exceeds reservation');
    report.findings = validateVisionResult(result.findings, input.evidence); report.providerRequestId = result.requestId; report.model = result.model; report.state = 'single-fixture-qualified';
  } catch (error) {
    report.state = report.calls === 0 ? 'not-dispatched' : completed ? 'failed' : 'unknown';
    report.errorCode = error instanceof TransportError ? error.code : completed ? 'vision-output-rejected' : 'qualification-outcome-unknown';
  } finally { report.finishedAt = new Date().toISOString(); await save(); }
  return { id: report.id, state: report.state, calls: report.calls, output };
}
assert(!(process.argv.includes('--vision-preflight') && process.argv.includes('--vision-dispatch')), 'Choose exactly one qualification mode');
if (process.argv.includes('--vision-preflight')) console.log(JSON.stringify(await finalizeVision(arg('--candidate'), arg('--id'), Date.parse(arg('--expires-at')), arg('--output'))));
if (process.argv.includes('--vision-dispatch')) {
  assert(process.argv.includes('--allow-one-live-vision-call'), 'Explicit live one-call flag required');
  console.log(JSON.stringify(await dispatchVision(arg('--preflight'), arg('--env'), arg('--output'))));
}
