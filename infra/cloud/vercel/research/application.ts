import { studyReadinessGateway, studyRuntimeFacts, type ReadinessQualifications } from '../../../../apps/research-server/src/study-readiness';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHostedResearchHandler, type HostedResearchConfig, type HostedResearchInjection } from '../../../../apps/research-server/src/hosted-runtime';
import { researchInterviewGateway } from '../../../../apps/research-server/src/interview-gateway';
import { convexInterviewAuthority } from '../../../../apps/research-server/src/interview-authority';
import type { InterviewAuthority, InterviewRuntime } from '../../../../apps/research-server/src/interview';
import type { ResearchSpeechRuntime } from '../../../../apps/research-server/src/server';
import { serveResearchAsset, researchHeaders, type ResearchAssets } from './static-assets';
export interface ResearchApplicationOptions { config: HostedResearchConfig; assets: ResearchAssets; injection: HostedResearchInjection; speech: ResearchSpeechRuntime; readinessQualifications?: ReadinessQualifications; interviewRuntime?: InterviewRuntime; interviewFactory?: (token: string, signal: AbortSignal) => InterviewAuthority; }
/** Canonical origin is fixed by the reviewed manifest. Raw Host is checked before
 * body conversion; forwarded headers never select authority or a request origin. */
export function createHostedResearchServer(options: ResearchApplicationOptions) {
  const { config, assets, speech } = options;
  // Hosted analysis always requires the native source-bound study reservation.
  // Static reservations remain available only to separately assembled local runtimes.
  const analysisRuntime = options.injection.analysisRuntime
    ? { ...options.injection.analysisRuntime, preparedOnly: true }
    : undefined;
  const readinessFacts = studyRuntimeFacts(config, { interview: options.interviewRuntime, analysis: analysisRuntime, speechEnabled: () => speech.readinessEnabled?.() === true, speechConfiguration: () => speech.readinessConfiguration(), qualifications: options.readinessQualifications });
  const readiness = studyReadinessGateway({ ...config, analysisTextOnly: analysisRuntime?.textOnly === true }, readinessFacts);
  const factory = options.interviewFactory ?? ((token: string, signal: AbortSignal) => convexInterviewAuthority(config.deployment, config.gatewaySecret, token, signal, readinessFacts));
  const gateway = createHostedResearchHandler(config, { canonicalOrigin: config.publicOrigin }, { ...options.injection, analysisRuntime, readinessFacts, requestGateway: (request, context) => {
    if (new URL(request.url).pathname !== '/api/research/interview') return Promise.resolve(undefined);
    const guardedFactory = (token: string, signal: AbortSignal) => new Proxy(factory(token, signal), { get(authority, key) { const value = Reflect.get(authority, key); return typeof value === 'function' ? (...args: unknown[]) => context.call(() => Promise.resolve(value.apply(authority, args))) : value; } });
    const provider = options.interviewRuntime?.provider;
    // A gateway can return an unknown attempt before an uncancellable provider
    // settles. Track underlying provider work in the native hosted lifetime.
    const runtime: InterviewRuntime | undefined = provider ? { ...options.interviewRuntime, provider: { model: provider.model, prepare: (...args) => context.call(() => provider.prepare(...args)), generate: (...args) => context.call(() => provider.generate(...args)) } } : options.interviewRuntime;
    return researchInterviewGateway(config, runtime, guardedFactory)(request);
  } });
  const handle = async (request: Request) => {
    const path = new URL(request.url).pathname;
    const response = path.startsWith('/api/research') || path.startsWith('/capture/') ? await speech.handle(request) ?? await readiness(request) ?? await gateway(request) : serveResearchAsset(request, assets, config.publicOrigin);
    const headers = new Headers(response.headers); for (const [key, value] of Object.entries(researchHeaders(config.publicOrigin))) headers.set(key, value);
    if (path.startsWith('/api/') || path.startsWith('/capture/')) headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  let closing = false;
  const nodeHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController(), disconnect = () => { if (!res.writableFinished) abort.abort(); };
    const requestError = () => { disconnect(); if (!res.writableFinished) res.destroy(); };
    req.once('aborted', disconnect); req.on('error', requestError); res.once('close', disconnect); res.once('error', disconnect);
    const timer = setTimeout(() => abort.abort(), 180000);
    try {
      if (closing || req.headers.host !== new URL(config.publicOrigin).host || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) { res.writeHead(403, { ...researchHeaders(config.publicOrigin), 'Cache-Control': 'private, no-store' }); res.end('Access unavailable'); return; }
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const target = new URL(req.url, config.publicOrigin); if (target.origin !== config.publicOrigin) throw new Error('Invalid request target');
      // A bodyless DELETE must stay bodyless through the Node/Web facade. Framed
      // DELETE bodies remain visible so hosted admission rejects them before work.
      const emptyDelete = req.method === 'DELETE' && !headers.has('Transfer-Encoding') && (!headers.has('Content-Length') || headers.get('Content-Length') === '0');
      const request = new Request(target, { method: req.method, headers, signal: abort.signal, ...(req.method !== 'GET' && req.method !== 'HEAD' && !emptyDelete ? { body: Readable.toWeb(req), duplex: 'half' } : {}) } as RequestInit);
      const response = await handle(request);
      if (abort.signal.aborted) { await response.body?.cancel().catch(() => undefined); res.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res, { signal: abort.signal }); else res.end();
    } catch { if (res.headersSent || res.destroyed) res.destroy(); else { res.writeHead(409, { ...researchHeaders(config.publicOrigin), 'Cache-Control': 'private, no-store' }); res.end('Operation unavailable or unresolved'); } }
    finally { clearTimeout(timer); req.off('aborted', disconnect); req.off('error', requestError); res.off('close', disconnect); res.off('error', disconnect); }
  };
  const server = createServer(nodeHandler);
  server.on('upgrade', (request, socket, head) => { if (closing) socket.destroy(); else void speech.upgrade(request, socket, head).catch(() => socket.destroy()); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.headersTimeout = 10000; server.requestTimeout = 180000; server.keepAliveTimeout = 5000;
  return { server, handle, close() { closing = true; speech.close(); server.close(); server.closeIdleConnections(); } };
}
