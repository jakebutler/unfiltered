import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { LocalPrivateObjectStore } from '../src/local-store';
import { CAPTURE_LIMITS, byteRange, captureLimits, digest } from '../src/contracts';
import { mediaGateway, cleanupObjects, type AuthorizedMedia, type CaptureAuthority } from '../src/gateway';
import { acceptPrototypeMessage } from '../src/dom';
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'corvo-capture-')); folders.push(directory);
  const store = new LocalPrivateObjectStore(directory), bytes = new TextEncoder().encode('a real synthetic recording segment'), sha256 = await digest(bytes);
  const row: AuthorizedMedia = { id: 'segment1', key: 'research/session1/segment1-a0', attempt: 0, retryUntil: Date.now() + 600_000, claimUntil: Date.now() + 120_000, leaseUntil: Date.now() + 10_000, state: 'reserved', descriptor: { modality: 'microphone', sequence: 0, startMs: 0, endMs: 1000, bytes: bytes.length, sha256, mime: 'audio/webm', questionId: 'q1', sourceId: null } };
  let allowed = true, claims = 0, reads = 0, writes = 0, deleted = false, objectWrites = 0;
  const originalPut = store.putIfAbsent.bind(store); store.putIfAbsent = async (...args) => { objectWrites++; return originalPut(...args); };
  const authority: CaptureAuthority = {
    async claim(token, _, attempt) { if (token !== 'test-token' || !allowed || attempt !== row.attempt || !['reserved', 'available'].includes(row.state)) throw new Error('deny'); if (row.state !== 'available') { claims++; row.state = 'uploading'; row.leaseUntil = Date.now() + 10_000; } return { ...row }; },
    async inspect() { if (!allowed) throw new Error('deny'); return { ...row }; },
    async beginRetry(_, __, attempt) { if (!allowed || attempt !== row.attempt || row.leaseUntil > Date.now() || row.attempt >= 2) throw new Error('deny'); row.state = 'retry-fencing'; return { ...row }; },
    async activateRetry(_, __, attempt, retiredKey) { if (!allowed || row.state !== 'retry-fencing' || attempt !== row.attempt || retiredKey !== row.key) throw new Error('deny'); row.attempt++; row.key = `research/session1/segment1-a${row.attempt}`; row.state = 'reserved'; row.leaseUntil = 0; row.claimUntil = Date.now() + 120_000; return { ...row }; },
    async finalize(_, attempt, stored) { if (!allowed || attempt !== row.attempt || row.state === 'retry-fencing' || stored.sha256 !== sha256) return false; writes++; row.state = 'available'; return true; },
    async read(token) { reads++; if (!allowed || token !== 'test-jwt' || row.state !== 'available') throw new Error('deny'); return row; },
    async cleanup() { return allowed ? [] : [row]; }, async deleted() { deleted = true; },
  };
  const origin = 'http://localhost:8888', gateway = mediaGateway(store, authority, { origin });
  const upload = (body: Uint8Array = bytes) => gateway(new Request(`${origin}/api/research-media/segment1`, { method: 'PUT', headers: { Origin: origin, 'X-Research-Participant': 'test-token', 'Content-Length': String(body.length) }, body: body as BodyInit }));
  const read = (range?: string) => gateway(new Request(`${origin}/api/research-media/segment1?clientId=client1&projectId=project1&sessionId=session1`, { headers: { Origin: origin, Authorization: 'Bearer test-jwt', ...(range ? { Range: range } : {}) } }));
  return { directory, store, bytes, row, authority, gateway, origin, upload, read, revoke: () => { allowed = false; }, receipts: () => ({ claims, reads, writes, deleted, objectWrites }) };
}
describe('private media gateway and local object authority', () => {
  test('bytes survive storage and exact ranges with no-store; no bucket URL is emitted', async () => {
    const f = await fixture(); expect((await f.upload()).status).toBe(200);
    const response = await f.read('bytes=2-8');
    expect(response.status).toBe(206); expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes.slice(2, 9));
    expect(response.headers.get('Location')).toBeNull(); expect(f.receipts().writes).toBe(1);
  });
  test('missing or foreign origins cannot touch upload/read authority', async () => {
    const f = await fixture();
    for (const origin of ['', 'https://foreign.example']) expect((await f.gateway(new Request(`${f.origin}/api/research-media/segment1`, { method: 'PUT', headers: { Origin: origin } }))).status).toBe(403);
    expect(f.receipts().claims).toBe(0);
  });
  test('corrupt bytes are never stored; ambiguous receipt is reconciled without redispatch', async () => {
    const f = await fixture(), corrupt = f.bytes.slice(); corrupt[0] ^= 1;
    expect((await f.upload(corrupt)).status).toBe(409); expect(await f.store.head(f.row.key)).toBeNull();
    const g = await fixture(); await g.store.putIfAbsent(g.row.key, g.bytes, { bytes: g.bytes.length, sha256: g.row.descriptor.sha256, mime: 'audio/webm' });
    const recovered = await g.gateway(new Request(`${g.origin}/api/research-media/segment1`, { method: 'POST', headers: { Origin: g.origin, 'X-Research-Participant': 'test-token' } }));
    expect(recovered.status).toBe(200); expect(g.receipts().claims).toBe(0); expect(g.receipts().writes).toBe(1);
  });
  test('revocation before the next emitted chunk stops an already-authorized stream', async () => {
    const f = await fixture(); await f.upload(); const response = await f.read(); f.revoke();
    await expect(response.arrayBuffer()).rejects.toThrow('access ended');
  });
  test('cleanup persists a zero-byte tombstone that prevents delayed byte resurrection', async () => {
    const f = await fixture(); await f.upload(); f.revoke(); expect(await cleanupObjects(f.store, f.authority)).toBe(1);
    expect(f.receipts().deleted).toBe(true); expect(await f.store.head(f.row.key)).toBeNull();
    await expect(f.store.putIfAbsent(f.row.key, f.bytes, { bytes: f.bytes.length, sha256: f.row.descriptor.sha256, mime: 'audio/webm' })).rejects.toThrow('retired');
    expect((await readdir(f.directory)).filter(name => name.startsWith('.'))).toEqual([]);
    await expect(f.store.read(f.row.key, { start: 0, end: 2 })).rejects.toThrow('unavailable');
  });
  test('object keys cannot escape the private store and ranges cannot be multipart or excessive', async () => {
    const f = await fixture(); await expect(f.store.head('../../outside')).rejects.toThrow('key');
    expect(byteRange('bytes=-4', 20)).toEqual({ start: 16, end: 19, partial: true });
    for (const range of ['bytes=0-1,4-5', 'bytes=30-', 'bytes=-0', 'bytes=4-2']) expect(() => byteRange(range, 20)).toThrow();
    expect(() => captureLimits(JSON.stringify({ segmentBytes: CAPTURE_LIMITS.segmentBytes + 1 }))).toThrow();
  });
});
describe('controlled prototype bridge', () => {
  test('requires actual window identity, origin, challenge and strict masked schema', () => {
    const window = {} as Window, origin = 'https://prototype.example', challenge = 'd'.repeat(64);
    const expected = { window, origin, challenge };
    const data = { version: 'corvo-dom-1', challenge, event: { sequence: 1, atMs: 120, kind: 'click', target: 'c1', tag: 'button', x: null, y: null } };
    const event = { source: window, origin, data } as unknown as MessageEvent;
    expect(acceptPrototypeMessage(event, expected)).toEqual(data.event);
    for (const changed of [{ ...event, source: {} }, { ...event, origin: 'https://evil.example' }, { ...event, data: { ...data, challenge: 'a'.repeat(64) } }, { ...event, data: { ...data, event: { ...data.event, text: 'private form contents' } } }]) expect(acceptPrototypeMessage(changed as MessageEvent, expected)).toBeNull();
  });
});

