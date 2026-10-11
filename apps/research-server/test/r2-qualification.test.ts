import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { R2PrivateBucketPort } from '../../../packages/research-capture/src/r2-bucket';
import { R2WireGuard, r2Plan, r2Keys, r2FingerprintPaths, runR2Sequence, zeroGet, prepareR2, executeR2, validateR2Preflight } from '../scripts/qualify-r2';

const root = fileURLToPath(new URL('../../../', import.meta.url)), temporary: string[] = [], clients: { destroy(): void }[] = [];
afterEach(async () => { clients.splice(0).forEach(c => c.destroy()); for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
const fixturePath = 'docs/implementation/evidence/DO-V1-CANDIDATE/DO-V1-SYNTHETIC.webm';
const fixture = () => readFile(resolve(root, fixturePath));
function clock() { let now = Date.now(); return { now: () => now, wait: async (ms: number) => { now += ms; } }; }
function guard() { const calls: any[] = [], events: any[] = []; const delegate = { async handle(request: any) { calls.push(request); return { response: { statusCode: 200 } }; }, destroy() {} }; const value = new R2WireGuard(delegate, Date.now() + 120000, async event => { events.push(event); }, clock()); return { value, calls, events }; }
function request(key: string, method: string, extra: Record<string, string> = {}) { return { protocol: 'https:', hostname: new URL(r2Plan.endpoint).hostname, method, path: `/${r2Plan.bucket}/${r2Plan.namespace}/${key}`, query: {}, headers: { ...(method === 'PUT' ? { 'content-type': 'application/octet-stream', 'content-length': '0', 'x-amz-meta-state': 'retired' } : {}), ...extra }, body: new Uint8Array() }; }
async function copyInputs() {
  const directory = await mkdtemp(resolve(tmpdir(), 'unfiltered-r2-preflight-')); temporary.push(directory);
  for (const path of [...r2FingerprintPaths, fixturePath]) { await mkdir(dirname(resolve(directory, path)), { recursive: true }); await copyFile(resolve(root, path), resolve(directory, path)); }
  return directory;
}
it('offline preflight freezes the actual source/test hashes, dispatches nothing and cannot overwrite', async () => {
  const directory = await copyInputs(), value = await prepareR2(Date.now() + 120000, directory); expect(value.requests).toBe(0);
  const stored = JSON.parse((await readFile(value.output)).toString()); expect(stored.fixture).toMatchObject({ bytes: 3037, sha256: r2Plan.sha256 }); expect(stored.modules).toHaveLength(r2FingerprintPaths.length);
  await expect(prepareR2(Date.now() + 120000, directory)).rejects.toThrow();
});
it('changed source/test pins fail before intent, credentials or network', async () => {
  const directory = await copyInputs(); await prepareR2(Date.now() + 120000, directory); await writeFile(resolve(directory, r2FingerprintPaths[1]), 'changed test');
  await expect(executeR2(resolve(directory, 'never-read.env'), directory)).rejects.toThrow('pins');
  await expect(readFile(resolve(directory, 'docs/implementation/evidence/R2-Q2-INTENT.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('missing credentials produces an immutable not-dispatched result and forbids a second execution', async () => {
  const directory = await copyInputs(); await prepareR2(Date.now() + 120000, directory);
  const result = await executeR2(resolve(directory, 'absent.env'), directory); expect(result).toMatchObject({ state: 'not-dispatched', requests: 0 });
  const saved = await readFile(result.output); await expect(executeR2(resolve(directory, 'absent.env'), directory)).rejects.toThrow('Existing'); expect(await readFile(result.output)).toEqual(saved);
});
it.each([0, Date.now() + 1000, Date.now() + 25 * 3600000])('rejects expired/unbounded preflight %s', expiresAt => {
  expect(() => validateR2Preflight({ kind: 'root-r2-preflight', id: r2Plan.id, state: 'reserved-not-dispatched', requests: 0, plan: r2Plan, expiresAt })).toThrow();
});
it.each([{ hostname: 'foreign.invalid' }, { protocol: 'http:' }, { path: '/unfiltered-analysis/r2-q2-20261010/research/synthetic-r2-q2/a1' }, { method: 'DELETE' }, { query: { uploads: '' } }])('denies unsupported endpoint/path/method before delegate %j', override => {
  const f = guard(); return expect(f.value.handle({ ...request(r2Keys.a, 'HEAD'), ...override })).rejects.toThrow().then(() => expect(f.calls).toHaveLength(0));
});
it('denies direct GET until retired HEAD approval, and keeps cleanup unable to upload content', async () => {
  const f = guard(); await expect(f.value.handle(request(r2Keys.a, 'GET'))).rejects.toThrow('HEAD');
  f.value.cleanup(); await expect(f.value.handle({ ...request(r2Keys.a, 'PUT'), body: await fixture(), headers: { 'if-none-match': '*', 'content-type': 'video/webm', 'content-length': '3037', 'x-amz-meta-state': 'available', 'x-amz-meta-sha256': r2Plan.sha256 } })).rejects.toThrow(); expect(f.calls).toHaveLength(0);
});
it('denies an expired dispatch before wire and does not leak request headers into receipts', async () => {
  const calls: any[] = [], events: any[] = [];
  const expired = new R2WireGuard({ handle: async r => { calls.push(r); return {}; }, destroy() {} }, Date.now() + 1000, async event => { events.push(event); });
  await expect(expired.handle(request(r2Keys.a, 'HEAD'))).rejects.toThrow('Expired'); expect(calls).toHaveLength(0); expect(events).toHaveLength(0);
  const f = guard(); await f.value.handle(request(r2Keys.a, 'HEAD', { authorization: 'SYNTHETIC-NOT-A-SECRET' }));
  expect(f.events.every(e => Object.keys(e).sort().join(',') === 'key,method,phase,status')).toBe(true);
});
it('cleanup cancels a client-held conditional create before it can dispatch in the new phase', async () => {
  const f = guard(), body = await fixture();
  const late = f.value.handle({ ...request(r2Keys.b, 'PUT'), body, headers: { 'if-none-match': '*', 'content-type': 'video/webm', 'content-length': '3037', 'x-amz-meta-state': 'available', 'x-amz-meta-sha256': r2Plan.sha256 } });
  await f.value.held.promise; f.value.cleanup(); await expect(late).rejects.toThrow('stale-phase'); expect(f.calls).toHaveLength(0);
});
it('spaces ordinary same-key writes by 1100ms before the next dispatch', async () => {
  let now = Date.now(); const waits: number[] = [], dispatches: number[] = [];
  const f = new R2WireGuard({ handle: async () => { dispatches.push(now); return { response: { statusCode: 200 } }; }, destroy() {} }, now + 120000, async () => {}, { now: () => now, wait: async ms => { waits.push(ms); now += ms; } });
  await f.handle(request(r2Keys.a, 'PUT')); await f.handle(request(r2Keys.a, 'PUT'));
  expect(dispatches[1] - dispatches[0]).toBe(1100); expect(waits).toEqual([0, 1100]);
});
it('enforces exact per-key nominal19 + cleanup6 =25 even when callers request more', async () => {
  const f = guard(); f.value.approveZero(r2Keys.a); f.value.approveZero(r2Keys.b);
  for (const [key, quota] of [[r2Keys.a, { PUT: 3, HEAD: 6, GET: 3 }], [r2Keys.b, { PUT: 2, HEAD: 2, GET: 1 }], [r2Keys.missing, { HEAD: 1, GET: 1 }]] as const) for (const [method, count] of Object.entries(quota)) for (let i = 0; i < count; i++) await f.value.handle(request(key, method, key === r2Keys.missing && method === 'GET' ? { range: 'bytes=0-0' } : {}));
  expect(f.calls).toHaveLength(19); await expect(f.value.handle(request(r2Keys.a, 'HEAD'))).rejects.toThrow('envelope'); f.value.cleanup();
  for (const key of [r2Keys.a, r2Keys.b]) for (const method of ['PUT', 'HEAD', 'GET']) await f.value.handle(request(key, method));
  expect(f.calls).toHaveLength(25); await expect(f.value.handle(request(r2Keys.a, 'PUT'))).rejects.toThrow('envelope'); expect(f.calls).toHaveLength(25);
});
function memory(unknownLate = false) {
  const rows = new Map<string, { body: Uint8Array; headers: Record<string, string> }>();
  const err = (code: string, statusCode: number) => ({ response: { statusCode, headers: {}, body: Readable.from([Buffer.from(`<Error><Code>${code}</Code></Error>`)]) } });
  const handler = { async handle(r: any) {
    if (r.method === 'PUT') {
      if (unknownLate && r.path.endsWith('/b1') && r.headers['if-none-match']) throw Error('lost acknowledgement');
      if (r.headers['if-none-match'] && rows.has(r.path)) return err('PreconditionFailed', 412);
      rows.set(r.path, { body: Uint8Array.from(r.body), headers: { 'content-length': r.headers['content-length'], 'content-type': r.headers['content-type'], 'x-amz-meta-state': r.headers['x-amz-meta-state'], ...(r.headers['x-amz-meta-sha256'] ? { 'x-amz-meta-sha256': r.headers['x-amz-meta-sha256'] } : {}), etag: '"immutable"' } }); return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
    }
    const row = rows.get(r.path); if (!row) return r.method === 'HEAD' ? { response: { statusCode: 404, headers: {}, body: Readable.from([]) } } : err('NoSuchKey', 404);
    if (r.method === 'HEAD') return { response: { statusCode: 200, headers: row.headers, body: Readable.from([]) } };
    if (!r.headers.range) return { response: { statusCode: 200, headers: row.headers, body: Readable.from([row.body]) } };
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(r.headers.range)!;
    return { response: { statusCode: 206, headers: { ...row.headers, 'content-length': String(+end - +start + 1), 'content-range': `bytes ${start}-${end}/${row.body.length}` }, body: Readable.from([row.body.subarray(+start, +end + 1)]) } };
  }, destroy() {} };
  const value = new R2WireGuard(handler, Date.now() + 120000, async () => {}, clock()), credentials = async () => ({ accessKeyId: 'SYNTHETIC', secretAccessKey: 'synthetic-no-authority' });
  const port = R2PrivateBucketPort.create({ accountId: r2Plan.accountId, bucket: r2Plan.bucket, namespace: r2Plan.namespace, deadlineMs: 15000, maxObjectBytes: 4000000 }, credentials, value); clients.push({ destroy: () => port.close() });
  const client = new S3Client({ region: 'auto', endpoint: r2Plan.endpoint, forcePathStyle: true, credentials, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', requestHandler: value }); clients.push(client);
  return { value, port, client };
}
it('completes the actual SDK nominal19 sequence with honest client-held ordering and zero-content readback', async () => {
  const f = memory(), result = await runR2Sequence(f.port, f.value, await fixture(), key => zeroGet(f.client, key));
  expect(result).toMatchObject({ state: 'qualified-client-held-ordering', cleanup: { a: true, b: true } }); expect(result.delayedWriteProof).toContain('not remote-inflight'); expect(f.value.records).toHaveLength(19);
  expect(f.value.records.filter(w => w.key === r2Keys.b && w.method === 'PUT').map(w => w.status)).toEqual([200, 412]);
});
it('never treats an unknown late conditional write as fence proof; only bounded terminal retirement follows', async () => {
  const f = memory(true), result = await runR2Sequence(f.port, f.value, await fixture(), key => zeroGet(f.client, key));
  expect(result.state).toBe('failed-or-unknown'); expect(result.checks).not.toContain('late-create-fenced'); expect(result.cleanup).toEqual({ a: true, b: true });
  expect(f.value.records.filter(w => w.key === r2Keys.b && w.phase === 'nominal' && w.method === 'PUT').map(w => w.status)).toEqual([200, null]);
  expect(f.value.records.filter(w => w.phase === 'cleanup')).toHaveLength(3); expect(f.value.records.length).toBeLessThanOrEqual(25);
});
