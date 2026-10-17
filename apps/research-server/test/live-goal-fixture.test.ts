import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { captureLiveResponse, runLiveGoalFixture, liveGoalLimits } from '../src/live-goal-fixture';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function path() { const dir = await mkdtemp(join(tmpdir(), 'live-goal-')); dirs.push(dir); return join(dir, 'response.private.json'); }
const wire = JSON.stringify({ model: 'qwen3.8-max', max_tokens: 512 }), digest = createHash('sha256').update(wire).digest('hex'), endpoint = 'https://inference.do-ai.run/v1/chat/completions';
test('raw completed HTTP body is retained privately before parsed/install success and cannot dispatch twice', async () => {
  const file = await path(), raw = '{"id":"known-response","choices":[{"finish_reason":"stop"}]}';
  const native = vi.fn<typeof fetch>(async () => new Response(raw, { status: 200 })), capture = captureLiveResponse(file, digest, native);
  expect(await (await capture.fetch(endpoint, { body: wire })).text()).toBe(raw);
  expect(await readFile(file, 'utf8')).toBe(raw); expect((await stat(file)).mode & 0o077).toBe(0);
  expect(capture.status).toMatchObject({ headersReceived: true, bodyComplete: true, httpSettled: true, bytes: Buffer.byteLength(raw), error: null });
  expect(capture.status.bodyHash).toBe(createHash('sha256').update(raw).digest('hex'));
  await expect(capture.fetch(endpoint, { body: wire })).rejects.toThrow('repeated'); expect(native).toHaveBeenCalledTimes(1);
});
test('aborted HTTP read preserves partial bytes and does not claim provider completion', async () => {
  const file = await path(), controller = new AbortController(); let read = false;
  const native = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ pull(c) { if (!read) { read = true; c.enqueue(new TextEncoder().encode('{"partial":')); setTimeout(() => controller.abort(), 20); } } })));
  const capture = captureLiveResponse(file, digest, native);
  await expect(capture.fetch(endpoint, { body: wire, signal: controller.signal })).rejects.toThrow('deadline');
  expect(await readFile(file, 'utf8')).toBe('{"partial":'); expect(capture.status).toMatchObject({ headersReceived: true, bodyComplete: false, aborted: true, error: 'http-outcome-unconfirmed' });
  expect(capture.status.bodyHash).toBe(createHash('sha256').update('{"partial":').digest('hex'));
});
test('changed request, response bound and missing explicit action cannot dispatch inference', async () => {
  const native = vi.fn<typeof fetch>(async () => new Response('x'.repeat(64_001))), capture = captureLiveResponse(await path(), digest, native);
  await expect(capture.fetch(endpoint, { body: 'changed' })).rejects.toThrow('Unreviewed'); expect(native).not.toHaveBeenCalled();
  await expect(capture.fetch(endpoint, { body: wire })).rejects.toThrow('over-64000'); expect(capture.status.bodyComplete).toBe(false); expect(capture.status.error).toBe('response-bound');
  expect(capture.status.bytes).toBe(64_000);
  await expect(runLiveGoalFixture('dispatch', { output: '/unused', config: '/unused', allow: false })).rejects.toThrow('Explicit');
  expect(liveGoalLimits).toEqual({ model: 'qwen3.8-max', timeoutMs: 15_000, maxOutputTokens: 512, maxRequestBytes: 64_000 });
  expect(await runLiveGoalFixture('offline-bootstrap-check', { output: '', config: '' })).toMatchObject({ state: 'offline-bootstrap-ready', providerDispatch: false });
});
