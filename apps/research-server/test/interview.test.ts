import { expect, test, vi } from 'vitest';
import { continueInterviewScript, digitalOceanInterview, interviewMessages, runInterviewTurn, type InterviewAuthority, type InterviewReservation, type InterviewScope, type InterviewProvider } from '../src/interview';
import { scriptPrompt, type InterviewContext } from '../../../packages/research-core/src/interview';
import type { Fetch } from '../../../packages/clinical-core/src/transport';

const reservation: InterviewReservation = { id: 'root-interview-reserved', model: 'qwen3.8-max', maxOutputTokens: 128, maxInputBytes: 64000, expiresAt: Date.now() + 60000 };
function fixture() {
  const context: InterviewContext = { sessionId: 'synthetic-session', revision: 2, consentEpoch: 1, retainUntil: Date.now() + 60000, goals: ['Understand delivery'], script: [{ id: 'q1', question: 'What happened?' }, { id: 'q2', question: 'What would you change?' }], scriptIndex: 0, currentPrompt: scriptPrompt({ id: 'q1', question: 'What happened?' }), followUps: [], answer: { sourceId: 'accepted-source', promptId: 'q1', text: 'Delivery cost was unclear.', channel: 'text', intent: 'answer' } };
  const scope: InterviewScope = { sessionId: context.sessionId, promptId: 'q1', expectedRevision: 2, answerSourceId: context.answer.sourceId, requestId: 'interview-request-1' };
  const proposal = { decision: 'follow-up', question: 'Where did you look for delivery cost?', goalIndex: 0, sourceId: context.answer.sourceId, quote: 'Delivery cost' };
  const provider = { model: reservation.model, prepare: vi.fn<InterviewProvider['prepare']>(async () => ({ inputHash: 'a'.repeat(64), requestBytes: 1234, maxOutputTokens: 128 })), generate: vi.fn<InterviewProvider['generate']>(async () => ({ requestId: 'offline-only-response', proposal, outputHash: 'b'.repeat(64), receipt: { requestId: 'offline-only-response', model: reservation.model, providerExecution: 'completed' as const, usage: null, requestBytes: 1234, elapsedMs: 1 } })) };
  const authority = { inspect: vi.fn<InterviewAuthority['inspect']>(async () => context), admit: vi.fn<InterviewAuthority['admit']>(async () => ({ attemptId: scope.requestId, state: 'reserved' as const, reservation })), begin: vi.fn<InterviewAuthority['begin']>(async () => true), finish: vi.fn<InterviewAuthority['finish']>(async () => {}), advance: vi.fn<InterviewAuthority['advance']>(async () => {}) } satisfies InterviewAuthority;
  const run = (runtime = { enabled: true, provider }) => runInterviewTurn(authority, runtime, scope, new AbortController().signal);
  return { context, scope, provider, authority, run };
}
test('default-off and explicit skip advance without consuming a provider reservation', async () => {
  const f = fixture(); expect(await f.run({ enabled: false, provider: f.provider })).toMatchObject({ state: 'advanced', decision: { reason: 'disabled', prompt: { id: 'q2' } } });
  f.context.answer.intent = 'skip'; f.context.answer.text = '';
  expect(await f.run()).toMatchObject({ state: 'advanced', decision: { reason: 'skip' } });
  expect(f.authority.admit).not.toHaveBeenCalled(); expect(f.provider.generate).not.toHaveBeenCalled();
});
test('prepared wire caps bind exact reservation before the once-only dispatch fence', async () => {
  const f = fixture(); f.provider.prepare.mockResolvedValue({ inputHash: 'a'.repeat(64), requestBytes: 1234, maxOutputTokens: 4096 });
  expect(await f.run()).toMatchObject({ state: 'failed' }); expect(f.authority.begin).not.toHaveBeenCalled(); expect(f.provider.generate).not.toHaveBeenCalled();
});
test('a lost begin acknowledgement does not dispatch any provider request', async () => {
  const f = fixture(); f.authority.begin.mockRejectedValue(new Error('ack unknown'));
  expect(await f.run()).toMatchObject({ state: 'unknown' }); expect(f.provider.generate).not.toHaveBeenCalled(); expect(f.authority.finish).not.toHaveBeenCalled();
});
test('two runs consume two authoritative reservations; restart does not replay an unknown receipt', async () => {
  const f = fixture(), states = new Map<string, 'reserved' | 'dispatching' | 'ready' | 'failed' | 'unknown'>(); let charges = 0;
  // Offline persistent-authority double, shared across reconstructed runtimes.
  f.authority.admit.mockImplementation(async scope => { const state = states.get(scope.requestId); if (state) return { attemptId: scope.requestId, state, reservation }; if (++charges > 2) throw new Error('allocation exhausted'); states.set(scope.requestId, 'reserved'); return { attemptId: scope.requestId, state: 'reserved', reservation }; });
  f.authority.begin.mockImplementation(async (_scope, id) => { if (states.get(id) !== 'reserved') return false; states.set(id, 'dispatching'); return true; });
  f.authority.finish.mockImplementation(async (_scope, id, _hash, result) => { states.set(id, result.state); });
  expect(await f.run()).toMatchObject({ state: 'ready' });
  const first = await f.run(); expect(first.state).toBe('ready'); expect(f.provider.generate).toHaveBeenCalledTimes(1); expect(charges).toBe(1);
  f.scope.requestId = 'interview-request-2'; f.provider.generate.mockRejectedValue(new Error('network unknown'));
  expect(await f.run()).toMatchObject({ state: 'unknown' });
  const reconstructed = { enabled: true, provider: { ...f.provider, generate: vi.fn(f.provider.generate) } };
  expect(await f.run(reconstructed)).toMatchObject({ state: 'unknown' }); expect(reconstructed.provider.generate).not.toHaveBeenCalled(); expect(charges).toBe(2);
});
test('consent/revision change after output rejects the proposal instead of installing a prompt', async () => {
  const f = fixture(); f.provider.generate.mockImplementation(async () => { f.context.consentEpoch++; return { requestId: 'offline', proposal: { decision: 'advance' }, outputHash: 'b'.repeat(64), receipt: { requestId: 'offline', model: reservation.model, providerExecution: 'completed' as const, usage: null, requestBytes: 1234, elapsedMs: 1 } }; });
  expect(await f.run()).toMatchObject({ state: 'failed' }); expect(f.authority.finish.mock.calls.at(-1)?.[3]).toMatchObject({ decision: null, errorCode: 'invalid-interview-proposal' });
});
test('caller cancellation bounds a hanging provider and preserves unknown charged state', async () => {
  const f = fixture(), controller = new AbortController();
  f.provider.generate.mockImplementation(() => { controller.abort(); return new Promise(() => {}); });
  expect(await runInterviewTurn(f.authority, { enabled: true, provider: f.provider }, f.scope, controller.signal)).toMatchObject({ state: 'unknown' });
  expect(f.authority.finish.mock.calls.at(-1)?.[3]).toMatchObject({ state: 'unknown', decision: null }); expect(f.provider.generate).toHaveBeenCalledTimes(1);
});
test('lost final save acknowledgement returns unknown without running inference twice', async () => {
  const f = fixture(); f.authority.finish.mockRejectedValue(new Error('unknown native save'));
  expect(await f.run()).toMatchObject({ state: 'unknown' }); expect(f.provider.generate).toHaveBeenCalledTimes(1);
});
test('DO adapter uses reserved token cap, exact wire hash and only approved research model', async () => {
  const f = fixture();
  const fetcher = vi.fn<Fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); expect(body.max_tokens).toBe(128); expect(body.model).toBe('qwen3.8-max'); return Response.json({ id: 'offline-wire', model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'advance' }) } }] }); });
  const provider = digitalOceanInterview({ endpoint: 'https://inference.do-ai.run', apiKey: 'offline-only', model: 'qwen3.8-max', timeoutMs: 1000, maxOutputTokens: 4096 }, fetcher), messages = interviewMessages(f.context), prepared = await provider.prepare(messages, reservation);
  await expect(provider.generate(messages, reservation, { ...prepared, inputHash: 'f'.repeat(64) }, new AbortController().signal)).rejects.toThrow('interview-request-changed'); expect(fetcher).not.toHaveBeenCalled();
  expect(await provider.generate(messages, reservation, prepared, new AbortController().signal)).toMatchObject({ proposal: { decision: 'advance' } }); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(() => digitalOceanInterview({ endpoint: 'https://inference.do-ai.run', apiKey: 'offline-only', model: 'kimi-k3', timeoutMs: 1000, maxOutputTokens: 128 })).toThrow('interview-provider-unavailable');
});

