import { afterEach, describe, expect, it, vi } from 'vitest';
const sideEffects = vi.hoisted(() => ({ localStore: vi.fn(), worker: vi.fn() }));
vi.mock('../../../packages/research-capture/src/local-store', () => ({ LocalPrivateObjectStore: class { constructor() { sideEffects.localStore(); throw new Error('Filesystem fallback forbidden'); } } }));
vi.mock('../src/worker', () => ({ startCleanupWorker: sideEffects.worker }));
import { createHostedResearchHandler, parseHostedConfig, HOSTED_BYTE_CAP as cap, HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE } from '../src/hosted-runtime';
import type { CaptureAuthority, AuthorizedMedia } from '../../../packages/research-capture/src/gateway';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
import { fakeHostedAuthority } from './hosted-test-authority';
import type { ReportAuthority } from '../src/report-authority';
const origin = 'https://research.example.test', host = 'research.example.test', manifest = { canonicalOrigin: origin };
const config = { mode: 'hosted', deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, publicOrigin: origin, gatewaySecret: 'a'.repeat(64), maxSegmentBytes: cap, maxResponseBytes: cap, cleanupMode: 'durable' };
afterEach(() => vi.unstubAllEnvs());
function fixture(size = 20) {
  const row: AuthorizedMedia = { id: 'media', key: 'research/session/media-a0', attempt: 0, state: 'reserved', retryUntil: Date.now() + 60_000, claimUntil: Date.now() + 60_000, leaseUntil: Date.now() + 60_000, descriptor: { modality: 'screen', sequence: 0, startMs: 0, endMs: 1000, bytes: size, sha256: 'b'.repeat(64), mime: 'video/webm', questionId: 'q1', sourceId: null } };
  const authority = { read: vi.fn(async () => row), inspect: vi.fn(async () => row), claim: vi.fn(async () => row), finalize: vi.fn(async () => true), cleanup: vi.fn(), deleted: vi.fn() } as unknown as CaptureAuthority;
  const store = { head: vi.fn(async () => ({ bytes: size, sha256: row.descriptor.sha256, mime: 'video/webm' })), read: vi.fn(async (_key, range) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(range.end - range.start + 1)); c.close(); } })), putIfAbsent: vi.fn(), retire: vi.fn() } as unknown as PrivateObjectStore;
  const report = { operator: vi.fn(async () => ({})), availableReservations: vi.fn(), published: vi.fn(async () => ({ title: 'fixture', evidence: [], findings: [], grants: [], excerpts: [] })) } as unknown as ReportAuthority;
  const handler = createHostedResearchHandler(config, manifest, { store, captureAuthority: authority, reportFactory: () => report, hostedAuthority: fakeHostedAuthority() });
  const get = (path = '/capture/media/media', extra: Record<string, string> = {}) => new Request(`${origin}${path}`, { headers: { Host: host, Origin: origin, Authorization: 'Bearer synthetic', ...extra } });
  return { row, store, authority, report, handler, get };
}
describe('explicit hosted research injection (offline; no hosted activation)', () => {
  it('pins canonical manifest origin and both exact Convex targets without env/storage fallback', () => {
    expect(parseHostedConfig(config, manifest).publicOrigin).toBe(origin);
    for (const changed of [{ deployment: 'https://other.convex.cloud' }, { convexSite: 'https://elegant-crane-662.convex.site/redirect' }, { publicOrigin: 'https://preview.example.test' }, { cleanupMode: 'process' }, { maxSegmentBytes: cap + 1 }, { maxResponseBytes: cap + 1 }, { apiKey: 'never-echo-this' }]) expect(() => parseHostedConfig({ ...config, ...changed }, manifest)).toThrow('Invalid explicit');
    for (const canonicalOrigin of ['http://research.example.test', `${origin}/`, `${origin}:443`, 'https://user@research.example.test']) expect(() => parseHostedConfig(config, { canonicalOrigin })).toThrow();
    expect(() => createHostedResearchHandler(config, manifest, {} as any)).toThrow('Explicit private object store');
    expect(sideEffects.localStore).not.toHaveBeenCalled(); expect(sideEffects.worker).not.toHaveBeenCalled();
  });
  it('fails wrong/ambiguous raw Host, URL and forwarded-origin spoof before any authority/body/storage call', async () => {
    const f = fixture();
    for (const request of [f.get(undefined, { Host: 'attacker.test', 'X-Forwarded-Host': host }), f.get(undefined, { Host: `${host}:443` }), f.get(undefined, { Origin: 'https://attacker.test', 'X-Forwarded-Origin': origin }), new Request('https://attacker.test/capture/media/media', { headers: { Host: host, Origin: origin } })]) { expect((await f.handler(request)).status).toBe(403); }
    const pull = vi.fn(), request = new Request(`${origin}/capture/media/media`, { method: 'PUT', headers: { Host: 'attacker.test', Origin: origin, 'Content-Length': '1' }, body: new ReadableStream({ pull }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
    expect((await f.handler(request)).status).toBe(403); expect(pull).not.toHaveBeenCalled(); expect(f.authority.inspect).not.toHaveBeenCalled(); expect(f.authority.read).not.toHaveBeenCalled(); expect(f.store.head).not.toHaveBeenCalled();
  });
  it('preserves qualified same-origin bearer/cookie GET while consent/auth still deny bytes', async () => {
    const f = fixture(), authenticated = new Request(`${origin}/capture/media/media`, { headers: { Host: host, Authorization: 'Bearer synthetic', 'Sec-Fetch-Site': 'same-origin', Referer: `${origin}/interview/example` } });
    const response = await f.handler(authenticated); expect(response.status).toBe(200); await response.arrayBuffer();
    const cookie = new Request(`${origin}/api/research/portal/report?slug=${'1'.repeat(32)}`, { headers: { Host: host, Cookie: `research_viewer=${'2'.repeat(64)}`, 'Sec-Fetch-Site': 'same-origin', Referer: `${origin}/report/fixture` } });
    const portal = await f.handler(cookie); expect(portal.status).toBe(200); await portal.json();
    const before = vi.mocked(f.store.read).mock.calls.length;
    vi.mocked(f.authority.read).mockRejectedValue(new Error('Consent withdrawn')); const denied = await f.handler(f.get()); expect(denied.status).toBe(409); await denied.text(); expect(vi.mocked(f.store.read).mock.calls.length).toBe(before);
    const cross = new Request(cookie.url, { headers: { Host: host, Cookie: cookie.headers.get('Cookie')!, 'Sec-Fetch-Site': 'cross-site', Referer: 'https://attacker.test' } }); expect((await f.handler(cross)).status).toBe(403);
  });
  it('keeps analysis provider off despite inherited key/env and never starts worker or local store', async () => {
    vi.stubEnv('DIGITALOCEAN_MODEL_ACCESS_KEY', 'synthetic-env-that-must-not-activate'); const f = fixture();
    const response = await f.handler(f.get('/api/research/analysis/readiness')); expect((await response.json()).state).toBe('disabled'); expect(f.report.operator).toHaveBeenCalledOnce(); expect(f.report.availableReservations).not.toHaveBeenCalled(); expect(sideEffects.worker).not.toHaveBeenCalled(); expect(sideEffects.localStore).not.toHaveBeenCalled();
  });
  it('rejects oversized declared/chunked ingress before upload admission and streamed excess before storage write', async () => {
    const f = fixture(1), make = (headers: Record<string, string>, body: Uint8Array) => new Request(`${origin}/capture/media/media`, { method: 'PUT', headers: { Host: host, Origin: origin, 'X-Research-Participant': 'synthetic', ...headers }, body });
    expect((await f.handler(make({ 'Content-Length': String(cap + 1) }, new Uint8Array(1)))).status).toBe(413);
    expect((await f.handler(make({ 'Content-Length': '1', 'Transfer-Encoding': 'chunked' }, new Uint8Array(1)))).status).toBe(413); expect(f.authority.inspect).not.toHaveBeenCalled();
    const excess = await f.handler(make({ 'Content-Length': '1' }, new Uint8Array(2))); expect(excess.status).toBe(409); await excess.text(); expect(f.store.putIfAbsent).not.toHaveBeenCalled(); expect(f.authority.finalize).not.toHaveBeenCalled();
  });
  it('rejects an oversized whole object before reading bytes but permits exact4MB ranges with consent checks', async () => {
    const f = fixture(cap + 1), whole = await f.handler(f.get()); expect(whole.status).toBe(409); await whole.text(); expect(f.store.read).not.toHaveBeenCalled();
    const bounded = await f.handler(f.get(undefined, { Range: `bytes=0-${cap - 1}` })); expect(bounded.status).toBe(206); expect(bounded.headers.get('Content-Length')).toBe(String(cap)); expect((await bounded.arrayBuffer()).byteLength).toBe(cap); expect(vi.mocked(f.authority.read).mock.calls.length).toBeGreaterThan(10);
  });
  it('fails overlong/incomplete streamed ranges rather than truncating apparent successful content', async () => {
    const f = fixture(20); vi.mocked(f.store.read).mockResolvedValueOnce(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(21)); c.close(); } }));
    const excess = await f.handler(f.get()); expect(excess.status).toBe(200); await expect(excess.arrayBuffer()).rejects.toThrow();
    vi.mocked(f.store.read).mockResolvedValueOnce(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(19)); c.close(); } })); const short = await f.handler(f.get()); await expect(short.arrayBuffer()).rejects.toThrow();
  });
  it('still denies the next protected chunk after consent withdrawal midstream', async () => {
    const f = fixture(300_000), response = await f.handler(f.get()), reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(256_000);
    vi.mocked(f.authority.read).mockRejectedValue(new Error('Consent withdrawn')); await expect(reader.read()).rejects.toThrow();
  });
  it('caps undeclared/chunked report responses and releases process admission after cancellation/error', async () => {
    const f = fixture(); vi.mocked(f.report.published).mockResolvedValue({ title: 'x'.repeat(cap + 1) } as any);
    const huge = await f.handler(f.get(`/api/research/portal/report?slug=${'1'.repeat(32)}`, { Cookie: `research_viewer=${'2'.repeat(64)}` })); expect(huge.headers.get('Content-Length')).toBeNull(); await expect(huge.arrayBuffer()).rejects.toThrow('Hosted response');
    const held = await Promise.all([1, 2, 3, 4].map(() => f.handler(f.get('/api/research/analysis/readiness')))); expect((await f.handler(f.get('/api/research/analysis/readiness'))).status).toBe(429);
    await held[0].body?.cancel(); const released = await f.handler(f.get('/api/research/analysis/readiness')); expect(released.status).toBe(200); await released.json(); await Promise.all(held.slice(1).map(r => r.body?.cancel()));
  });
});

