import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, expect, it, vi } from 'vitest';
import { R2PrivateBucketPort, type R2PrivateBucketConfig } from '../src/r2-bucket';
import { BucketPrivateObjectStore } from '../src/bucket-store';

const config: R2PrivateBucketConfig = { accountId: '728ae4b71b42dfcef062336c06bd8595', bucket: 'unfiltered-recordings', namespace: 'offline-r2-proof', deadlineMs: 1000, maxObjectBytes: 4000000 };
const key = 'research/synthetic-session/segment-a1', bytes = Buffer.from('synthetic retained bytes');
const sha = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const credentials = vi.fn(async () => ({ accessKeyId: 'SYNTHETIC-KEY', secretAccessKey: 'synthetic-no-authority' }));
const ports: R2PrivateBucketPort[] = [];
afterEach(() => { ports.splice(0).forEach(p => p.close()); vi.restoreAllMocks(); vi.unstubAllEnvs(); credentials.mockClear(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const error = (code: string, statusCode: number) => ({ response: { statusCode, headers: {}, body: Readable.from([Buffer.from(`<Error><Code>${code}</Code></Error>`)]) } });
type ObjectRow = { body: Uint8Array; metadata: Record<string, string>; mime: string };

/** Actual SDK serialization/deserialization against an in-memory atomic wire
 * transport. This proves our wire contract, not Cloudflare's race behavior. */
function fixture(overrides: Partial<R2PrivateBucketConfig> = {}) {
  const objects = new Map<string, ObjectRow>(), requests: any[] = [];
  let gate: Promise<void> | undefined, entered: (() => void) | undefined;
  let fault: ((request: any) => any) | undefined;
  let beforeGet: (() => Promise<void>) | undefined;
  let headers = (h: Record<string, string>, _method: string) => h;
  let stream = (body: Uint8Array) => Readable.from([body]);
  let lastBody: Readable | undefined;
  const handler = { async handle(request: any) {
    requests.push(request);
    const failure = await fault?.(request); if (failure) return failure;
    const physical = decodeURIComponent(request.path).slice(1);
    if (request.method === 'PUT') {
      if (request.headers['if-none-match'] === '*' && gate) { entered?.(); await gate; }
      if (request.headers['if-none-match'] === '*' && objects.has(physical)) return error('PreconditionFailed', 412);
      objects.set(physical, { body: Uint8Array.from(request.body), metadata: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith('x-amz-meta-')).map(([name, value]) => [name.slice(11), String(value)])), mime: request.headers['content-type'] });
      return { response: { statusCode: 200, headers: headers({}, 'PUT'), body: Readable.from([]) } };
    }
    if (request.method === 'GET') await beforeGet?.();
    const row = objects.get(physical); if (!row) return error('NoSuchKey', 404);
    const etag = '"' + sha(row.body).slice(0, 32) + '"';
    const h: Record<string, string> = { 'content-length': String(row.body.length), 'content-type': row.mime, etag, ...Object.fromEntries(Object.entries(row.metadata).map(([name, value]) => ['x-amz-meta-' + name, value])) };
    if (request.method === 'HEAD') return { response: { statusCode: 200, headers: headers(h, 'HEAD'), body: Readable.from([]) } };
    if (request.method !== 'GET') throw Error('Unexpected offline method');
    if (request.headers['if-match'] && request.headers['if-match'] !== etag) return error('PreconditionFailed', 412);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range)!;
    h['content-length'] = String(+end - +start + 1); h['content-range'] = `bytes ${start}-${end}/${row.body.length}`;
    lastBody = stream(row.body.subarray(+start, +end + 1));
    return { response: { statusCode: 206, headers: headers(h, 'GET'), body: lastBody } };
  }, destroy() {} };
  const port = R2PrivateBucketPort.create({ ...config, ...overrides }, credentials, handler); ports.push(port);
  return { port, store: new BucketPrivateObjectStore(port), objects, requests, physical: `${config.bucket}/${config.namespace}/${key}`, gate: (promise: Promise<void>, onEnter: () => void) => { gate = promise; entered = onEnter; }, fault: (f: typeof fault) => { fault = f; }, beforeGet: (f: typeof beforeGet) => { beforeGet = f; }, headers: (f: typeof headers) => { headers = f; }, stream: (f: typeof stream) => { stream = f; }, lastBody: () => lastBody };
}
const put = (f: ReturnType<typeof fixture>, body = bytes) => f.store.putIfAbsent(key, body, { bytes: body.length, sha256: sha(body), mime: 'video/webm' });

