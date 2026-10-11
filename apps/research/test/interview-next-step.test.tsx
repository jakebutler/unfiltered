import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { Participant } from '../src/state';
import { claimInterviewAutomatic, interviewRequestKey } from '../src/interview-automatic';
import { InterviewNextStep } from '../src/InterviewNextStep';
vi.mock('convex/react', () => ({ useConvex: () => ({ mutation: vi.fn() }) }));
const pending = { scope: { sessionId: 'session-one', requestId: 'interview-request-1', promptId: 'q1', expectedRevision: 2, answerSourceId: 'answer-1' }, state: 'pending', automaticAllowed: true } as NonNullable<Participant['pendingInterview']>;
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test('repeated effect setup and reload cannot claim the same automatic inference twice', () => {
  const saved = storage();
  expect(claimInterviewAutomatic(pending, saved)).toBe('claimed');
  expect(claimInterviewAutomatic(pending, saved)).toBe('unconfirmed');
  expect(claimInterviewAutomatic(structuredClone(pending), saved)).toBe('unconfirmed');
  expect([...saved.values]).toEqual([[interviewRequestKey(pending), 'started']]);
});
test('native attempted/unknown state and unavailable storage never authorize automatic inference', () => {
  const saved = storage();
  expect(claimInterviewAutomatic({ ...pending, automaticAllowed: false, state: 'unknown' }, saved)).toBe('unconfirmed');
  expect(saved.values.size).toBe(0);
  expect(claimInterviewAutomatic(pending, { getItem: () => { throw Error('storage blocked'); }, setItem: vi.fn() })).toBe('unavailable');
  expect(claimInterviewAutomatic(pending, { getItem: () => null, setItem: () => { throw Error('quota'); } })).toBe('unavailable');
});
test('a genuinely new native turn has a separate claim; revision change alone does not replay', () => {
  const saved = storage(); claimInterviewAutomatic(pending, saved);
  expect(claimInterviewAutomatic({ ...pending, scope: { ...pending.scope, expectedRevision: 9 } }, saved)).toBe('unconfirmed');
  expect(claimInterviewAutomatic({ ...pending, scope: { ...pending.scope, requestId: 'interview-request-2' } }, saved)).toBe('claimed');
});
test('pending interview renders saved-answer and explicit recovery instead of a completion screen', () => {
  const html = renderToStaticMarkup(createElement(InterviewNextStep, { token: 'a'.repeat(64), pending, refresh: vi.fn() }));
  expect(html).toContain('Your answer is saved.');
  expect(html).toContain('Check saved state'); expect(html).toContain('Continue with script');
  expect(html).not.toContain('Interview complete');
});