describe('S5 independent-review transport counterexamples', () => {
  test('R2: invalid content length does not consume a claim, and the correct bytes remain uploadable', async () => {
    const f = await fixture();
    const bad = new Request(`${f.origin}/api/research-media/segment1`, { method: 'PUT', headers: { Origin: f.origin, 'X-Research-Participant': 'test-token', 'Content-Length': '999' }, body: f.bytes as BodyInit });
    expect((await f.gateway(bad)).status).toBe(413); expect(f.receipts().claims).toBe(0);
    expect((await f.upload()).status).toBe(200); expect(f.receipts().objectWrites).toBe(1);
  });
  test.each(['truncated body', 'checksum mismatch', 'pre-write network loss'])('R2: correct locally retained bytes recover after %s through a fresh fenced attempt', async failure => {
    const f = await fixture();
    let body: BodyInit = f.bytes.slice(0, f.bytes.length - 1) as BodyInit;
    if (failure === 'checksum mismatch') { const corrupt = f.bytes.slice(); corrupt[0] ^= 1; body = corrupt as BodyInit; }
    if (failure === 'pre-write network loss') body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('connection lost')); } });
    const bad = new Request(`${f.origin}/api/research-media/segment1`, { method: 'PUT', headers: { Origin: f.origin, 'X-Research-Participant': 'test-token', 'Content-Length': String(f.bytes.length) }, body, duplex: 'half' } as RequestInit);
    expect((await f.gateway(bad)).status).toBe(409); expect(f.receipts().objectWrites).toBe(0);
    const oldKey = f.row.key;
    const reconcile = () => f.gateway(new Request(`${f.origin}/api/research-media/segment1`, { method: 'POST', headers: { Origin: f.origin, 'X-Research-Participant': 'test-token' } }));
    expect((await reconcile()).status).toBe(409); // An unresolved live writer cannot be reset.
    f.row.leaseUntil = Date.now() - 1;
    expect((await reconcile()).status).toBe(200); expect(f.row.attempt).toBe(1); expect(f.row.key).not.toBe(oldKey);
    expect(await f.store.head(oldKey)).toBeNull();
    expect((await f.upload()).status).toBe(200); expect(f.receipts().objectWrites).toBe(1);
    expect((await f.store.head(f.row.key))?.sha256).toBe(f.row.descriptor.sha256);
  });
  test('R2: successful object write with a lost receipt reconciles without another object write', async () => {
    const f = await fixture(), originalFinalize = f.authority.finalize; let lose = true;
    f.authority.finalize = async (...args) => { if (lose) { lose = false; throw new Error('receipt connection lost'); } return originalFinalize(...args); };
    expect((await f.upload()).status).toBe(409); expect(f.receipts().objectWrites).toBe(1);
    const result = await f.gateway(new Request(`${f.origin}/api/research-media/segment1`, { method: 'POST', headers: { Origin: f.origin, 'X-Research-Participant': 'test-token' } }));
    expect(result.status).toBe(200); expect(f.receipts().objectWrites).toBe(1); expect(f.row.attempt).toBe(0);
  });
  test('R2: a delayed old conditional writer cannot resurrect bytes after a retry fence', async () => {
    const f = await fixture(), originalPut = f.store.putIfAbsent.bind(f.store), oldKey = f.row.key;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), dispatched = new Promise<void>(resolve => { entered = resolve; });
    f.store.putIfAbsent = async (...args) => { if (args[0] === oldKey) { entered(); await gate; } return originalPut(...args); };
    const oldUpload = f.upload(); await dispatched;
    f.row.leaseUntil = Date.now() - 1;
    const retry = await f.gateway(new Request(`${f.origin}/api/research-media/segment1`, { method: 'POST', headers: { Origin: f.origin, 'X-Research-Participant': 'test-token' } }));
    expect(retry.status).toBe(200); expect(f.row.attempt).toBe(1);
    release(); expect((await oldUpload).status).toBe(409);
    expect(await f.store.head(oldKey)).toBeNull(); expect((await f.upload()).status).toBe(200);
    expect((await f.store.head(f.row.key))?.sha256).toBe(f.row.descriptor.sha256);
  });
  test('R5: revocation during stalled object I/O prevents its eventual chunk from being enqueued', async () => {
    const f = await fixture(); await f.upload();
    let release!: () => void, reached!: () => void, canceled = false;
    const authorizedBeforeRead = new Promise<void>(resolve => { reached = resolve; });
    f.store.read = async () => new ReadableStream<Uint8Array>({ start(controller) { release = () => controller.enqueue(f.bytes); }, cancel() { canceled = true; } });
    const originalRead = f.authority.read; let reads = 0;
    f.authority.read = async (...args) => { const value = await originalRead(...args); if (++reads === 3) reached(); return value; };
    const response = await f.read(), consume = response.arrayBuffer(); await authorizedBeforeRead;
    f.revoke(); release();
    await expect(consume).rejects.toThrow('access ended');
    expect(canceled).toBe(true);
  });
});
