import { afterEach, expect, test, vi } from 'vitest';
import { createResearchSpeechTransport, type ResearchSpeechOptions } from '../src/research-speech';
import type { ResearchSpeechAuthority } from '../../../packages/research-core/src/speech-contract';

afterEach(() => vi.useRealTimers());
const origin = 'https://research.example', token = 'a'.repeat(64);
const input = { requestId: 'speech-attempt-001', sessionId: 'session-001', sourceId: 'question-001', expectedRevision: 2 };
function fixture(overrides: Partial<ResearchSpeechOptions> = {}) {
  const release = vi.fn(async () => {}), providerSettle = vi.fn(async () => {});
  const authority: ResearchSpeechAuthority = {
    status: vi.fn(async () => ({ enabled: true })), authorize: vi.fn(async () => {}), inspect: vi.fn(async () => {}),
    reserve: vi.fn(async () => ({ settle: providerSettle })), output: vi.fn(async (_token, request) => ({ sessionId: request.sessionId, sourceId: request.sourceId, revision: request.expectedRevision, text: 'What did you expect?' })),
    transcript: vi.fn(), receipt: vi.fn(async () => null),
  };
  const ingress = { reserve: vi.fn(async () => ({ expiresAt: Date.now() + 180_000, authority: <T>(dispatch: () => Promise<T>) => dispatch(), release })) };
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } }));
  const transport = createResearchSpeechTransport({ origin, authority, ingress, fetcher, ...overrides });
  const request = (path = '/api/research/speech/output', body: BodyInit = JSON.stringify(input), extra: RequestInit = {}) => new Request(origin + path, { method: 'POST', headers: { Host: 'research.example', Origin: origin, 'Content-Type': 'application/json', 'X-Research-Participant': token }, body, ...extra });
  return { transport, authority, ingress, release, providerSettle, fetcher, request };
}
const enabled = { enabled: true, deepgramApiKey: 'private-test-only', elevenlabsApiKey: 'private-test-only' };
test('readiness uses effective enabled lifetime and public configuration, independently of credentials', () => {
  const off = fixture(), on = fixture(enabled), other = fixture({ ...enabled, deepgramApiKey: 'different-secret', elevenlabsApiKey: 'another-secret' });
  expect(off.transport.readinessEnabled()).toBe(false); expect(on.transport.readinessEnabled()).toBe(true);
  expect(on.transport.readinessConfiguration()).toMatch(/^[a-f0-9]{64}$/);
  expect(on.transport.readinessConfiguration()).toBe(other.transport.readinessConfiguration());
  expect(on.transport.readinessConfiguration()).toBe(off.transport.readinessConfiguration());
  on.transport.close(); expect(on.transport.readinessEnabled()).toBe(false); off.transport.close(); other.transport.close();
});
test('speech is disabled by default and never dispatches a provider', async () => {
  const f = fixture(); const response = await f.transport.handle(f.request());
  expect(response?.status).toBe(503); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.authority.reserve).not.toHaveBeenCalled(); f.transport.close();
});
test('exact Host and Origin are checked before ingress or authority work', async () => {
  const f = fixture(enabled);
  const request = f.request(); request.headers.set('Host', 'other.example');
  expect((await f.transport.handle(request))?.status).toBe(403);
  expect(f.ingress.reserve).not.toHaveBeenCalled(); expect(f.authority.authorize).not.toHaveBeenCalled(); f.transport.close();
});
test('TTS acquires voice admission and streams only server-authorized text', async () => {
  const f = fixture(enabled), response = await f.transport.handle(f.request());
  expect(response?.status).toBe(200); expect(f.ingress.reserve).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{32}$/), 'voice');
  expect(new Uint8Array(await response!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(f.authority.reserve).toHaveBeenCalledWith(token, expect.objectContaining({ promptId: input.sourceId }), expect.objectContaining({ provider: 'elevenlabs', maxCharacters: 20 }));
  expect(JSON.parse(f.fetcher.mock.calls[0][1]?.body as string).text).toBe('What did you expect?');
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce()); f.transport.close();
});
test('stalled body returns on deadline and retains ingress while cancellation is unresolved', async () => {
  vi.useFakeTimers(); const f = fixture(enabled);
  const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
  const pending = f.transport.handle(f.request('/api/research/speech/output', stalled, { duplex: 'half' } as RequestInit));
  await vi.advanceTimersByTimeAsync(5001);
  expect((await pending)?.status).toBe(503); expect(f.release).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); f.transport.close();
});
test('late provider headers after disconnect are cancelled before ingress release', async () => {
  const cancel = vi.fn(async () => {}); let deliver!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { deliver = resolve; }));
  const f = fixture({ ...enabled, fetcher }), abort = new AbortController();
  const pending = f.transport.handle(f.request(undefined, undefined, { signal: abort.signal }));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  abort.abort(); expect((await pending)?.status).toBe(503); expect(f.release).not.toHaveBeenCalled();
  deliver(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'audio/mpeg' } }));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce()); f.transport.close();
});
test('status auth reads are bounded, and owned transcript recovery never calls a provider', async () => {
  vi.useFakeTimers(); const f = fixture(); vi.mocked(f.authority.status).mockImplementation(() => new Promise(() => {}));
  const pending = f.transport.handle(new Request(origin + '/api/research/speech/status', { headers: { Host: 'research.example', Origin: origin, 'X-Research-Participant': token } }));
  await vi.advanceTimersByTimeAsync(10_001); expect((await pending)?.status).toBe(503); expect(f.release).not.toHaveBeenCalled(); f.transport.close();
});
test('separate commit transport waits for durable native terminal barrier, without repeating speech', async () => {
  vi.useFakeTimers(); const f = fixture(enabled);
  f.authority.terminalBarrier = vi.fn().mockResolvedValueOnce({ state: 'completed', active: false, rawSaved: true, transportSettled: false }).mockResolvedValue({ state: 'completed', active: false, rawSaved: true, transportSettled: true });
  const accepted = { attemptId: input.requestId, rawSourceId: 'raw-1', answerSourceId: 'answer-2', acceptedRevision: 3 };
  f.authority.commitSpoken = vi.fn(async () => accepted);
  const separate = createResearchSpeechTransport({ origin, authority: f.authority, ingress: f.ingress });
  const scope = { sessionId: input.sessionId, promptId: input.sourceId, expectedRevision: input.expectedRevision, requestId: input.requestId };
  const pending = separate.handle(f.request('/api/research/speech/commit', JSON.stringify(scope)));
  await vi.advanceTimersByTimeAsync(1); expect(f.authority.commitSpoken).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250); const response = await pending;
  expect(await response!.json()).toEqual(accepted); expect(f.authority.commitSpoken).toHaveBeenCalledOnce(); expect(f.fetcher).not.toHaveBeenCalled();
  separate.close(); f.transport.close();
});
test('unknown work is not committed, replayed, or admitted as completed playback', async () => {
  const f = fixture(enabled); f.authority.terminalBarrier = vi.fn(async () => ({ state: 'unknown', active: true, rawSaved: true, transportSettled: true })); f.authority.commitSpoken = vi.fn();
  const scope = { sessionId: input.sessionId, promptId: input.sourceId, expectedRevision: input.expectedRevision, requestId: input.requestId };
  expect((await f.transport.handle(f.request('/api/research/speech/commit', JSON.stringify(scope))))!.status).toBe(503);
  expect(f.authority.commitSpoken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  const response = await f.transport.handle(f.request('/api/research/speech/settlement', JSON.stringify({ ...scope, provider: 'elevenlabs' })));
  expect(response!.status).toBe(503); expect(f.authority.terminalBarrier).toHaveBeenLastCalledWith(token, scope, 'elevenlabs'); f.transport.close();
});

test('native named-grant continuous availability survives the HTTP status boundary', async () => {
  const f = fixture(enabled); vi.mocked(f.authority.status).mockResolvedValue({ enabled: true, continuous: true, grantName: 'VF2-named' });
  const response = await f.transport.handle(new Request(origin + '/api/research/speech/status', { headers: { Host: 'research.example', Origin: origin, 'X-Research-Participant': token } }));
  expect(await response!.json()).toEqual({ enabled: true, continuous: true, grantName: 'VF2-named' }); f.transport.close();
});

test('successful speech status keeps the HTTP invocation open through native release acknowledgement', async () => {
  const f = fixture(enabled); let acknowledge!: () => void;
  f.release.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  let completed = false;
  const response = f.transport.handle(new Request(origin + '/api/research/speech/status', { headers: { Host: 'research.example', Origin: origin, 'X-Research-Participant': token } })).then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce()); expect(completed).toBe(false);
  acknowledge(); expect((await response)!.status).toBe(200); f.transport.close();
});

