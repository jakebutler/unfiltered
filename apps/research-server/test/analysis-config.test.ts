import { describe, expect, it, vi } from 'vitest';
import { assembleAnalysisRuntime, loadAnalysisRuntime, parseAnalysisConfig } from '../src/analysis-config';
const raw = { enabled: true, provider: 'digitalocean', model: 'qwen3.8-max', qualificationId: 'DO-V1', ffmpegExecutable: '/qualified/ffmpeg', timeoutMs: 15_000, maxRequestBytes: 64_000, reservations: [{ id: 'root-reserved-run-1', maxInputBytes: 32_000, maxOutputTokens: 128, expiresAt: Date.now() + 60_000 }] };
describe('root-owned private opt-in analysis assembly', () => {
  it('stays disabled with no config or explicit disabled config and never reads a key', async () => {
    const key = vi.fn(() => 'synthetic-not-a-key'); expect(assembleAnalysisRuntime({ enabled: false }, key)).toEqual({ reservations: [], visionQualified: false }); expect(key).not.toHaveBeenCalled();
    const environment = new Proxy({}, { get() { throw new Error('Environment must not be read'); } }); expect((await loadAnalysisRuntime(undefined, environment)).provider).toBeUndefined();
  });
  it('rejects unqualified models, key/budget injection, wider limits and duplicate reservations', () => {
    for (const patch of [{ model: 'glm-5.3-flash' }, { qualificationId: 'unreviewed' }, { apiKey: 'secret' }, { credits: 100 }, { timeoutMs: 30_001 }, { maxRequestBytes: 64_001 }, { ffmpegExecutable: 'ffmpeg' }, { reservations: [{ ...raw.reservations[0], maxOutputTokens: 2049 }] }, { reservations: [raw.reservations[0], raw.reservations[0]] }]) expect(() => parseAnalysisConfig({ ...raw, ...patch })).toThrow('Invalid private');
    expect(() => parseAnalysisConfig({ enabled: false, apiKey: 'secret' })).toThrow('Invalid private');
  });
  it('assembles exact qualified immutable caps and binds the actual adapter to per-run output limits', async () => {
    const fetcher = vi.fn(async (_url, init) => { const body = JSON.parse(init!.body as string); expect(body.model).toBe('qwen3.8-max'); expect(body.max_tokens).toBe(128); return Response.json({ id: 'synthetic-response', model: body.model, choices: [{ finish_reason: 'stop', message: { content: '{"findings":[]}' } }] }); });
    const runtime = assembleAnalysisRuntime(parseAnalysisConfig(raw), () => 'synthetic-not-a-key', fetcher), reservation = runtime.reservations[0];
    expect(runtime).toMatchObject({ visionQualified: true, maxFrames: 1, maxRequestBytes: 64_000 }); expect(Object.isFrozen(runtime)).toBe(true); expect(Object.isFrozen(reservation)).toBe(true);
    expect((await runtime.provider!.prepare([{ role: 'user', content: 'Synthetic fixture' }], reservation)).maxOutputTokens).toBe(128); await runtime.provider!.generate([{ role: 'user', content: 'Synthetic fixture' }], reservation); expect(fetcher).toHaveBeenCalledOnce();
    expect(() => assembleAnalysisRuntime(parseAnalysisConfig(raw), () => undefined)).toThrow('key unavailable');
  });
});


it('binds explicitly prospective research2048/30s while retaining the15s default and64KB ceiling', async () => {
  const config = parseAnalysisConfig({ ...raw, timeoutMs: 30_000, reservations: [{ ...raw.reservations[0], maxOutputTokens: 2048 }] });
  const fetcher = vi.fn(async (_url, init) => {
    expect(JSON.parse(init!.body as string).max_tokens).toBe(2048);
    return Response.json({ id: 'synthetic-expanded', model: 'qwen3.8-max', choices: [{ finish_reason: 'stop', message: { content: '{"findings":[]}' } }] });
  });
  const runtime = assembleAnalysisRuntime(config, () => 'test-key', fetcher);
  await runtime.provider!.generate([{ role: 'user', content: 'Synthetic research' }], runtime.reservations[0]);
  expect(fetcher).toHaveBeenCalledOnce(); expect(runtime.maxRequestBytes).toBe(64_000);
  const { timeoutMs: _removed, ...defaulted } = raw; expect(parseAnalysisConfig(defaulted)).toMatchObject({ timeoutMs: 15_000 });
});

it('keeps text-only opt-in explicit and bounded without changing legacy fixture defaults', () => {
  expect(parseAnalysisConfig(raw)).toMatchObject({ textOnly: false });
  expect(assembleAnalysisRuntime(parseAnalysisConfig({ ...raw, textOnly: true }), () => 'synthetic-key')).toMatchObject({ textOnly: true });
  expect(() => parseAnalysisConfig({ ...raw, textOnly: 'true' })).toThrow('Invalid private');
});
