import { describe, expect, it, vi } from 'vitest';
import { SafetyReviewQueue, type SafetyReviewResult } from '../src/safety-review-client';

const flush = () => new Promise(resolve => setImmediate(resolve));
const reviewed = (escalated = false): SafetyReviewResult => ({ state: 'reviewed', escalated });
const pending: SafetyReviewResult = { state: 'pending', escalated: false };

function harness(responses: Array<SafetyReviewResult | Error | (() => Promise<SafetyReviewResult>)> = []) {
  const script = responses.slice();
  const post = vi.fn((_signalId: string): Promise<SafetyReviewResult> => {
    const next = script.shift() ?? reviewed();
    if (typeof next === 'function') return next();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  const escalated = vi.fn();
  const timers = new Map<number, { ms: number; fn: () => void }>();
  let nextId = 1;
  const queue = new SafetyReviewQueue({
    post, escalated,
    schedule: (ms, fn) => { const id = nextId++; timers.set(id, { ms, fn }); return id; },
    cancel: timer => { timers.delete(timer as number); },
  });
  /** Fires the earliest scheduled retry and returns its delay. */
  const fireTimer = () => {
    const [id, timer] = [...timers.entries()][0] ?? [];
    if (id === undefined || !timer) throw new Error('no timer scheduled');
    timers.delete(id);
    timer.fn();
    return timer.ms;
  };
  return { queue, post, escalated, timers, fireTimer };
}

describe('SafetyReviewQueue', () => {
  it('dedupes repeated ids across syncs while a request is in flight', async () => {
    let resolveFirst!: (value: SafetyReviewResult) => void;
    const { queue, post } = harness([() => new Promise(resolve => { resolveFirst = resolve; }), reviewed()]);
    queue.sync(['sig-1', 'sig-2']);
    queue.sync(['sig-1', 'sig-2']);
    expect(post.mock.calls.map(call => call[0])).toEqual(['sig-1', 'sig-2']);
    resolveFirst(reviewed());
    await flush();
    queue.sync(['sig-1']);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retries pending results after 3, 6 and 12 seconds, then gives up silently', async () => {
    const { queue, post, timers, fireTimer } = harness([pending, pending, pending, pending, reviewed()]);
    queue.sync(['sig-1']);
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(fireTimer()).toBe(3000);
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
    expect(fireTimer()).toBe(6000);
    await flush();
    expect(post).toHaveBeenCalledTimes(3);
    expect(fireTimer()).toBe(12000);
    await flush();
    expect(post).toHaveBeenCalledTimes(4);
    expect(timers.size).toBe(0);
    // Abandoned after three retries: a later sync does not start another retry cycle.
    queue.sync(['sig-1']);
    await flush();
    expect(post).toHaveBeenCalledTimes(4);
    expect(timers.size).toBe(0);
  });

  it('retries thrown errors on the same schedule', async () => {
    const { queue, post, fireTimer } = harness([new Error('network'), reviewed()]);
    queue.sync(['sig-1']);
    await flush();
    expect(fireTimer()).toBe(3000);
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps a signal waiting for its retry without requesting it from another sync', async () => {
    const { queue, post, fireTimer } = harness([pending, reviewed()]);
    queue.sync(['sig-1']);
    await flush();
    queue.sync(['sig-1']);
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    fireTimer();
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never requests reviewed signals again in this page lifetime', async () => {
    const { queue, post } = harness([reviewed(), reviewed()]);
    queue.sync(['sig-1']);
    await flush();
    queue.sync(['sig-1', 'sig-2']);
    await flush();
    queue.sync(['sig-1']);
    await flush();
    expect(post.mock.calls.map(call => call[0])).toEqual(['sig-1', 'sig-2']);
  });

  it('calls escalated once per signal, even across a pending retry', async () => {
    const { queue, escalated, fireTimer } = harness([{ state: 'pending', escalated: true }, reviewed(true), reviewed(true)]);
    queue.sync(['sig-1']);
    await flush();
    fireTimer();
    await flush();
    queue.sync(['sig-2']);
    await flush();
    expect(escalated).toHaveBeenCalledTimes(2);
  });

  it('does not call escalated when the review is not escalated', async () => {
    const { queue, escalated } = harness([reviewed(false)]);
    queue.sync(['sig-1']);
    await flush();
    expect(escalated).not.toHaveBeenCalled();
  });

  it('dispose cancels scheduled retries and ignores late results', async () => {
    let resolveLate!: (value: SafetyReviewResult) => void;
    const { queue, post, escalated } = harness([() => new Promise(resolve => { resolveLate = resolve; })]);
    queue.sync(['sig-1']);
    queue.dispose();
    resolveLate({ state: 'reviewed', escalated: true });
    await flush();
    expect(escalated).not.toHaveBeenCalled();
    queue.sync(['sig-2']);
    expect(post).toHaveBeenCalledTimes(1);

    const retrying = harness([pending]);
    retrying.queue.sync(['sig-3']);
    await flush();
    expect(retrying.timers.size).toBe(1);
    retrying.queue.dispose();
    expect(retrying.timers.size).toBe(0);
  });
});
