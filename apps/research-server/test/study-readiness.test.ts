import { expect, test, vi } from 'vitest';
import { hostedResearchConfig } from '../../../infra/cloud/vercel/research/config';
import { HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE } from '../src/hosted-runtime';
import { studyReadinessGateway, studyRuntimeFacts } from '../src/study-readiness';
import type { ReadinessAuthority } from '../src/readiness-authority';
import { readinessAuthority } from '../src/readiness-authority';
const origin = 'https://research.example.com', config = { deployment: HOSTED_DEPLOYMENT, gatewaySecret: 'a'.repeat(64), publicOrigin: origin, allocationId: 'global-envelope' };
const scope = { clientId: 'client-1', projectId: 'project-1', studyId: 'study-1', studyVersion: 1 }, command = { scope, expectedRevision: 'b'.repeat(64), capability: 'voice', enabled: true, requestId: 'operator-command-1' };
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(origin).host, Origin: origin, Authorization: 'Bearer synthetic-token', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
test('missing private qualification metadata stays false without enabling providers or loading model/voice credentials', () => {
  const manifest = { schema: 1, mode: 'deployable-candidate', canonicalOrigin: origin, deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, r2: { accountId: '728ae4b71b42dfcef062336c06bd8595', bucket: 'unfiltered-recordings', namespace: 'synthetic-fixture', deadlineMs: 1000 }, maxSegmentBytes: 4000000, maxResponseBytes: 4000000, ffmpeg: { sha256: '1'.repeat(64), bytes: 64, architecture: 'linux-x64', version: 'synthetic', source: 'https://example.test/fixture', license: 'LGPL-2.1-or-later', licenseSha256: '2'.repeat(64) } };
  const environment = { RESEARCH_RUNTIME_JSON: JSON.stringify({ gatewaySecret: 'a'.repeat(64), allocationId: 'global-envelope' }), RESEARCH_R2_ACCESS_KEY_ID: 'synthetic', RESEARCH_R2_SECRET_ACCESS_KEY: 'synthetic', DIGITALOCEAN_MODEL_ACCESS_KEY: 'keys-do-not-activate', DEEPGRAM_API_KEY: 'keys-do-not-activate', ELEVENLABS_API_KEY: 'keys-do-not-activate' };
  const cleanupConfig = hostedResearchConfig({ ...environment, RESEARCH_RUNTIME_JSON: JSON.stringify({ gatewaySecret: 'a'.repeat(64), allocationId: 'global-envelope', cleanupAllocationId: 'retirement-only' }) }, manifest, '/bin/ffmpeg'); expect(cleanupConfig.config.cleanupAllocationId).toBe('retirement-only');
  expect(() => hostedResearchConfig({ ...environment, RESEARCH_RUNTIME_JSON: JSON.stringify({ gatewaySecret: 'a'.repeat(64), allocationId: 'global-envelope', cleanupAllocationId: 'global-envelope' }) }, manifest, '/bin/ffmpeg')).toThrow();
  const parsed = hostedResearchConfig(environment, manifest, '/bin/ffmpeg'); expect(parsed.readinessQualifications).toEqual({ interview: false, voice: false, capture: false, screenBaseline: false, analysis: false }); expect(parsed.modelKey).toBeUndefined(); expect(parsed.deepgramKey).toBeUndefined(); expect(parsed.elevenlabsKey).toBeUndefined(); expect(parsed.speechEnabled).toBe(false); expect(parsed.interview.enabled).toBe(false);
  const facts = studyRuntimeFacts(config, {})(); expect(facts.voice.enabled).toBe(false); expect(facts.voice.qualified).toBe(false); expect(facts.interview.enabled).toBe(false); expect(facts.capture.qualified).toBe(false);
  const enabledProvider = { configurationDigest: 'c'.repeat(64), model: 'qwen3.8-max' as const, prepare: vi.fn(), generate: vi.fn() }; const noEvidence = studyRuntimeFacts(config, { interview: { enabled: true, provider: enabledProvider }, speechEnabled: () => true })(); expect(noEvidence.interview.qualified).toBe(false); expect(noEvidence.voice.qualified).toBe(false); expect(enabledProvider.generate).not.toHaveBeenCalled();
});
test('running configuration and implementation bind CAS digest; root qualification alone cannot override actual OFF', () => {
  const qualifications = { interview: true, voice: true, capture: true, screenBaseline: true, analysis: true }, qwen = { configurationDigest: 'c'.repeat(64), model: 'qwen3.8-max' as const, prepare: vi.fn(), generate: vi.fn() };
  const off = studyRuntimeFacts(config, { qualifications })(), enabled = studyRuntimeFacts(config, { qualifications, interview: { enabled: true, provider: qwen }, speechEnabled: () => true })();
  expect(off.interview.enabled).toBe(false); expect(off.voice.enabled).toBe(false); expect(enabled.revision).not.toBe(off.revision);
  const switched = studyRuntimeFacts(config, { qualifications, interview: { enabled: true, provider: { ...qwen, model: 'glm-5.3-flash' } }, speechEnabled: () => true })(); expect(switched.revision).not.toBe(enabled.revision);
  const effective = studyRuntimeFacts(config, { qualifications, interview: { enabled: true, provider: qwen }, speechEnabled: () => true, speechConfiguration: () => 'd'.repeat(64) })();
  const attested = { ...qualifications, expectedConfigurationDigest: effective.configurationDigest };
  const qualified = studyRuntimeFacts(config, { qualifications: attested, interview: { enabled: true, provider: qwen }, speechEnabled: () => true, speechConfiguration: () => 'd'.repeat(64) })(); expect(qualified.interview.qualified).toBe(true); expect(qualified.voice.qualified).toBe(true);
  expect(studyRuntimeFacts(config, { qualifications: attested, interview: { enabled: true, provider: { ...qwen, model: 'glm-5.3-flash' } }, speechEnabled: () => true, speechConfiguration: () => 'd'.repeat(64) })().interview.qualified).toBe(false);
  expect(studyRuntimeFacts(config, { qualifications: attested, interview: { enabled: true, provider: qwen }, speechEnabled: () => true, speechConfiguration: () => 'e'.repeat(64) })().voice.qualified).toBe(false);
  let live = true; const facts = studyRuntimeFacts(config, { qualifications, speechEnabled: () => live }); const before = facts(); live = false; expect(facts().voice.enabled).toBe(false); expect(facts().revision).not.toBe(before.revision); expect(qwen.generate).not.toHaveBeenCalled();
});
test('gateway authenticates exact scope and ignores no user runtime metadata; unknown receipt lookup never calls mutation', async () => {
  const facts = studyRuntimeFacts(config, {}), authority = { snapshot: vi.fn(async () => ({ scope, revision: 'b'.repeat(64), observedAt: Date.now(), expiresAt: null, fallback: 'Text', capabilities: [] })), command: vi.fn(), receipt: vi.fn(async () => ({ state: 'unresolved' as const })), prepareAnalysis: vi.fn(), readPreparedAnalysis: vi.fn() } satisfies ReadinessAuthority;
  const factory = vi.fn(() => authority), gateway = studyReadinessGateway(config, facts, factory);
  const query = `?clientId=${scope.clientId}&projectId=${scope.projectId}&studyId=${scope.studyId}&studyVersion=1`;
  expect((await gateway(request(`/api/research/study-readiness${query}`)))!.status).toBe(200); const ordinary = request(`/api/research/study-readiness${query}`, undefined, { 'Sec-Fetch-Site': 'same-origin', Referer: `${origin}/operator` }); ordinary.headers.delete('Origin'); expect((await gateway(ordinary))!.status).toBe(200);
  expect(authority.snapshot).toHaveBeenCalledWith(scope, expect.objectContaining({ voice: { enabled: false, qualified: false } }));
  expect((await gateway(request('/api/research/study-readiness/receipt', command)))!.status).toBe(200); expect(authority.receipt).toHaveBeenCalledWith(command, expect.objectContaining({ voice: { enabled: false, qualified: false } })); expect(authority.command).not.toHaveBeenCalled();
  expect((await gateway(request('/api/research/study-readiness/command', { ...command, runtime: { voice: { enabled: true } } })))!.status).toBe(409); expect(authority.command).not.toHaveBeenCalled();
  expect((await gateway(request(`/api/research/study-readiness${query}`, undefined, { Origin: 'https://other.example' })))!.status).toBe(403);
  expect((await gateway(request(`/api/research/study-readiness${query}`, undefined, { Authorization: '' })))!.status).toBe(403);
  expect((await gateway(request(`/api/research/study-readiness${query}&studyVersion=2`)))!.status).toBe(409);
  expect((await gateway(request('/api/research/study-readiness/command', { ...command, requestId: 'x'.repeat(17000) })))!.status).toBe(409); expect(authority.command).not.toHaveBeenCalled();
});
test('native readiness response is bounded and an ambiguous mutation is never automatically retried', async () => {
  const fetcher = vi.fn(async () => new Response('x'.repeat(131073), { headers: { 'Content-Length': '131073' } })); vi.stubGlobal('fetch', fetcher);
  try {
    const authority = readinessAuthority(config.deployment, config.gatewaySecret, 'synthetic-token', new AbortController().signal);
    await expect(authority.command(command as any, studyRuntimeFacts(config, {})())).rejects.toThrow('response exceeds bound'); expect(fetcher).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

test('text-only preparation rejects other sources before consuming native capacity while original receipt checks remain available', async () => {
  const facts = studyRuntimeFacts(config, {}), authority = { snapshot: vi.fn(), command: vi.fn(), receipt: vi.fn(), prepareAnalysis: vi.fn().mockResolvedValue({}), readPreparedAnalysis: vi.fn().mockResolvedValue({}) };
  const gateway = studyReadinessGateway({ ...config, analysisTextOnly: true }, facts, () => authority as unknown as ReadinessAuthority);
  const input = { scope, requestId: 'analysis-request-1', selections: [{ sessionId: 'session-1', id: 'source-1', kind: 'self-report', start: 0, end: 4 }] };
  for (const kind of ['dom-event','screen-observation','camera-observation','audio','capture-gap']) expect((await gateway(request('/api/research/analysis/prepare', { ...input, selections: [{ ...input.selections[0], kind }] })))!.status).toBe(409);
  expect(authority.prepareAnalysis).not.toHaveBeenCalled();
  expect((await gateway(request('/api/research/analysis/prepare', input)))!.status).toBe(200); expect(authority.prepareAnalysis).toHaveBeenCalledOnce();
  expect((await gateway(request('/api/research/analysis/prepare/receipt', { ...input, selections: [{ ...input.selections[0], kind: 'camera-observation' }] })))!.status).toBe(200); expect(authority.prepareAnalysis).toHaveBeenCalledOnce();
});
test('text-only policy changes the native-bound configuration digest; default and false retain prior fixture identity', () => {
  const analysis = { reservations: [], visionQualified: false };
  const original = studyRuntimeFacts(config, { analysis })(), explicitFalse = studyRuntimeFacts(config, { analysis: { ...analysis, textOnly: false } })(), textOnly = studyRuntimeFacts(config, { analysis: { ...analysis, textOnly: true } })();
  expect(explicitFalse.configurationDigest).toBe(original.configurationDigest);
  expect(textOnly.configurationDigest).not.toBe(original.configurationDigest); expect(textOnly.revision).not.toBe(original.revision);
});

test('cleanup binding is explicit and separately digest-bound; its absence preserves current text configuration identity', () => {
  const old = studyRuntimeFacts(config, {})(), absent = studyRuntimeFacts({ ...config, cleanupAllocationId: undefined }, {})(), bound = studyRuntimeFacts({ ...config, cleanupAllocationId: 'retirement-only' }, {})();
  expect(absent.configurationDigest).toBe(old.configurationDigest); expect(absent.revision).toBe(old.revision); expect(absent.capture.cleanupAllocationId).toBeUndefined();
  expect(bound.configurationDigest).not.toBe(old.configurationDigest); expect(bound.capture.cleanupAllocationId).toBe('retirement-only'); expect(bound.voice.enabled).toBe(false); expect(bound.analysis.enabled).toBe(false);
});
