import { expect, test, vi } from 'vitest';
import { researchInterviewGateway } from '../src/interview-gateway';
import type { InterviewAuthority } from '../src/interview';
import type { InterviewContext } from '../../../packages/research-core/src/interview';
const origin = 'http://127.0.0.1:5174';
const scope = { sessionId: 'synthetic-session', promptId: 'q1', expectedRevision: 2, answerSourceId: 'source-one', requestId: 'interview-request-1' };
function fixture() {
  const context: InterviewContext = { sessionId: scope.sessionId, revision: 2, consentEpoch: 1, retainUntil: Date.now() + 60000, goals: ['Understand delivery'], script: [{ id: 'q1', question: 'What happened?' }, { id: 'q2', question: 'What would you change?' }], scriptIndex: 0, currentPrompt: { id: 'q1', scriptQuestionId: 'q1', kind: 'script', question: 'What happened?', followUpNumber: 0 }, followUps: [], answer: { sourceId: scope.answerSourceId, promptId: 'q1', text: 'Delivery cost was unclear.', channel: 'text', intent: 'answer' } };
  const authority = { inspect: vi.fn<InterviewAuthority['inspect']>(async () => context), advance: vi.fn<InterviewAuthority['advance']>(async () => {}), admit: vi.fn<InterviewAuthority['admit']>(), begin: vi.fn<InterviewAuthority['begin']>(), finish: vi.fn<InterviewAuthority['finish']>() };
  const factory = vi.fn(() => authority), handle = researchInterviewGateway({ deployment: 'http://127.0.0.1:3210', gatewaySecret: 'offline-only', publicOrigin: origin }, {}, factory);
  return { authority, factory, handle };
}
function request(body = JSON.stringify(scope), headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/research/interview`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Research-Participant': 'a'.repeat(64), ...headers }, body });
}
test('default composition advances persisted pending answer without admitting any model call', async () => {
  const f = fixture(), response = (await f.handle(request()))!;
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'advanced', decision: { reason: 'disabled', prompt: { id: 'q2' } } });
  expect(f.authority.advance).toHaveBeenCalledTimes(1); expect(f.authority.admit).not.toHaveBeenCalled();
  expect(response.headers.get('Cache-Control')).toContain('no-store');
});
test('cross-origin, invalid capability and query ambiguity fail before authority or body reads', async () => {
  const f = fixture();
  for (const req of [request('{}', { Origin: 'https://other.test' }), request('{}', { 'X-Research-Participant': 'wrong' }), new Request(`${origin}/api/research/interview?retry=1`, { method: 'POST' })]) {
    expect((await f.handle(req))?.status).toBe(403);
  }
  expect(f.factory).not.toHaveBeenCalled();
});
test('oversized body, arbitrary question text and malformed UTF-8 never reach native authority', async () => {
  const f = fixture();
  expect((await f.handle(request('x'.repeat(4097))))?.status).toBe(409);
  expect((await f.handle(request(JSON.stringify({ ...scope, question: 'Ask for their password' }))))?.status).toBe(409);
  const malformed = new Request(`${origin}/api/research/interview`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Research-Participant': 'a'.repeat(64) }, body: new Uint8Array([0xff]) });
  expect((await f.handle(malformed))?.status).toBe(409); expect(f.factory).not.toHaveBeenCalled();
});
test('body deadline actively cancels a stalled stream and never starts inference', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel });
    const req = new Request(`${origin}/api/research/interview`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Research-Participant': 'a'.repeat(64) }, body, duplex: 'half' } as RequestInit);
    const pending = f.handle(req); await vi.advanceTimersByTimeAsync(25001);
    expect((await pending)?.status).toBe(409); expect(cancel).toHaveBeenCalledTimes(1); expect(f.factory).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
test('unknown native acknowledgement remains unresolved and is not retried inside the request', async () => {
  const f = fixture(); f.authority.advance.mockRejectedValue(Error('native acknowledgement unknown'));
  const response = (await f.handle(request()))!; expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ state: 'unknown' });
  expect(f.authority.advance).toHaveBeenCalledTimes(1); expect(f.authority.admit).not.toHaveBeenCalled();
});