it('constructs without I/O/env fallback and pins the official SDK wire, credentials and conditional/range headers', async () => {
  vi.stubEnv('AWS_ENDPOINT_URL_S3', 'https://foreign.invalid'); vi.stubEnv('AWS_REGION', 'us-east-1'); vi.stubEnv('AWS_ACCESS_KEY_ID', 'FOREIGN');
  const f = fixture(); expect(f.requests).toHaveLength(0); expect(credentials).not.toHaveBeenCalled();
  await put(f);
  expect(await new Response(await f.store.read(key, { start: 0, end: bytes.length - 1 })).text()).toBe(bytes.toString());
  expect(await new Response(await f.store.read(key, { start: 2, end: 7 })).text()).toBe('ntheti');
  for (const request of f.requests) {
    expect(request.protocol).toBe('https:'); expect(request.hostname).toBe(`${config.accountId}.r2.cloudflarestorage.com`); expect(request.path).toBe('/' + f.physical);
    expect(request.headers.authorization).toContain('Credential=SYNTHETIC-KEY/'); expect(request.headers.authorization).toContain('/auto/s3/aws4_request');
    expect(Object.keys(request.headers).some(h => /server-side-encryption|expected-bucket-owner|checksum|acl/.test(h))).toBe(false);
    expect(Object.keys(request.query).some(q => /versioning|lifecycle|upload|create/i.test(q))).toBe(false);
  }
  expect(f.requests[0].headers).toMatchObject({ 'if-none-match': '*', 'content-length': String(bytes.length), 'content-type': 'video/webm', 'x-amz-meta-state': 'available', 'x-amz-meta-sha256': sha(bytes) });
  expect(f.requests.at(-1).headers).toMatchObject({ range: 'bytes=2-7', 'if-match': expect.stringMatching(/^"/) });
});
it.each([{ accountId: 'foreign' }, { bucket: 'unfiltered-analysis' }, { namespace: '../escape' }, { maxObjectBytes: 4000001 }, { deadlineMs: 15001 }, { endpoint: 'https://foreign.invalid' }])('rejects unsupported config before storage %j', override => {
  expect(() => R2PrivateBucketPort.create({ ...config, ...override } as any, credentials)).toThrow(); expect(credentials).not.toHaveBeenCalled();
});
it('reconciles identical creation but rejects conflicting content without overwriting it', async () => {
  const f = fixture(); await put(f); await put(f); await expect(put(f, Buffer.from('conflict'))).rejects.toThrow('reconciliation');
  expect(Buffer.from(f.objects.get(f.physical)!.body).toString()).toBe(bytes.toString());
});
it('accepts the observed opaque PUT acknowledgement only with exact available and retired HEAD readback', async () => {
  const f = fixture(); f.headers((h, method) => method === 'PUT' ? { ...h, 'x-amz-version-id': '7e5edb17b4baddcb2f3ac5e93ca76ea7' } : h);
  await put(f);
  expect(f.requests.map(r => r.method)).toEqual(['PUT', 'HEAD']);
  expect(await f.store.head(key)).toEqual({ bytes: bytes.length, sha256: sha(bytes), mime: 'video/webm' });
  await f.store.retire(key);
  expect(f.requests.slice(-2).map(r => r.method)).toEqual(['PUT', 'HEAD']);
  expect(await f.store.head(key)).toBeNull();
  expect(f.objects.get(f.physical)).toEqual({ body: new Uint8Array(), metadata: { state: 'retired' }, mime: 'application/octet-stream' });
  expect(f.requests.every(r => !('versionId' in r.query))).toBe(true);
});
it.each(['', 'x'.repeat(129), 'has space', 'line\nfeed', '\u0000', 'nonasciié'])('rejects malformed opaque PUT acknowledgement %j without replay or logical success', async version => {
  const f = fixture(); f.headers((h, method) => method === 'PUT' ? { ...h, 'x-amz-version-id': version } : h);
  await expect(put(f)).rejects.toThrow('reconciliation'); expect(f.requests.map(r => r.method)).toEqual(['PUT']);
  // A received write remains unknown until separate authority readback.
  expect(f.objects.get(f.physical)!.body).toEqual(Uint8Array.from(bytes));
});
it.each(['available', 'retired'])('never treats valid opaque PUT acknowledgement as %s success when HEAD is denied', async state => {
  const f = fixture(); f.headers((h, method) => method === 'PUT' ? { ...h, 'x-amz-version-id': '7e5edb17b4baddcb2f3ac5e93ca76ea7' } : h);
  f.fault(r => r.method === 'HEAD' ? error('AccessDenied', 403) : undefined);
  await expect(state === 'available' ? put(f) : f.store.retire(key)).rejects.toThrow('reconciliation');
  expect(f.requests.map(r => r.method)).toEqual(['PUT', 'HEAD']);
});
it('fences a delayed original conditional create when retirement wins', async () => {
  const f = fixture(), entered = deferred(), release = deferred(); f.gate(release.promise, entered.resolve);
  const late = put(f); await entered.promise; await f.store.retire(key); release.resolve();
  await expect(late).rejects.toThrow('reconciliation'); expect(await f.store.head(key)).toBeNull(); expect(f.objects.get(f.physical)!.body.length).toBe(0);
});
it('retires a committed creation idempotently without removing its fence', async () => {
  const f = fixture(); await put(f); await f.store.retire(key); await f.store.retire(key); await expect(put(f)).rejects.toThrow();
  expect(f.objects.get(f.physical)).toEqual({ body: new Uint8Array(), metadata: { state: 'retired' }, mime: 'application/octet-stream' });
  expect(f.requests.filter(r => r.method === 'PUT' && !r.headers['if-none-match'])).toHaveLength(2); expect(f.requests.some(r => r.method === 'DELETE')).toBe(false);
});
it.each([[409, 'ConditionalRequestConflict'], [412, 'OtherFailure'], [429, 'TooManyRequests'], [503, 'ServiceUnavailable'], [301, 'PermanentRedirect']])('retains %s/%s PUT as failure with exactly one wire attempt', async (code, name) => {
  const f = fixture(); f.fault(() => error(name, code)); await expect(put(f)).rejects.toThrow('reconciliation'); expect(f.requests).toHaveLength(1);
});
it('retains committed bytes after lost acknowledgement and only reconciles via HEAD', async () => {
  const f = fixture(); f.fault(request => {
    if (request.method !== 'PUT') return;
    f.objects.set(f.physical, { body: bytes, metadata: { state: 'available', sha256: sha(bytes) }, mime: 'video/webm' }); throw Error('synthetic lost acknowledgement');
  });
  await expect(put(f)).rejects.toThrow('reconciliation'); expect(await f.store.head(key)).toEqual({ bytes: bytes.length, sha256: sha(bytes), mime: 'video/webm' });
  expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
});
it('times out an ignored abort without replay, and fences the still-pending original PUT', async () => {
  const f = fixture({ deadlineMs: 30 }), entered = deferred(), release = deferred(); f.gate(release.promise, entered.resolve);
  const late = put(f); const rejection = expect(late).rejects.toThrow('reconciliation'); await entered.promise; await rejection;
  await f.store.retire(key); release.resolve(); await new Promise(r => setTimeout(r, 5));
  expect(f.objects.get(f.physical)!.metadata.state).toBe('retired'); expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(2);
});
it.each([[403, 'AccessDenied'], [404, 'NotFound'], [404, 'NoSuchBucket']])('never labels %s/%s HEAD as confirmed absence', async (code, name) => {
  const f = fixture(); f.fault(() => error(name, code)); await expect(f.store.head(key)).rejects.toThrow('reconciliation'); expect(f.requests.length).toBe(name === 'NotFound' ? 2 : 1);
});
it('classifies a bodyless missing HEAD using only a bounded GET and typed NoSuchKey, without listing', async () => {
  const f = fixture(); f.fault(r => r.method === 'HEAD' ? { response: { statusCode: 404, headers: {}, body: Readable.from([]) } } : undefined);
  expect(await f.port.head(key)).toBeNull();
  expect(f.requests.map(r => r.method)).toEqual(['HEAD', 'GET']); expect(f.requests[1].headers.range).toBe('bytes=0-0');
});
it('destroys a successful absence-probe body and fails closed rather than trusting contradictory HEAD404', async () => {
  const f = fixture(); await put(f); f.fault(r => r.method === 'HEAD' ? { response: { statusCode: 404, headers: {}, body: Readable.from([]) } } : undefined);
  await expect(f.port.head(key)).rejects.toThrow('reconciliation'); expect(f.lastBody()!.destroyed).toBe(true);
});
it.each([[403, 'AccessDenied'], [404, 'NoSuchBucket'], [404, 'NotFound'], [503, 'ServiceUnavailable']])('rejects absence-probe %s/%s without interpreting HEAD404 as proof', async (code, name) => {
  const f = fixture(); f.fault(r => r.method === 'HEAD' ? { response: { statusCode: 404, headers: {}, body: Readable.from([]) } } : error(name, code));
  await expect(f.port.head(key)).rejects.toThrow('reconciliation'); expect(f.requests.map(r => r.method)).toEqual(['HEAD', 'GET']);
});
it('shares one deadline across HEAD and absence probe, retaining a late missing result as unconfirmed', async () => {
  const f = fixture({ deadlineMs: 30 }); f.fault(async r => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return r.method === 'HEAD' ? { response: { statusCode: 404, headers: {}, body: Readable.from([]) } } : error('NoSuchKey', 404);
  });
  await expect(f.port.head(key)).rejects.toThrow('reconciliation'); expect(f.requests.map(r => r.method)).toEqual(['HEAD', 'GET']);
  await new Promise(resolve => setTimeout(resolve, 20)); // Finish the ignored-abort mock; no native process remains.
});
it('only a typed NoSuchKey/404 is object-missing; generic HEAD404 remains unconfirmed', async () => {
  const f = fixture(); const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('synthetic typed missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }));
  expect(await f.port.head(key)).toBeNull(); expect(await f.port.get(key, { start: 0, end: 0 })).toBeNull(); expect(send).toHaveBeenCalledTimes(2);
});
it('keeps retirement pending on 429 and does not fall back to DELETE or hide content', async () => {
  const f = fixture(); await put(f); f.fault(r => r.method === 'PUT' ? error('TooManyRequests', 429) : undefined);
  await expect(f.store.retire(key)).rejects.toThrow('reconciliation'); expect(f.objects.get(f.physical)!.body.length).toBe(bytes.length);
  expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(2); expect(f.requests.some(r => r.method === 'DELETE')).toBe(false);
});
it.each(['length', 'mime', 'state', 'extra', 'hash', 'etag', 'encoding', 'version'])('rejects malformed/stale HEAD %s', async field => {
  const f = fixture(); await put(f); f.headers(h => ({ ...h, ...({ length: { 'content-length': '4000001' }, mime: { 'content-type': 'text/html' }, state: { 'x-amz-meta-state': 'unknown' }, extra: { 'x-amz-meta-extra': 'x' }, hash: { 'x-amz-meta-sha256': 'invalid' }, etag: { etag: 'unquoted' }, encoding: { 'content-encoding': 'gzip' }, version: { 'x-amz-version-id': 'old' } }[field]) }));
  await expect(f.store.head(key)).rejects.toThrow('reconciliation');
});
it('rejects retirement between HEAD and GET through the exact ETag precondition', async () => {
  const f = fixture(); await put(f); f.beforeGet(() => f.store.retire(key));
  await expect(f.store.read(key, { start: 0, end: 2 })).rejects.toThrow('reconciliation'); expect(await f.store.head(key)).toBeNull();
});
it.each(['range', 'etag', 'sha', 'mime'])('rejects changed GET %s before bytes and destroys its body', async field => {
  const f = fixture(); await put(f); f.headers((h, method) => method === 'GET' ? { ...h, ...({ range: { 'content-range': 'bytes 0-1/2' }, etag: { etag: '"different"' }, sha: { 'x-amz-meta-sha256': '0'.repeat(64) }, mime: { 'content-type': 'audio/webm' } }[field]) } : h);
  await expect(f.store.read(key, { start: 0, end: 2 })).rejects.toThrow('reconciliation'); expect(f.lastBody()!.destroyed).toBe(true);
});
it.each(['short', 'overflow', 'hash'])('rejects %s full read rather than accepting complete content', async kind => {
  const f = fixture(); await put(f); f.stream(b => Readable.from([kind === 'short' ? b.subarray(1) : kind === 'overflow' ? Buffer.concat([b, Buffer.from('x')]) : new Uint8Array(b.length)]));
  await expect(new Response(await f.store.read(key, { start: 0, end: bytes.length - 1 })).arrayBuffer()).rejects.toThrow('reconciliation'); expect(f.lastBody()!.destroyed).toBe(true);
});
it('cancels a native idle body immediately and applies the shared operation deadline to streaming', async () => {
  const f = fixture({ deadlineMs: 30 }); await put(f); f.stream(() => new Readable({ read() {} }));
  const stream = await f.store.read(key, { start: 0, end: 1 }); await stream.cancel(); expect(f.lastBody()!.destroyed).toBe(true);
  await expect(new Response(await f.store.read(key, { start: 0, end: 1 })).arrayBuffer()).rejects.toThrow('reconciliation'); expect(f.lastBody()!.destroyed).toBe(true);
});
it('accepts exactly 4MB with bounded chunks; rejects extra byte and invalid inputs before dispatch', async () => {
  const f = fixture(), exact = Buffer.alloc(4000000, 7); await put(f, exact);
  const reader = (await f.store.read(key, { start: 0, end: exact.length - 1 })).getReader(); let count = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; expect(next.value.length).toBeLessThanOrEqual(256000); count += next.value.length; }
  expect(count).toBe(exact.length); const before = f.requests.length;
  await expect(put(f, Buffer.alloc(4000001))).rejects.toThrow();
  await expect(f.port.put('../foreign', bytes, { ifAbsent: true, metadata: { state: 'available', sha256: sha(bytes) }, contentType: 'video/webm' })).rejects.toThrow();
  await expect(f.port.put(key, bytes, { ifAbsent: false, metadata: { state: 'retired' }, contentType: 'application/octet-stream' })).rejects.toThrow();
  await expect(f.port.put(key, bytes, { ifAbsent: true, metadata: { state: 'available', sha256: '0'.repeat(64) }, contentType: 'video/webm' })).rejects.toThrow();
  await expect(f.port.get(key, { start: 0, end: 4000000 })).rejects.toThrow(); expect(f.requests.length).toBe(before);
});

it('coalesces small SDK fragments into bounded authorized blocks without changing bytes or range semantics', async () => {
  const f = fixture(), body = Buffer.alloc(306347, 7); await put(f, body);
  f.stream(value => Readable.from(Array.from({ length: Math.ceil(value.length / 16384) }, (_, i) => value.subarray(i * 16384, (i + 1) * 16384))));
  for (const range of [{ start: 0, end: body.length - 1 }, { start: 100, end: 256099 }]) {
    const reader = (await f.store.read(key, range)).getReader(), chunks: Uint8Array[] = [];
    for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
    expect(chunks.map(chunk => chunk.byteLength)).toEqual(range.start === 0 ? [256000, 50347] : [256000]);
    expect(Buffer.concat(chunks)).toEqual(body.subarray(range.start, range.end + 1));
    expect(f.lastBody()?.destroyed).toBe(true);
  }
});
