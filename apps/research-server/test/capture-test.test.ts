import { expect, test, vi } from 'vitest';
import { studyReadinessGateway, studyRuntimeFacts } from '../src/study-readiness';
import { captureTestAuthority } from '../src/capture-test-authority';
import type { CaptureTestAuthority } from '../src/capture-test-authority';
import { STUDY_TEST_ROUTES, studyWelcome } from '../../../packages/research-core/src/welcome';
const origin = 'https://research.example.com', config = { deployment: 'https://synthetic.convex.cloud', gatewaySecret: 'a'.repeat(64), publicOrigin: origin };
const scope = { clientId: 'client-1', projectId: 'project-1', studyId: 'study-1', studyVersion: 1 }, input = { scope, requestId: 'stable-test-request', expectedBinding: 'b'.repeat(64), device: { browser: 'Synthetic browser', platform: 'Synthetic desktop' } };
const receipt = { invitationId: 'invite-1', sessionId: 'session-1', requestId: input.requestId, scope, binding: input.expectedBinding, configurationDigest: 'c'.repeat(64), issuedAt: 1, expiresAt: 2, retainUntil: 3, device: input.device, deviceContext: 'operator-reported' as const, revokedAt: null };
const request = (path: string, body: unknown, extra: Record<string, string> = {}) => new Request(origin + path, { method: 'POST', headers: { Origin: origin, Host: new URL(origin).host, Authorization: 'Bearer synthetic-auth', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
test('preview/readback/status routes are exact, authenticated and never issue or dispatch providers', async () => {
  const welcome = studyWelcome({ scope, title: 'Study', introduction: 'Welcome', prototypeUrl: null, clientName: 'Client', operatorName: 'Operator' });
  const authority = { preview: vi.fn(async () => ({ welcome, binding: input.expectedBinding, configurationDigest: 'c'.repeat(64), setup: { controlledDomRequired: false, controlledDomAuthorized: false } })), close: vi.fn(async () => ({ state: 'found' as const, receipt })), issue: vi.fn(async () => ({ receipt, token: 'd'.repeat(64) })), receipt: vi.fn(async () => ({ state: 'unresolved' as const })), status: vi.fn(async () => ({ state: 'unresolved' as const })) } satisfies CaptureTestAuthority;
  const gateway = studyReadinessGateway(config, studyRuntimeFacts(config, {}), () => ({}) as any, () => authority);
  expect((await gateway(request(STUDY_TEST_ROUTES.preview, { scope })))!.status).toBe(200); expect(authority.preview).toHaveBeenCalledWith(scope, expect.objectContaining({ voice: { enabled: false, qualified: false } }));
  expect((await gateway(request(STUDY_TEST_ROUTES.close, input)))!.status).toBe(200); expect(authority.close).toHaveBeenCalledWith(input);
  expect((await gateway(request(STUDY_TEST_ROUTES.receipt, input)))!.status).toBe(200); expect((await gateway(request(STUDY_TEST_ROUTES.status, input)))!.status).toBe(200); expect(authority.receipt).toHaveBeenCalledWith(input); expect(authority.issue).not.toHaveBeenCalled();
  expect((await gateway(request(STUDY_TEST_ROUTES.issue, { ...input, runtime: { capture: { enabled: true } } })))!.status).toBe(409); expect(authority.issue).not.toHaveBeenCalled();
  expect((await gateway(request(STUDY_TEST_ROUTES.preview, { scope, consent: true })))!.status).toBe(409); expect((await gateway(request(STUDY_TEST_ROUTES.issue, input, { Origin: 'https://foreign.example' })))!.status).toBe(403); expect((await gateway(request(STUDY_TEST_ROUTES.issue, input, { Authorization: '' })))!.status).toBe(403);
  expect((await gateway(request(STUDY_TEST_ROUTES.issue, input)))!.status).toBe(200); expect(authority.issue).toHaveBeenCalledOnce();
});
test('plaintext test link is returned once, never in receipt/status and unknown issue is not automatically retried', async () => {
  const bodies: any[] = []; let inserted = true;
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    const value = body.path.endsWith(':issue') ? { receipt, inserted } : { state: 'found', receipt };
    return Response.json({ status: 'success', value });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const authority = captureTestAuthority(config.deployment, config.gatewaySecret, 'synthetic-auth', new AbortController().signal), runtime = studyRuntimeFacts(config, {})();
    const first = await authority.issue(input, runtime); expect(first.token).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(bodies[0])).not.toContain(first.token); expect(JSON.stringify(bodies[0])).toContain('tokenHash'); inserted = false;
    expect((await authority.issue(input, runtime)).token).toBeNull(); const readback = await authority.receipt(input); expect(readback).toEqual({ state: 'found', receipt }); expect(JSON.stringify(readback)).not.toContain(first.token); expect(bodies.at(-1).path).toBe('researchCaptureTests:receipt');
    fetcher.mockRejectedValueOnce(new Error('unknown acknowledgement')); const before = fetcher.mock.calls.length; await expect(authority.issue({ ...input, requestId: 'unknown-test-issue' }, runtime)).rejects.toThrow(); expect(fetcher.mock.calls.length).toBe(before + 1);
  } finally { vi.unstubAllGlobals(); }
});
test('typed native terminal issue/close is preserved without a plaintext token; generic errors remain unresolved', async () => {
  const closed = { state: 'closed' as const, terminal: { input, reason: 'operator-closed' as const, closedAt: 10 } }, bodies: any[] = [];
  const fetcher = vi.fn(async (_url, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); return Response.json({ status: 'success', value: closed }); }); vi.stubGlobal('fetch', fetcher);
  try {
    const authority = captureTestAuthority(config.deployment, config.gatewaySecret, 'synthetic-auth', new AbortController().signal);
    expect(await authority.issue(input, studyRuntimeFacts(config, {})())).toEqual(closed); expect(await authority.close(input)).toEqual(closed); expect(bodies.map(x=>x.path)).toEqual(['researchCaptureTests:issue','researchCaptureTests:close']); expect(bodies[1].args[0].input).toEqual(input); expect(bodies[1].args[0].proof).toBeDefined();
    const factory = { ...authority, close: vi.fn().mockRejectedValue(new Error('unknown close')) };
    const gateway = studyReadinessGateway(config, studyRuntimeFacts(config, {}), () => ({}) as any, () => factory);
    const failed = (await gateway(request(STUDY_TEST_ROUTES.close, input)))!; expect(failed.status).toBe(409); expect((await failed.json()).state).toBe('unresolved'); expect(factory.close).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
