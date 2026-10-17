import { convexInterviewAuthority } from './interview-authority';
import { studyReadinessGateway, studyRuntimeFacts } from './study-readiness';
import { researchInterviewGateway } from './interview-gateway';
import type { InterviewRuntime } from './interview';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { convexCaptureAuthority } from '../../../packages/research-capture/src/convex-authority';
import { LocalPrivateObjectStore } from '../../../packages/research-capture/src/local-store';
import { mediaGateway } from '../../../packages/research-capture/src/gateway';
import type { ResearchServerConfig } from './config';
import { startCleanupWorker } from './worker';
import { trustedFacadeOrigin } from './origin';
import { researchReportsGateway } from './reports';
import type { AnalysisRuntime } from './analysis';
import type { CaptureAuthority } from '../../../packages/research-capture/src/gateway';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
import type { ReportAuthority } from './report-authority';
import type { createResearchSpeechTransport } from './research-speech';

export type ResearchSpeechRuntime = ReturnType<typeof createResearchSpeechTransport>;

/** Shared composition only: no listener, storage choice, env loading or cleanup timer. */
export function createResearchGateways(store: PrivateObjectStore, config: { deployment: string; publicOrigin: string; gatewaySecret: string; maxSegmentBytes: number }, authority: CaptureAuthority, analysisRuntime?: AnalysisRuntime, reportFactory?: (bearer: string | null, signal: AbortSignal) => ReportAuthority) {
  return { media: mediaGateway(store, authority, { origin: config.publicOrigin, maxSegmentBytes: config.maxSegmentBytes }), reports: researchReportsGateway(store, config, analysisRuntime, reportFactory) };
}

