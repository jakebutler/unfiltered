import { STUDY_TEST_ROUTES } from '../../../packages/research-core/src/welcome';
import { captureTestAuthority, type CaptureTestAuthority } from './capture-test-authority';
import { trustedFacadeOrigin } from './origin';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PRIVATE_HEADERS } from '../../../packages/research-capture/src/protected-read';
import { canonical } from '../../../packages/research-capture/src/proof';
import { STUDY_READINESS_ROUTES, type StudyRuntimeFacts } from '../../../packages/research-core/src/readiness';
import { sourceKinds } from '../../../packages/research-core/src/analysis';
import { readinessAuthority, type ReadinessAuthority } from './readiness-authority';
import type { InterviewRuntime } from './interview';
import { requireAnalysisSelections, type AnalysisRuntime } from './analysis';
export type ReadinessQualifications = { interview: boolean; voice: boolean; capture: boolean; screenBaseline: boolean; analysis: boolean; expectedConfigurationDigest?: string };
const unqualified: ReadinessQualifications = { interview: false, voice: false, capture: false, screenBaseline: false, analysis: false };
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const scope = z.object({ clientId: id, projectId: id, studyId: id, studyVersion: z.number().int().positive() }).strict();
const captureTestInput = z.object({ scope, requestId, expectedBinding: z.string().regex(/^[a-f0-9]{64}$/), device: z.object({ browser: z.string().min(1).max(100), platform: z.string().min(1).max(100) }).strict() }).strict();
const command = z.object({ scope, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), capability: z.enum(['scripted-text', 'goal-aware-interview', 'voice', 'private-capture', 'analysis', 'screen-baseline', 'controlled-dom']), enabled: z.boolean(), requestId }).strict();
export const readinessAnalysisInput = z.object({ scope, requestId, selections: z.array(z.object({ sessionId: id, kind: z.enum(sourceKinds), id, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()).min(1).max(24) }).strict();
/** Qualification metadata is a root evidence attestation, never a measurement in this function. */
export function studyRuntimeFacts(config: { deployment: string; publicOrigin: string; allocationId?: string; cleanupAllocationId?: string }, options: { interview?: InterviewRuntime; analysis?: AnalysisRuntime; speechEnabled?: () => boolean; speechConfiguration?: () => string; qualifications?: ReadinessQualifications }): () => StudyRuntimeFacts {
  const qualifications = Object.freeze({ ...(options.qualifications ?? unqualified) });
  return () => {
    const interviewEnabled = options.interview?.enabled === true && !!options.interview.provider, voiceEnabled = options.speechEnabled?.() === true;
    const analysisEnabled = options.analysis?.provider?.classification === 'live' && options.analysis?.visionQualified === true;
    const configurationDigest = createHash('sha256').update(canonical({ implementation: 'study-readiness-v1', deployment: config.deployment, origin: config.publicOrigin, gatewayAllocationId: config.allocationId ?? null, ...(config.cleanupAllocationId ? {cleanupAllocationId:config.cleanupAllocationId}:{}), interviewModel: options.interview?.provider?.model ?? null, interviewConfiguration: options.interview?.provider?.configurationDigest ?? null, analysisModel: options.analysis?.provider?.model ?? null, analysisConfiguration: options.analysis?.provider?.configurationDigest ?? null, speechConfiguration: options.speechConfiguration?.() ?? null, analysisMaxFrames: options.analysis?.maxFrames ?? null, analysisMaxBytes: options.analysis?.maxRequestBytes ?? null, ...(options.analysis?.textOnly ? { analysisTextOnly: true } : {}) })).digest('hex');
    const qualificationMatches = qualifications.expectedConfigurationDigest === configurationDigest;
    const facts = {
      interview: { enabled: interviewEnabled, qualified: qualificationMatches && qualifications.interview && !!options.interview?.provider?.configurationDigest, model: options.interview?.provider?.model ?? null },
      voice: { enabled: voiceEnabled, qualified: qualificationMatches && qualifications.voice && !!options.speechConfiguration?.() },
      capture: { enabled: !!config.allocationId, qualified: qualificationMatches && qualifications.capture, gatewayAllocationId: config.allocationId ?? null, ...(config.cleanupAllocationId ? {cleanupAllocationId:config.cleanupAllocationId}: {}) },
      analysis: { enabled: analysisEnabled, qualified: qualificationMatches && qualifications.analysis && options.analysis?.visionQualified === true && !!options.analysis?.provider?.configurationDigest, model: options.analysis?.provider?.model ?? null },
      screenBaselineQualified: qualificationMatches && qualifications.screenBaseline,
    };
    const revision = createHash('sha256').update(canonical({ implementation: 'study-readiness-v1', configurationDigest, ...facts })).digest('hex');
    return { ...facts, revision, configurationDigest, observedAt: Date.now() };
  };
}
export async function boundedReadinessJson(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type') !== 'application/json' || !request.body) throw new Error('Invalid readiness request');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]); let remove = () => {};
  const stopped = new Promise<never>((_, reject) => { const abort = () => reject(new Error('Readiness request deadline ended')); signal.addEventListener('abort', abort, { once: true }); remove = () => signal.removeEventListener('abort', abort); if (signal.aborted) abort(); }); void stopped.catch(() => undefined);
  try { for (;;) { const next = await Promise.race([reader.read(), stopped]); if (next.done) break; size += next.value.byteLength; if (size > 16_384) throw new Error('Readiness body exceeds bound'); chunks.push(next.value); } }
  finally { remove(); void reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function studyReadinessGateway(config: { deployment: string; gatewaySecret: string; publicOrigin: string; analysisTextOnly?: boolean }, facts: () => StudyRuntimeFacts, factory: (bearer: string, signal: AbortSignal) => ReadinessAuthority = (bearer, signal) => readinessAuthority(config.deployment, config.gatewaySecret, bearer, signal), tests: (bearer: string, signal: AbortSignal) => CaptureTestAuthority = (bearer, signal) => captureTestAuthority(config.deployment, config.gatewaySecret, bearer, signal)) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url); if (![...Object.values(STUDY_READINESS_ROUTES), ...Object.values(STUDY_TEST_ROUTES), '/api/research/analysis/prepare', '/api/research/analysis/prepare/receipt'].includes(url.pathname)) return undefined;
    if (url.origin !== config.publicOrigin || !trustedFacadeOrigin(request.method, Object.fromEntries(request.headers), config.publicOrigin) || request.headers.has('Host') && request.headers.get('Host') !== new URL(config.publicOrigin).host) return new Response('Access unavailable', { status: 403, headers: PRIVATE_HEADERS });
    const bearer = /^Bearer ([^\s]{1,4096})$/.exec(request.headers.get('Authorization') ?? '')?.[1]; if (!bearer) return new Response('Access unavailable', { status: 403, headers: PRIVATE_HEADERS });
    const authority = factory(bearer, request.signal);
    try {
      if (url.pathname === STUDY_READINESS_ROUTES.snapshot && request.method === 'GET') {
        if ([...url.searchParams.keys()].some(k => !['clientId', 'projectId', 'studyId', 'studyVersion'].includes(k)) || [...url.searchParams.keys()].length !== 4) throw new Error('Invalid readiness scope');
        const input = scope.parse({ ...Object.fromEntries(url.searchParams), studyVersion: Number(url.searchParams.get('studyVersion')) });
        return Response.json(await authority.snapshot(input, facts()), { headers: PRIVATE_HEADERS });
      }
      if (request.method !== 'POST' || url.search) return new Response('Method unavailable', { status: 405, headers: PRIVATE_HEADERS });
      const body = await boundedReadinessJson(request);
      if (Object.values(STUDY_TEST_ROUTES).includes(url.pathname as typeof STUDY_TEST_ROUTES[keyof typeof STUDY_TEST_ROUTES])) {
        const authority = tests(bearer, request.signal);
        if (url.pathname === STUDY_TEST_ROUTES.preview) return Response.json(await authority.preview(scope.parse(z.object({ scope }).strict().parse(body).scope), facts()), { headers: PRIVATE_HEADERS });
        const input = captureTestInput.parse(body);
        if (url.pathname === STUDY_TEST_ROUTES.issue) return Response.json(await authority.issue(input, facts()), { headers: PRIVATE_HEADERS });
        if (url.pathname === STUDY_TEST_ROUTES.close) return Response.json(await authority.close(input), { headers: PRIVATE_HEADERS });
        if (url.pathname === STUDY_TEST_ROUTES.receipt) return Response.json(await authority.receipt(input), { headers: PRIVATE_HEADERS });
        return Response.json(await authority.status(input, facts()), { headers: PRIVATE_HEADERS });
      }
      if (url.pathname === STUDY_READINESS_ROUTES.command) return Response.json(await authority.command(command.parse(body), facts()), { headers: PRIVATE_HEADERS });
      if (url.pathname === STUDY_READINESS_ROUTES.receipt) return Response.json(await authority.receipt(command.parse(body), facts()), { headers: PRIVATE_HEADERS });
      if (url.pathname === '/api/research/analysis/prepare/receipt') return Response.json(await authority.readPreparedAnalysis(readinessAnalysisInput.parse(body)), { headers: PRIVATE_HEADERS });
      if (url.pathname === '/api/research/analysis/prepare') { const input = readinessAnalysisInput.parse(body); requireAnalysisSelections(config.analysisTextOnly, input.selections); return Response.json(await authority.prepareAnalysis(input, facts()), { headers: PRIVATE_HEADERS }); }
      return new Response('Method unavailable', { status: 405, headers: PRIVATE_HEADERS });
    } catch { return Response.json({ state: 'unresolved', reason: 'Readiness unavailable; check the original request receipt before another change.' }, { status: 409, headers: PRIVATE_HEADERS }); }
  };
}