test('speech release timeout is unresolved and never retries a native release or provider', async () => {
  vi.useFakeTimers(); const f = fixture(enabled); f.release.mockImplementation(() => new Promise(() => {}));
  const response = f.transport.handle(new Request(origin + '/api/research/speech/status', { headers: { Host: 'research.example', Origin: origin, 'X-Research-Participant': token } }));
  await vi.advanceTimersByTimeAsync(10_001); expect((await response)!.status).toBe(503);
  expect(f.release).toHaveBeenCalledOnce(); expect(f.fetcher).not.toHaveBeenCalled(); f.transport.close();
});

test.each(['method', 'malformed-body'])('known %s speech failure awaits native release ACK', async kind => {
  const f = fixture(enabled); let acknowledge!: () => void;
  f.release.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  const request = kind === 'method' ? new Request(origin + '/api/research/speech/output', { headers: { Host: 'research.example', Origin: origin, 'X-Research-Participant': token } }) : f.request(undefined, '{');
  let completed = false; const response = f.transport.handle(request).then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce()); expect(completed).toBe(false);
  acknowledge(); expect((await response)!.status).toBe(kind === 'method' ? 405 : 503); expect(f.fetcher).not.toHaveBeenCalled(); f.transport.close();
});

test.each(['authorize', 'output', 'reserve', 'fresh-output'] as const)('TTS %s diagnostics contain only fixed phase and elapsed time, even for secret-shaped thrown payloads', async phase => {
  const diagnostic = vi.fn(), f = fixture({ ...enabled, onUpstreamDiagnostic: diagnostic });
  const sensitive = new Error('private_key_secret providerbody https://secret.invalid/token');
  if (phase === 'authorize') vi.mocked(f.authority.authorize).mockRejectedValue(sensitive);
  if (phase === 'output') vi.mocked(f.authority.output).mockRejectedValue(sensitive);
  if (phase === 'reserve') vi.mocked(f.authority.reserve).mockRejectedValue(sensitive);
  if (phase === 'fresh-output') vi.mocked(f.authority.output).mockResolvedValueOnce({ sessionId: input.sessionId, sourceId: input.sourceId, revision: input.expectedRevision, text: 'What did you expect?' }).mockRejectedValueOnce(sensitive);
  expect((await f.transport.handle(f.request()))!.status).toBe(503);
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ event: 'research-tts-admission-failure', phase, elapsedMs: expect.any(Number) });
  expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private_key|secret|providerbody|https|speech-attempt|session/);
  expect(f.fetcher).not.toHaveBeenCalled(); f.transport.close();
});
