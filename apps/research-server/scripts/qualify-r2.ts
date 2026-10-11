/** Root-only one-shot R2-Q2 successor after separately verified Q1 retirement.
 * Historical Q1 receipts remain immutable. Importing this file performs no work. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { S3Client, GetObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';
import { R2PrivateBucketPort } from '../../../packages/research-capture/src/r2-bucket';
import { BucketPrivateObjectStore, type PrivateBucketPort } from '../../../packages/research-capture/src/bucket-store';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
export const r2Plan = Object.freeze({ id: 'R2-Q2', accountId: '728ae4b71b42dfcef062336c06bd8595', bucket: 'unfiltered-recordings', namespace: 'r2-q2-20261010', endpoint: 'https://728ae4b71b42dfcef062336c06bd8595.r2.cloudflarestorage.com', bytes: 3037, sha256: '1e601b21a3e04b9c808e1713369ea858284e921e9adadb8fc4422d60f91be5bb', timeoutMs: 15000, writeSpacingMs: 1100, nominalRequests: 19, cleanupRequests: 6, maxRequests: 25 });
export const r2Keys = Object.freeze({ a: 'research/synthetic-r2-q2/a1', b: 'research/synthetic-r2-q2/b1', missing: 'research/synthetic-r2-q2/missing' });
const fixturePath = 'docs/implementation/evidence/DO-V1-CANDIDATE/DO-V1-SYNTHETIC.webm';
export const r2FingerprintPaths = ['apps/research-server/scripts/qualify-r2.ts', 'apps/research-server/test/r2-qualification.test.ts', 'packages/research-capture/src/r2-bucket.ts', 'packages/research-capture/test/r2-bucket.test.ts', 'packages/research-capture/src/bucket-store.ts', 'packages/research-capture/src/contracts.ts', 'node_modules/@aws-sdk/client-s3/package.json', 'node_modules/@smithy/node-http-handler/package.json'];
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const path = (suffix: string, root = workspace) => resolve(root, 'docs/implementation/evidence', `R2-Q2${suffix}`);
async function bounded(file: string, cap: number, privateMode = false) { assert(isAbsolute(file)); const info = await lstat(file); assert(info.isFile() && info.size > 0 && info.size <= cap && (!privateMode || !(info.mode & 0o077)), 'Invalid bounded/private input'); return readFile(file); }
async function frozen(root: string) {
  const bytes = await bounded(resolve(root, fixturePath), 4000000); assert(bytes.length === r2Plan.bytes && sha(bytes) === r2Plan.sha256, 'Frozen DO-V1 fixture changed');
  const fingerprints = []; for (const relative of r2FingerprintPaths) fingerprints.push({ path: relative, sha256: sha(await bounded(resolve(root, relative), 1000000)) });
  return { bytes, fingerprints };
}
export function validateR2Preflight(value: any, now = Date.now()) {
  assert(value?.kind === 'root-r2-preflight' && value.id === r2Plan.id && value.state === 'reserved-not-dispatched' && value.requests === 0 && JSON.stringify(value.plan) === JSON.stringify(r2Plan), 'Exact zero-dispatch R2-Q2 preflight required');
  assert(Number.isSafeInteger(value.expiresAt) && value.expiresAt > now + 60000 && value.expiresAt <= now + 24 * 60 * 60000, 'Fresh explicit reservation expiry required');
}
export async function prepareR2(expiresAt: number, root = workspace) {
  const input = await frozen(root), value = { kind: 'root-r2-preflight', id: r2Plan.id, state: 'reserved-not-dispatched', requests: 0, preparedAt: new Date().toISOString(), expiresAt, plan: r2Plan, fixture: { path: fixturePath, bytes: input.bytes.length, sha256: sha(input.bytes) }, modules: input.fingerprints, delayedWriteProof: 'client-held-until-retired-HEAD; not remote-inflight' };
  validateR2Preflight(value); await writeFile(path('-PREFLIGHT.json', root), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return { id: r2Plan.id, state: value.state, requests: 0, output: path('-PREFLIGHT.json', root) };
}
type Wire = { phase: 'nominal' | 'cleanup'; method: string; key: string; status: number | null };
type Handler = { handle(request: any, options?: any): Promise<any>; destroy(): void };
type Timing = { now(): number; wait(ms: number, signal?: AbortSignal): Promise<void> };
const timing: Timing = { now: Date.now, wait: async (ms, signal) => { await pause(ms, undefined, { signal }); } };
export class R2WireGuard implements Handler {
  readonly records: Wire[] = []; readonly zeroApproved = new Set<string>();
  private phase: Wire['phase'] = 'nominal'; private readonly counts = new Map<string, number>(); private readonly lastWrite = new Map<string, number>();
  readonly held = { promise: undefined as unknown as Promise<void>, enter: () => {}, release: () => {} };
  private releasePromise: Promise<void>;
  constructor(private readonly delegate: Handler, private readonly expiresAt: number, private readonly record: (wire: Wire) => Promise<void>, private readonly clock = timing) {
    this.held.promise = new Promise(resolve => { this.held.enter = resolve; });
    this.releasePromise = new Promise(resolve => { this.held.release = resolve; });
  }
  cleanup() { this.phase = 'cleanup'; this.held.release(); }
  approveZero(key: string) { assert([r2Keys.a, r2Keys.b].includes(key as any)); this.zeroApproved.add(key); }
  async handle(request: any, options: any = {}) {
    const admittedPhase = this.phase;
    assert(request.protocol === 'https:' && request.hostname === new URL(r2Plan.endpoint).hostname && (request.port === undefined || request.port === 443) && !request.username && !request.password, 'Pinned R2 endpoint required');
    const allowed = Object.values(r2Keys), key = request.path.slice(`/${r2Plan.bucket}/${r2Plan.namespace}/`.length);
    assert(allowed.includes(key) && request.path === `/${r2Plan.bucket}/${r2Plan.namespace}/${key}` && ['PUT', 'HEAD', 'GET'].includes(request.method), 'Owned path/method required');
    assert(Object.keys(request.query ?? {}).every(k => k === 'x-id' && ['PutObject', 'HeadObject', 'GetObject'].includes(request.query[k])), 'No administration/multipart query');
    const h = request.headers ?? {}, available = request.method === 'PUT' && h['if-none-match'] === '*';
    if (request.method === 'PUT') {
      assert(key !== r2Keys.missing && request.body instanceof Uint8Array, 'Owned immutable body required');
      if (available) assert(this.phase === 'nominal' && request.body.length === r2Plan.bytes && sha(request.body) === r2Plan.sha256 && h['content-length'] === String(r2Plan.bytes) && h['content-type'] === 'video/webm' && h['x-amz-meta-state'] === 'available' && h['x-amz-meta-sha256'] === r2Plan.sha256, 'Exact frozen available write required');
      else assert(request.body.length === 0 && h['content-length'] === '0' && h['content-type'] === 'application/octet-stream' && h['x-amz-meta-state'] === 'retired' && !h['x-amz-meta-sha256'] && !h['if-none-match'], 'Only zero retirement may overwrite');
      if (available && key === r2Keys.b) { this.held.enter(); await this.releasePromise; }
    }
    if (request.method === 'GET') {
      if (!h.range) assert(this.zeroApproved.has(key), 'Zero-content GET requires validated retired HEAD');
      else assert(this.phase === 'nominal' && (key === r2Keys.a && [`bytes=0-${r2Plan.bytes - 1}`, 'bytes=2-7'].includes(h.range) && h['if-match'] || key === r2Keys.missing && h.range === 'bytes=0-0'), 'Only exact bounded reads allowed');
    }
    const quota = this.phase === 'cleanup' ? { PUT: 1, HEAD: 1, GET: 1 } : key === r2Keys.a ? { PUT: 3, HEAD: 6, GET: 3 } : key === r2Keys.b ? { PUT: 2, HEAD: 2, GET: 1 } : { PUT: 0, HEAD: 1, GET: 1 };
    assert(this.phase !== 'cleanup' || key !== r2Keys.missing, 'No missing-key cleanup');
    const counter = `${this.phase}:${key}:${request.method}`, count = this.counts.get(counter) ?? 0;
    assert(count < quota[request.method as keyof typeof quota] && this.records.length < r2Plan.maxRequests && this.records.filter(r => r.phase === this.phase).length < (this.phase === 'nominal' ? 19 : 6), 'Reserved wire envelope exhausted');
    this.counts.set(counter, count + 1); // Admit synchronously before pacing/awaits.
    if (request.method === 'PUT') await this.clock.wait(Math.max(0, r2Plan.writeSpacingMs - (this.clock.now() - (this.lastWrite.get(key) ?? -Infinity))), options.abortSignal);
    assert(this.phase === admittedPhase && !options.abortSignal?.aborted && this.expiresAt > this.clock.now() + r2Plan.timeoutMs, 'Expired/aborted or stale-phase wire dispatch');
    if (request.method === 'PUT') this.lastWrite.set(key, this.clock.now());
    const wire: Wire = { phase: this.phase, method: request.method, key, status: null }; this.records.push(wire); await this.record({ ...wire });
    try { assert(this.expiresAt > this.clock.now() + r2Plan.timeoutMs && !options.abortSignal?.aborted, 'Expired/aborted dispatch'); const result = await this.delegate.handle(request, options); wire.status = result.response?.statusCode ?? null; await this.record({ ...wire }); return result; }
    catch { await this.record({ ...wire }); throw Error('R2 wire outcome unresolved'); }
  }
  destroy() { this.delegate.destroy(); }
}
async function confirmedZero(port: PrivateBucketPort, guard: R2WireGuard, key: string, readZero: (key: string) => Promise<void>) {
  const row = await port.head(key); assert(row?.bytes === 0 && row.contentType === 'application/octet-stream' && JSON.stringify(row.metadata) === JSON.stringify({ state: 'retired' }), 'Verified zero-content tombstone required');
  guard.approveZero(key); await readZero(key);
}
export async function runR2Sequence(port: PrivateBucketPort, guard: R2WireGuard, bytes: Uint8Array, readZero: (key: string) => Promise<void>) {
  const store = new BucketPrivateObjectStore(port), put = (key: string) => store.putIfAbsent(key, bytes, { bytes: r2Plan.bytes, sha256: r2Plan.sha256, mime: 'video/webm' });
  const result = { state: 'failed-or-unknown', checks: [] as string[], cleanup: { a: false, b: false }, delayedWriteProof: 'client-held-until-retired-HEAD; not remote-inflight' };
  try {
    await put(r2Keys.a); await put(r2Keys.a); result.checks.push('exact-creation-and-duplicate');
    assert(sha(new Uint8Array(await new Response(await store.read(r2Keys.a, { start: 0, end: bytes.length - 1 })).arrayBuffer())) === r2Plan.sha256); result.checks.push('full-source-hash');
    assert(Buffer.from(await new Response(await store.read(r2Keys.a, { start: 2, end: 7 })).arrayBuffer()).equals(Buffer.from(bytes.subarray(2, 8)))); result.checks.push('exact-range');
    await store.retire(r2Keys.a); await confirmedZero(port, guard, r2Keys.a, readZero); result.cleanup.a = true;
    const late = put(r2Keys.b); void late.catch(() => undefined);
    await Promise.race([guard.held.promise, late.then(() => { throw Error('Expected client-held write'); }, () => { throw Error('Client-held write failed early'); })]);
    await store.retire(r2Keys.b); guard.approveZero(r2Keys.b); guard.held.release();
    await assert.rejects(late); // Fails matching HEAD reconciliation after typed precondition conflict.
    assert(guard.records.some(w => w.key === r2Keys.b && w.method === 'PUT' && w.status === 412), 'Observed conditional conflict required; unknown is not fence proof');
    await readZero(r2Keys.b); result.cleanup.b = true;
    assert(await port.head(r2Keys.missing) === null); assert(guard.records.length === 19, 'Exact nominal wire count required');
    result.checks.push('late-create-fenced', 'typed-missing-probe'); result.state = 'qualified-client-held-ordering';
  } catch { /* Preserve outcome without upstream text or retrying uploads. */ }
  finally {
    guard.cleanup();
    for (const [name, key] of Object.entries({ a: r2Keys.a, b: r2Keys.b })) if (!result.cleanup[name as 'a' | 'b']) {
      try { await store.retire(key); guard.approveZero(key); await readZero(key); result.cleanup[name as 'a' | 'b'] = true; } catch { /* Never claim cleanup on denial/unknown. */ }
    }
  }
  return result;
}
export async function zeroGet(client: S3Client, key: string) {
  const controller = new AbortController(); let body: Readable | undefined;
  const timer = setTimeout(() => { controller.abort(); body?.destroy(); }, r2Plan.timeoutMs);
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: r2Plan.bucket, Key: `${r2Plan.namespace}/${key}` }), { abortSignal: controller.signal });
    if (response.Body instanceof Readable) body = response.Body;
    assert(response.$metadata.httpStatusCode === 200 && response.ContentLength === 0 && response.ContentType === 'application/octet-stream' && response.Metadata?.state === 'retired' && Object.keys(response.Metadata).length === 1 && body, 'Exact zero GET required');
    for await (const chunk of body) assert(chunk.length === 0, 'Zero GET returned content'); assert(!controller.signal.aborted);
  } finally { clearTimeout(timer); controller.abort(); body?.destroy(); }
}
export async function executeR2(envPath: string, root = workspace) {
  const preflightBytes = await bounded(path('-PREFLIGHT.json', root), 64000), preflight = JSON.parse(preflightBytes.toString()); validateR2Preflight(preflight);
  const input = await frozen(root); assert(JSON.stringify(input.fingerprints) === JSON.stringify(preflight.modules) && preflight.fixture.path === fixturePath && preflight.fixture.sha256 === sha(input.bytes) && preflight.fixture.bytes === input.bytes.length, 'Source/test/fixture pins changed');
  try { await lstat(path('.json', root)); throw Error('Existing R2-Q2 result forbids execution'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Both immutable fences precede env reads or any transport. Never resume this ID.
  await writeFile(path('-INTENT.json', root), JSON.stringify({ id: r2Plan.id, state: 'intent', preflightHash: sha(preflightBytes), expiresAt: preflight.expiresAt, plan: r2Plan, modules: preflight.modules }) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(path('-WIRE.jsonl', root), '', { flag: 'wx', mode: 0o600 });
  let guard: R2WireGuard | undefined, port: R2PrivateBucketPort | undefined, client: S3Client | undefined;
  let result: any = { state: 'not-dispatched', checks: [], cleanup: { a: false, b: false } };
  try {
    const env = parseEnv((await bounded(envPath, 128000, true)).toString()), accessKeyId = env.R2_ACCESS_KEY_ID, secretAccessKey = env.R2_SECRET_ACCESS_KEY;
    assert(accessKeyId && secretAccessKey, 'Explicit private R2 credential unavailable'); const credential = { accessKeyId, secretAccessKey };
    guard = new R2WireGuard(new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: r2Plan.timeoutMs }), preflight.expiresAt, async wire => {
      if (wire.status === null) assert(JSON.stringify((await frozen(root)).fingerprints) === JSON.stringify(preflight.modules), 'Source/test pins changed before dispatch');
      await appendFile(path('-WIRE.jsonl', root), JSON.stringify(wire) + '\n');
    });
    port = R2PrivateBucketPort.create({ accountId: r2Plan.accountId, bucket: r2Plan.bucket, namespace: r2Plan.namespace, deadlineMs: r2Plan.timeoutMs, maxObjectBytes: 4000000 }, async () => credential, guard);
    client = new S3Client({ region: 'auto', endpoint: r2Plan.endpoint, forcePathStyle: true, credentials: async () => credential, maxAttempts: 1, followRegionRedirects: false, useFipsEndpoint: false, useDualstackEndpoint: false, useAccelerateEndpoint: false, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', requestHandler: guard as S3ClientConfig['requestHandler'] });
    result = await runR2Sequence(port, guard, input.bytes, key => zeroGet(client!, key));
  } catch { if (guard?.records.length) result.state = 'failed-or-unknown'; }
  finally {
    port?.close(); client?.destroy(); guard?.destroy();
    result = { id: r2Plan.id, ...result, requests: guard?.records.length ?? 0, wire: guard?.records ?? [], preflightHash: sha(preflightBytes), noUploadRetries: true, finishedAt: new Date().toISOString() };
    await writeFile(path('.json', root), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { id: r2Plan.id, state: result.state, requests: result.requests, output: path('.json', root) };
}
const arg = (name: string) => { const index = process.argv.indexOf(name); assert(index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), 'Explicit mode argument required'); return process.argv[index + 1]; };
assert(!(process.argv.includes('--preflight') && process.argv.includes('--execute')), 'Choose exactly one R2 mode');
if (process.argv.includes('--preflight')) console.log(JSON.stringify(await prepareR2(Date.parse(arg('--expires-at')))));
if (process.argv.includes('--execute')) console.log(JSON.stringify(await executeR2(resolve(arg('--env')))));
