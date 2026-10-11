import { readinessAuthority } from './readiness-authority';
import { readinessAnalysisInput } from './study-readiness';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { reportAuthority, type ReportAuthority } from './report-authority';
import { hashPassword, verifyPassword } from './passwords';
import { analysisReadiness, requireAnalysisSelections, runAnalysis, validateRuntime, type AnalysisRuntime } from './analysis';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
import { reportReadGateway } from '../../../packages/research-capture/src/report-gateway';
import { PRIVATE_HEADERS } from '../../../packages/research-capture/src/protected-read';
import type { Id } from '../../../convex/_generated/dataModel';
import { sourceKinds } from '../../../packages/research-core/src/analysis';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/), scope = { clientId: id, projectId: id };
const legacyAnalysisInput = z.object({ ...scope, requestId, reservationId: requestId, selections: z.array(z.object({ sessionId: id, kind: z.enum(sourceKinds), id, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()).min(1).max(24) }).strict();
const analysisInput = z.union([legacyAnalysisInput, readinessAnalysisInput]);
const shareInput = z.object({ ...scope, reportId: id, requestId, password: z.string().min(12).max(256) }).strict();
const unlockInput = z.object({ slug: z.string().regex(/^[a-f0-9]{32}$/), password: z.string().max(256) }).strict();
const cookieName = 'research_viewer';
function cookieToken(request: Request): string { return request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? ''; }
async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json') || !request.body) throw new Error('Invalid request');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 16_384) throw new Error('Request exceeds admission'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(length); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function researchReportsGateway(store: PrivateObjectStore, config: { deployment: string; gatewaySecret: string; publicOrigin: string }, runtime: AnalysisRuntime = { reservations: [], visionQualified: false }, factory: (bearer: string | null, signal: AbortSignal) => ReportAuthority = (bearer, signal) => reportAuthority(config.deployment, config.gatewaySecret, bearer, signal)) {
  validateRuntime(runtime);
  let analysisBusy = false, passwordBusy = false;
  const cookie = (token: string, age: number) => `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api/research/portal; Max-Age=${age}${config.publicOrigin.startsWith('https:') ? '; Secure' : ''}`;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== config.publicOrigin || request.headers.get('Origin') !== config.publicOrigin) return new Response('Access unavailable', { status: 403, headers: PRIVATE_HEADERS });
    const bearer = /^Bearer ([^\s]{1,4096})$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? null;
    const authority = factory(bearer, request.signal);
    try {
      if (request.method === 'GET' && url.pathname === '/api/research/analysis/readiness') { await authority.operator(); return Response.json(analysisBusy ? { state: 'disabled', reservations: [], message: 'An analysis operation is in progress. Check saved status before repeating.' } : await analysisReadiness(runtime, authority), { headers: PRIVATE_HEADERS }); }
      if (request.method === 'POST' && url.pathname === '/api/research/analysis') {
        await authority.operator(); if (analysisBusy) return new Response('Analysis capacity unavailable', { status: 429, headers: PRIVATE_HEADERS });
        analysisBusy = true;
        try { const input = analysisInput.parse(await jsonBody(request));
          const prospective = 'scope' in input;
          if (runtime.preparedOnly && !prospective) throw new Error('Saved study preparation required');
          requireAnalysisSelections(runtime.textOnly, input.selections);
          if (prospective && (!bearer || !runtime.provider || runtime.provider.classification !== 'live' || !runtime.visionQualified)) throw new Error('Analysis runtime unavailable');
          const reservation = prospective ? await readinessAuthority(config.deployment, config.gatewaySecret, bearer!, request.signal).readPreparedAnalysis(input) : runtime.reservations.find(r => r.id === input.reservationId);
          if (!reservation) throw new Error('Analysis is disabled or reservation unavailable');
          const selectedScope = prospective ? input.scope : input;
          // Only a native source-bound child reservation may extend the immutable runtime list for this one invocation.
          const selectedRuntime = prospective ? { ...runtime, reservations: [reservation] } : runtime;
          const result = await runAnalysis(authority, store, selectedRuntime, { clientId: selectedScope.clientId as Id<'researchClients'>, projectId: selectedScope.projectId as Id<'researchProjects'>, requestId: input.requestId, selections: input.selections.map(s => ({ ...s, sessionId: s.sessionId as Id<'researchSessions'> })), reservation }, request.signal);
          return Response.json(result, { headers: PRIVATE_HEADERS }); }
        finally { analysisBusy = false; }
      }
      if (request.method === 'POST' && url.pathname === '/api/research/shares') {
        await authority.operator(); if (passwordBusy) return new Response('Password operation busy', { status: 429, headers: PRIVATE_HEADERS });
        passwordBusy = true;
        try { const input = shareInput.parse(await jsonBody(request)), credentials = await hashPassword(input.password), result = await authority.issueShare({ clientId: input.clientId as Id<'researchClients'>, projectId: input.projectId as Id<'researchProjects'>, reportId: input.reportId as Id<'researchReports'>, requestId: input.requestId, slug: randomBytes(16).toString('hex'), ...credentials }); return Response.json({ ...result, url: `${config.publicOrigin}/report/${result.slug}` }, { headers: PRIVATE_HEADERS }); }
        finally { passwordBusy = false; }
      }
      if (request.method === 'POST' && url.pathname === '/api/research/portal/unlock') {
        if (passwordBusy) return new Response('Access unavailable', { status: 429, headers: PRIVATE_HEADERS });
        passwordBusy = true;
        try {
          const input = unlockInput.parse(await jsonBody(request));
          const token = randomBytes(32).toString('hex'), tokenHash = createHash('sha256').update(token).digest('hex'), challenge = await authority.beginUnlock({ slug: input.slug, tokenHash });
          if (!challenge) return new Response('Invalid, expired or revoked access', { status: 401, headers: PRIVATE_HEADERS });
          const accepted = await verifyPassword(input.password, challenge.passwordSalt, challenge.passwordHash), result = await authority.finishUnlock({ sessionId: challenge.sessionId, tokenHash, accepted });
          if (!result) return new Response('Invalid, expired or revoked access', { status: 401, headers: PRIVATE_HEADERS });
          return Response.json({ expiresAt: result.expiresAt }, { headers: { ...PRIVATE_HEADERS, 'Set-Cookie': cookie(token, Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000))) } });
        } finally { passwordBusy = false; }
      }
      if (request.method === 'DELETE' && url.pathname === '/api/research/portal/session') { const token = cookieToken(request); if (/^[a-f0-9]{64}$/.test(token)) await authority.logout({ token }); return new Response(null, { status: 204, headers: { ...PRIVATE_HEADERS, 'Set-Cookie': cookie('', 0) } }); }
      if (request.method === 'GET' && url.pathname.startsWith('/api/research/portal/')) {
        const token = cookieToken(request); if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Access unavailable');
        return await reportReadGateway(store, authority)(request, token);
      }
      return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
    } catch { return new Response('Access unavailable or operation unresolved; check saved status before repeating', { status: 409, headers: PRIVATE_HEADERS }); }
  };
}
