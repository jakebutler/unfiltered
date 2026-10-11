import type { StudyRuntimeFacts } from '../../../packages/research-core/src/readiness';
/** Explicit packaging boundary only. Not mounted by the local CLI or any platform entrypoint. */
import { z } from 'zod';
import { createResearchGateways } from './server';
import { trustedFacadeOrigin } from './origin';
import { convexCaptureAuthority } from '../../../packages/research-capture/src/convex-authority';
import type { CaptureAuthority } from '../../../packages/research-capture/src/gateway';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
import { PRIVATE_HEADERS } from '../../../packages/research-capture/src/protected-read';
import type { AnalysisRuntime } from './analysis';
import { reportAuthority, type ReportAuthority } from './report-authority';
import { abortable, convexHostedAuthority, leaseIdentity, newLeaseOwner, type HostedAuthority, type HostedLease, type LeaseKind, type QuotaOperation } from './hosted-admission';
import { runHostedCleanup, validateCleanupRequest } from './hosted-cleanup';

export const HOSTED_DEPLOYMENT = 'https://elegant-crane-662.convex.cloud';
export const HOSTED_CONVEX_SITE = 'https://elegant-crane-662.convex.site';
export const HOSTED_BYTE_CAP = 4_000_000;
const schema = z.object({ mode: z.literal('hosted'), deployment: z.literal(HOSTED_DEPLOYMENT), convexSite: z.literal(HOSTED_CONVEX_SITE), publicOrigin: z.string(), gatewaySecret: z.string().regex(/^[a-f0-9]{64,128}$/), maxSegmentBytes: z.number().int().min(1).max(HOSTED_BYTE_CAP), maxResponseBytes: z.number().int().min(1).max(HOSTED_BYTE_CAP), cleanupMode: z.literal('durable'), allocationId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional(), cleanupAllocationId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional() }).strict();
export type HostedResearchConfig = Readonly<Omit<z.infer<typeof schema>, 'deployment' | 'convexSite'> & { deployment: string; convexSite: string }>;
export type ResearchIdentityBinding = { canonicalOrigin: string; deployment?: string; convexSite?: string };
export function parseHostedConfig(raw: unknown, manifest: ResearchIdentityBinding): HostedResearchConfig {
  const explicit = manifest.deployment !== undefined || manifest.convexSite !== undefined;
  const validOrigin = (value: unknown) => { try { const u = new URL(String(value)); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password && !u.port; } catch { return false; } };
  if (explicit && (!validOrigin(manifest.deployment) || !validOrigin(manifest.convexSite) || new Set([manifest.canonicalOrigin, manifest.deployment, manifest.convexSite]).size !== 3)) throw new Error('Invalid explicit research identity binding');
  const boundSchema = explicit ? schema.extend({ deployment: z.literal(manifest.deployment!), convexSite: z.literal(manifest.convexSite!) }) : schema;
  const parsed = boundSchema.safeParse(raw); let canonical = false;
  try { const url = new URL(manifest.canonicalOrigin); canonical = url.protocol === 'https:' && url.origin === manifest.canonicalOrigin && !url.username && !url.password && !url.port; } catch { /* fail closed */ }
  if (!parsed.success || parsed.data.cleanupAllocationId !== undefined && (!parsed.data.allocationId || parsed.data.cleanupAllocationId === parsed.data.allocationId) || !canonical || parsed.data.publicOrigin !== manifest.canonicalOrigin) throw new Error('Invalid explicit hosted research configuration');
  return Object.freeze(parsed.data);
}
export type HostedResearchInjection = { readinessFacts?: () => StudyRuntimeFacts; store: PrivateObjectStore; captureAuthority?: CaptureAuthority; reportFactory?: (bearer: string | null, signal: AbortSignal) => ReportAuthority; analysisRuntime?: AnalysisRuntime; hostedAuthority?: HostedAuthority; cleanupAuthority?: HostedAuthority; requestGateway?: (request: Request, context: { signal: AbortSignal; call<T>(operation: () => Promise<T>): Promise<T> }) => Promise<Response | undefined> };
const denied = (status: number, text: string) => new Response(text, { status, headers: PRIVATE_HEADERS });
function kindFor(request: Request, path: string): LeaseKind {
  if (request.method === 'PUT') return 'upload';
  if (request.method === 'POST' && ['/api/research/analysis', '/api/research/interview'].includes(path)) return 'analysis';
  if (request.method === 'POST' && ['/api/research/shares', '/api/research/portal/unlock'].includes(path)) return 'password';
  if (request.method === 'GET' && (/^\/capture\/media\//.test(path) || /^\/api\/research\/portal\/(source|download)/.test(path))) return 'read';
  return 'operation';
}
/** Native lease is held through response settlement. A never-settling operation
 * keeps workStarted occupied after expiry; there is no timed release pretending
 * an uncancellable KDF or remote accepted write has stopped. */
function lifetime(lease: HostedLease, authority: HostedAuthority, requestSignal: AbortSignal) {
  const abort = new AbortController(), identity = leaseIdentity(lease), pending = new Set<Promise<unknown>>();
  let finished = false, released = false, ownsWork = false, cancellationUnknown = false;
  let resolveRelease!: () => void, rejectRelease!: (error: Error) => void;
  const releaseAcknowledged = new Promise<void>((resolve, reject) => { resolveRelease = resolve; rejectRelease = reject; });
  void releaseAcknowledged.catch(() => undefined);
  const release = () => { if (ownsWork && finished && pending.size === 0 && !cancellationUnknown && !released) {
    released = true;
    void authority.release(identity).then(accepted => { if (accepted) resolveRelease(); else rejectRelease(new Error('Hosted release unresolved')); }, () => rejectRelease(new Error('Hosted release unresolved')));
  } };
  const cancel = (operation: () => Promise<unknown>) => {
    try {
      const settlement = operation().then(() => undefined, () => { cancellationUnknown = true; throw new Error('Hosted cancellation unknown'); });
      pending.add(settlement); const settled = () => { pending.delete(settlement); release(); }; void settlement.then(settled, settled);
      return settlement;
    } catch { cancellationUnknown = true; return Promise.resolve(); }
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(value => {
      if (Date.now() >= lease.responseDeadlineAt) abort.abort();
      // Header/resource acquisition after abort is not stream settlement. Register
      // disposal BEFORE dropping the original promise or attempting slot release.
      if (finished || abort.signal.aborted) {
        if (value instanceof Response && value.body) cancel(() => value.body!.cancel());
        else if (value instanceof ReadableStream) cancel(() => value.cancel());
      }
      pending.delete(promise); release();
    }, () => { pending.delete(promise); release(); });
    return abortable(promise, abort.signal);
  };
  const acknowledgeBegin = () => {
    if (finished || abort.signal.aborted || Date.now() >= lease.responseDeadlineAt) throw new Error('Gateway work ownership unknown');
    ownsWork = true;
  };
  let ordinal = 0, reservationTail: Promise<void> = Promise.resolve();
  const reserve = (kind: QuotaOperation, readBytes = 0): Promise<void> => {
    // Trusted injected test/local authorities retain their prior composition.
    // Allocated native leases cannot use that compatibility path.
    if (!authority.reserveOperation) return lease.allocationId ? Promise.reject(new Error('Quota authority unavailable')) : Promise.resolve();
    const task = reservationTail.then(async () => {
      if (!ownsWork || finished || abort.signal.aborted) throw new Error('Quota work unavailable');
      if (!await track(authority.reserveOperation!({ ...identity, ordinal: ++ordinal, kind, readBytes }))) throw new Error('Finite gateway allocation unavailable');
      if (abort.signal.aborted) throw new Error('Quota outcome unresolved');
    });
    reservationTail = task; return task;
  };
  const deadline = setTimeout(() => abort.abort(), Math.max(1, lease.responseDeadlineAt - Date.now()));
  const disconnect = () => abort.abort(); requestSignal.addEventListener('abort', disconnect, { once: true }); if (requestSignal.aborted) abort.abort();
  const finish = () => { if (finished) return; finished = true; clearTimeout(deadline); requestSignal.removeEventListener('abort', disconnect); abort.abort(); release(); };
  // A successful response must keep the platform invocation alive through the
  // native release acknowledgement. A timeout is an unresolved hold, not release.
  let settlementWait: Promise<void> | undefined;
  const settle = () => {
    finish();
    return settlementWait ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([releaseAcknowledged, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Hosted release unresolved')), 10_000); })]); }
      finally { clearTimeout(timer); }
    })();
  };
  const settleKnown = async () => {
    finish();
    // Keep the invocation alive while owned checks/cancellation settle. The
    // bounded wait never releases pending work or an unknown cancellation.
    for (let n = 0; n < 3; n++) await Promise.resolve();
    if (ownsWork && !cancellationUnknown) await settle();
  };
  const check = async () => {
    if (abort.signal.aborted || Date.now() >= lease.responseDeadlineAt) throw new Error('Hosted deadline ended');
    await reserve('authority');
    const current = await track(authority.inspect(identity));
    if (!current || current.kind !== lease.kind || current.expiresAt !== lease.expiresAt) throw new Error('Hosted lease changed');
  };
  const call = async <T>(operation: () => Promise<T>) => { await check(); const value = await track(operation()); if (abort.signal.aborted) throw new Error('Hosted deadline ended'); return value; };
  return { signal: abort.signal, track, cancel, acknowledgeBegin, reserve, check, call, finish, settle, settleKnown };
}
type Lifetime = ReturnType<typeof lifetime>;
function streamBody(body: ReadableStream<Uint8Array>, limit: number, work: Lifetime, expected?: number, finished: (failed: boolean) => void | Promise<void> = () => {}, bodyDeadline?: number): ReadableStream<Uint8Array> {
  const reader = body.getReader(); let count = 0, done = false, output: ReadableStreamDefaultController<Uint8Array>;
  const timer = bodyDeadline === undefined ? undefined : setTimeout(() => { void stop(new Error('Hosted body deadline ended'))?.catch(() => undefined); }, Math.max(1, bodyDeadline - Date.now()));
  let stopping: Promise<void> | undefined;
  const stop = (error?: Error): Promise<void> => stopping ??= (async () => {
    done = true; clearTimeout(timer); work.signal.removeEventListener('abort', abort);
    const cancellation = work.cancel(() => reader.cancel());
    try { await finished(!!error); if (error) output.error(error); else await cancellation; }
    catch { const unresolved = new Error('Hosted release unresolved'); output.error(unresolved); throw unresolved; }
  })();
  const abort = () => { void stop(new Error('Hosted deadline ended'))?.catch(() => undefined); };
  return new ReadableStream<Uint8Array>({
    start(controller) { output = controller; work.signal.addEventListener('abort', abort, { once: true }); if (work.signal.aborted) abort(); },
    async pull(controller) {
      try {
        await work.check(); const next = await work.track(reader.read()); if (done) return;
        if (next.done) { if (expected !== undefined && count !== expected) throw new Error('Incomplete content'); await stop(); controller.close(); return; }
        if (!(next.value instanceof Uint8Array)) throw new Error('Invalid content'); count += next.value.byteLength;
        if (count > limit || expected !== undefined && count > expected) throw new Error('Hosted response exceeds envelope');
        controller.enqueue(next.value);
      } catch { if (!done) void stop(new Error('Hosted response incomplete or exceeds envelope'))?.catch(() => undefined); else controller.error(new Error('Hosted release unresolved')); }
    }, cancel() { return stop(); },
  }, { highWaterMark: 0 });
}
function guarded<T extends object>(target: T, work: Lifetime): T {
  return new Proxy(target, { get(object, key) { const value = Reflect.get(object, key); return typeof value === 'function' ? (...args: unknown[]) => work.call(() => Promise.resolve(value.apply(object, args))) : value; } });
}
function limitedStore(store: PrivateObjectStore, config: HostedResearchConfig, work: Lifetime): PrivateObjectStore {
  const port = guarded(store, work);
  return {
    async putIfAbsent(key, body, metadata) { if (body.byteLength > config.maxSegmentBytes || metadata.bytes > config.maxSegmentBytes) throw new Error('Hosted object exceeds envelope'); await work.reserve('put'); return port.putIfAbsent(key, body, metadata); },
    async head(key) { await work.reserve('head'); return port.head(key); },
    async retire(key) { await work.reserve('retire'); return port.retire(key); },
    async read(key, range) { const size = range.end - range.start + 1; if (!Number.isSafeInteger(size) || size < 1 || size > config.maxResponseBytes) throw new Error('Hosted range exceeds envelope'); await work.reserve('read', size); return streamBody(await port.read(key, range), config.maxResponseBytes, work, size); },
  };
}
async function limitedResponse(response: Response, maximum: number, work: Lifetime) {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) { if (response.body) work.cancel(() => response.body!.cancel()); await work.settle(); return denied(413, 'Response exceeds hosted envelope; request a bounded range'); }
  if (!response.body) { await work.settle(); return response; }
  return new Response(streamBody(response.body, maximum, work, declared === null ? undefined : Number(declared), failed => failed ? work.settleKnown() : work.settle()), { status: response.status, statusText: response.statusText, headers: response.headers });
}
export function createHostedResearchHandler(raw: unknown, manifest: ResearchIdentityBinding, injection: HostedResearchInjection) {
  const config = parseHostedConfig(raw, manifest);
  if (!injection?.store || ['head', 'read', 'retire', 'putIfAbsent'].some(name => typeof (injection.store as unknown as Record<string, unknown>)[name] !== 'function')) throw new Error('Explicit private object store required');
  // No native hosted dispatch without a prospective root allocation. Explicit
  // trusted authority injection remains the offline/local composition seam.
  const native = injection.hostedAuthority ?? (config.allocationId ? convexHostedAuthority(config.deployment, config.gatewaySecret, config.allocationId) : undefined);
  const cleanupNative = config.cleanupAllocationId ? injection.cleanupAuthority ?? convexHostedAuthority(config.deployment, config.gatewaySecret, config.cleanupAllocationId) : native;
  let active = 0, uploads = 0; // supplementary process bounds only
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), headers = request.headers;
    if (url.origin !== config.publicOrigin || headers.get('Host') !== new URL(config.publicOrigin).host) return denied(403, 'Access unavailable');
    const media = /^\/capture\/media\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname), report = url.pathname.startsWith('/api/research/'), cleanup = url.pathname === '/api/research/internal/cleanup';
    const authority = cleanup ? cleanupNative : native, expectedAllocation = cleanup ? config.cleanupAllocationId ?? config.allocationId : config.allocationId;
    if (!media && !report) return denied(404, 'Not found');
    const cookie = report && url.pathname.startsWith('/api/research/portal/') && /(?:^|;\s*)research_viewer=[a-f0-9]{64}(?:;|$)/.test(headers.get('Cookie') ?? '');
    const cookieGet = request.method === 'GET' && cookie && !headers.has('Origin') && headers.get('Sec-Fetch-Site') === 'same-origin' && (() => { try { return new URL(headers.get('Referer') ?? '').origin === config.publicOrigin; } catch { return false; } })();
    if (!cookieGet && !trustedFacadeOrigin(request.method, Object.fromEntries(headers), config.publicOrigin)) return denied(403, 'Access unavailable');
    if (!['GET', 'PUT', 'POST', ...(report ? ['DELETE'] : [])].includes(request.method) || cleanup && request.method !== 'POST') return denied(405, 'Method unavailable');
    if (!authority) return denied(503, 'Hosted gateway allocation unavailable');
    const bodyRequest = request.method === 'PUT' || report && request.method === 'POST', length = headers.get('Content-Length'), maximum = request.method === 'PUT' ? config.maxSegmentBytes : cleanup ? 1024 : 16_384;
    if (headers.has('Transfer-Encoding') || (bodyRequest ? length === null || !/^\d+$/.test(length) || Number(length) < 1 || Number(length) > maximum || !request.body : length !== null && length !== '0' || !!request.body)) return denied(413, 'Invalid request size');
    if (active >= 4 || request.method === 'PUT' && uploads >= 1) return denied(429, 'Gateway capacity unavailable');
    active++; if (request.method === 'PUT') uploads++;
    let processReleased = false; const processRelease = () => { if (!processReleased) { processReleased = true; active--; if (request.method === 'PUT') uploads--; } };
    let work: Lifetime | undefined;
    try {
      // Private scheduled caller already acquired its native cleanup lease. Its
      // untrusted body has a separate hard timer before the signed identity read.
      const lease = cleanup ? await (async () => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000), reader = request.body!.getReader(); let size = 0; const chunks: Uint8Array[] = [];
        const abort = () => { void reader.cancel().catch(() => undefined); }; controller.signal.addEventListener('abort', abort, { once: true });
        try { for (;;) { const next = await abortable(reader.read(), controller.signal); if (next.done) break; size += next.value.byteLength; if (size > maximum) throw new Error('Invalid request size'); chunks.push(next.value); } if (size !== Number(length)) throw new Error('Incomplete request'); return await validateCleanupRequest(new Request(request.url, { method: 'POST', headers, body: Buffer.concat(chunks) }), config.gatewaySecret, authority); }
        finally { clearTimeout(timer); controller.abort(); }
      })() : await abortable(authority.acquire({ kind: kindFor(request, url.pathname), ...newLeaseOwner() }), AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
      if (!lease) { processRelease(); return denied(429, 'Gateway capacity unavailable'); }
      if (expectedAllocation && (lease.allocationId !== expectedAllocation || !authority.reserveOperation)) throw new Error('Native quota binding unavailable');
      if (lease.responseDeadlineAt <= Date.now() || lease.bodyDeadlineAt > lease.responseDeadlineAt || lease.responseDeadlineAt > lease.expiresAt || lease.expiresAt > Date.now() + 300_000) throw new Error('Invalid native deadline');
      work = lifetime(lease, authority, request.signal);
      if (!await work.track(authority.beginWork(leaseIdentity(lease)))) throw new Error('Gateway lease unavailable');
      // Inspection/identity and a false or unknown begin cannot release another
      // invocation's started lease, including a replayed signed cleanup request.
      work.acknowledgeBegin();
      const finish = work.finish; work.finish = () => { finish(); processRelease(); };
      const settle = work.settle; work.settle = async () => { try { await settle(); } finally { processRelease(); } };
      const settleKnown = work.settleKnown; work.settleKnown = async () => { try { await settleKnown(); } finally { processRelease(); } };
      const normalized = new Headers(headers); normalized.set('Origin', config.publicOrigin);
      const target = media ? `${config.publicOrigin}/api/research-media/${media[1]}${url.search}` : request.url;
      const facade = new Request(target, { method: request.method, headers: normalized, signal: work.signal, ...(bodyRequest && !cleanup ? { body: streamBody(request.body!, maximum, work, Number(length), () => {}, lease.bodyDeadlineAt), duplex: 'half' } : {}) } as RequestInit);
      const store = limitedStore(injection.store, config, work);
      const response = cleanup ? Response.json(await work.track(runHostedCleanup(store, authority, lease, work.signal)), { headers: PRIVATE_HEADERS }) : await work.track((async () => {
        const injected = await injection.requestGateway?.(facade, { signal: work!.signal, call: work!.call });
        if (injected) return injected;
        const capture = guarded(injection.captureAuthority ?? convexCaptureAuthority(config.deployment, config.gatewaySecret, { signal: work!.signal, readinessFacts: injection.readinessFacts }), work!);
        const reportFactory = (bearer: string | null, signal: AbortSignal) => guarded(injection.reportFactory ? injection.reportFactory(bearer, signal) : reportAuthority(config.deployment, config.gatewaySecret, bearer, signal, injection.readinessFacts), work!);
        const gateways = createResearchGateways(store, config, capture, injection.analysisRuntime, reportFactory);
        return report ? gateways.reports(facade) : gateways.media(facade);
      })());
      return await limitedResponse(response, config.maxResponseBytes, work);
    } catch { try { await work?.settleKnown(); } catch { /* Failed release stays unresolved. */ } processRelease(); return denied(409, 'Operation unavailable or unresolved; reconcile before repeating'); }
  };
}