test('explicit Continue with script keeps charge and revision-fences a late proposal without retry', async () => {
  const f = fixture(); let deliver!: (value: Awaited<ReturnType<InterviewProvider['generate']>>) => void;
  f.provider.generate.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  f.authority.advance.mockImplementation(async () => { f.context.revision++; });
  const pending = f.run(); await vi.waitFor(() => expect(f.provider.generate).toHaveBeenCalledTimes(1));
  expect(await continueInterviewScript(f.authority, { ...f.scope, requestId: 'continue-script-1' }, new AbortController().signal)).toMatchObject({ state: 'advanced', decision: { reason: 'recovery', prompt: { id: 'q2' } } });
  deliver({ requestId: 'late-output', proposal: { decision: 'advance' }, outputHash: 'b'.repeat(64), receipt: { requestId: 'late-output', model: reservation.model, providerExecution: 'completed', usage: null, requestBytes: 1234, elapsedMs: 1 } });
  expect(await pending).toMatchObject({ state: 'failed' });
  expect(f.authority.admit).toHaveBeenCalledTimes(1); expect(f.provider.generate).toHaveBeenCalledTimes(1); expect(f.authority.finish.mock.calls.at(-1)?.[3].decision).toBeNull();
});
test('known completed invalid JSON preserves provider identity/usage/timing and is failed, not transport unknown', async () => {
  const f = fixture(), fetcher = vi.fn<Fetch>(async () => Response.json({ id: 'completed-invalid', model: 'qwen3.8-max', usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, choices: [{ finish_reason: 'stop', message: { content: 'invalid JSON' } }] }));
  const provider = digitalOceanInterview({ endpoint: 'https://inference.do-ai.run', apiKey: 'offline-only', model: reservation.model, timeoutMs: 1000, maxOutputTokens: 128 }, fetcher);
  expect(await runInterviewTurn(f.authority, { enabled: true, provider }, f.scope, new AbortController().signal)).toMatchObject({ state: 'failed' });
  expect(f.authority.finish.mock.calls.at(-1)?.[3]).toMatchObject({ state: 'failed', providerRequestId: 'completed-invalid', providerReceipt: { providerExecution: 'completed', usage: { total_tokens: 100 }, elapsedMs: expect.any(Number) }, outputHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('spoken next-step context labels recognition as unreviewed rather than confirmed report evidence', () => {
  const f = fixture(); f.context.answer.channel = 'spoken-answer';
  const packet = JSON.stringify(interviewMessages(f.context));
  expect(packet).toContain('Unreviewed speech recognition wording');
  expect(packet).toContain('not participant-confirmed'); expect(packet).toContain('not report evidence before final review');
  expect(packet).toContain('spoken-answer'); expect(packet).not.toContain('Participant-submitted answer wording');
});