const safeHeaders = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export async function startResearchServer(config: ResearchServerConfig, analysisRuntime?: AnalysisRuntime, speechRuntime?: ResearchSpeechRuntime, interviewRuntime?: InterviewRuntime) {
  const lifetime = new AbortController(), store = new LocalPrivateObjectStore(config.objectDirectory);
  const readinessFacts = studyRuntimeFacts(config, { interview: interviewRuntime, analysis: analysisRuntime, speechEnabled: () => speechRuntime?.readinessEnabled?.() === true, speechConfiguration: () => speechRuntime?.readinessConfiguration?.() ?? '' });
  const authority = convexCaptureAuthority(config.deployment, config.gatewaySecret, { signal: lifetime.signal, readinessFacts });
  const interview = researchInterviewGateway(config, interviewRuntime, (token, signal) => convexInterviewAuthority(config.deployment, config.gatewaySecret, token, signal, readinessFacts));
  const readiness = studyReadinessGateway({ ...config, analysisTextOnly: analysisRuntime?.textOnly === true }, readinessFacts);
  const { media: handle, reports } = createResearchGateways(store, config, authority, analysisRuntime);
  let active = 0, uploads = 0, closing = false;
  let worker: ReturnType<typeof startCleanupWorker> | undefined;
  const respond = (res: ServerResponse, code: number, message: string) => { res.writeHead(code, { ...safeHeaders, 'Connection': 'close', 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
  const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController();
    const disconnected = () => { if (!res.writableFinished) abort.abort(); };
    const deadline = setTimeout(() => abort.abort(), req.url === '/api/research/analysis' ? 120_000 : req.url === '/api/research/speech/output' ? 35_000 : req.method === 'PUT' ? 65_000 : 30_000);
    req.once('aborted', disconnected); res.once('close', disconnected); res.once('error', disconnected);
    const abortSocket = () => res.destroy(); abort.signal.addEventListener('abort', abortSocket, { once: true });
    active++; if (req.method === 'PUT') uploads++;
    try {
      const route = new URL(req.url!, config.bindOrigin);
      const id = /^\/capture\/media\/([a-zA-Z0-9_-]{1,128})$/.exec(route.pathname)?.[1];
      const reportRoute = route.pathname.startsWith('/api/research/');
      if (!id && !reportRoute) { respond(res, 404, 'Not found'); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      // Admission checked either actual Origin or the narrow authenticated GET
      // fetch metadata fallback. The portable gateway still validates authority.
      headers.set('Origin', config.publicOrigin);
      const request = new Request(reportRoute ? `${config.publicOrigin}${route.pathname}${route.search}` : `${config.publicOrigin}/api/research-media/${id}${route.search}`, {
        method: req.method, headers, signal: AbortSignal.any([abort.signal, lifetime.signal]),
        ...(req.method === 'PUT' || reportRoute && req.method === 'POST' ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
      } as RequestInit);
      const speechResponse = reportRoute && speechRuntime ? await speechRuntime.handle(request) : undefined;
      const interviewResponse = reportRoute && !speechResponse ? await interview(request) : undefined;
      const readinessResponse = reportRoute && !speechResponse && !interviewResponse ? await readiness(request) : undefined;
      const response = speechResponse ?? interviewResponse ?? readinessResponse ?? await (reportRoute ? reports(request) : handle(request));
      if (abort.signal.aborted) { await response.body?.cancel().catch(() => undefined); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res, { signal: abort.signal });
      else res.end();
    } catch {
      if (res.headersSent || res.destroyed) res.destroy();
      else respond(res, 503, 'Source unavailable; reconcile before retrying');
    } finally {
      active--; if (req.method === 'PUT') uploads--;
      clearTimeout(deadline); req.off('aborted', disconnected); res.off('close', disconnected); res.off('error', disconnected); abort.signal.removeEventListener('abort', abortSocket);
    }
  };
  const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    // Never trust forwarded host/origin. Only the local Vite facade and direct
    // qualification at this fixed listener are supported by this service.
    if (closing) { respond(res, 503, 'Gateway is stopping'); return; }
    if (req.headers.host !== '127.0.0.1:8789' || !req.url?.startsWith('/') || req.url.startsWith('//')) { respond(res, 403, 'Access unavailable'); return; }
    if (req.method === 'GET' && req.url === '/capture/health') {
      res.writeHead(200, { ...safeHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'research-capture-local', state: 'ready', worker: worker?.status ?? null })); return;
    }
    const reportRoute = req.url.startsWith('/api/research/');
    const portalCookie = reportRoute && req.url.startsWith('/api/research/portal/') && typeof req.headers.cookie === 'string' && /(?:^|;\s*)research_viewer=[a-f0-9]{64}(?:;|$)/.test(req.headers.cookie);
    const cookieGet = req.method === 'GET' && portalCookie && req.headers.origin === undefined && req.headers['sec-fetch-site'] === 'same-origin' && typeof req.headers.referer === 'string' && (() => { try { return new URL(req.headers.referer).origin === config.publicOrigin; } catch { return false; } })();
    const speechStatusGet = !!speechRuntime && req.url === '/api/research/speech/status' && req.method === 'GET' && req.headers.origin === undefined && typeof req.headers['x-research-participant'] === 'string' && /^[a-f0-9]{64}$/.test(req.headers['x-research-participant']) && req.headers['sec-fetch-site'] === 'same-origin' && typeof req.headers.referer === 'string' && (() => { try { return new URL(req.headers.referer).origin === config.publicOrigin; } catch { return false; } })();
    if (!cookieGet && !speechStatusGet && !trustedFacadeOrigin(req.method ?? '', req.headers, config.publicOrigin)) { respond(res, 403, 'Access unavailable'); return; }
    if (!['GET', 'PUT', 'POST', ...(reportRoute ? ['DELETE'] : [])].includes(req.method ?? '')) { respond(res, 405, 'Method unavailable'); return; }
    const size = req.headers['content-length'];
    const bodyRequest = req.method === 'PUT' || reportRoute && req.method === 'POST';
    const maximum = req.method === 'PUT' ? config.maxSegmentBytes : 16_384;
    if (bodyRequest ? typeof size !== 'string' || !/^\d+$/.test(size) || Number(size) < 1 || Number(size) > maximum || !!req.headers['transfer-encoding'] : !!req.headers['transfer-encoding'] || size !== undefined && size !== '0') { respond(res, 413, 'Invalid request size'); return; }
    if (active >= 4 || req.method === 'PUT' && uploads >= 1) { respond(res, 429, 'Gateway capacity unavailable'); return; }
    void dispatch(req, res);
  });
  server.headersTimeout = 5000; server.requestTimeout = 120_000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  server.on('upgrade', (req, socket, head) => {
    if (closing || !speechRuntime) { socket.destroy(); return; }
    // Transport performs the exact raw Host/Origin/path admission before work.
    void speechRuntime.upgrade(req, socket, head).catch(() => socket.destroy());
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(8789, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  worker = startCleanupWorker(store, authority, config.cleanupIntervalMs);
  return {
    server, worker,
    async close() {
      if (closing) return; closing = true;
      speechRuntime?.close();
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      const force = setTimeout(() => { lifetime.abort(); server.closeAllConnections(); }, 5000);
      try { await stopped; lifetime.abort(); await worker!.stop(); }
      finally { clearTimeout(force); }
    },
  };
}
