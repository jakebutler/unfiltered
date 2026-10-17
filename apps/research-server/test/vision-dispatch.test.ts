import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const virtual = vi.hoisted(() => ({ files: new Map<string, Buffer>(), load: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: async (p: string) => virtual.files.get(p) ?? Buffer.from(`module:${p}`), stat: async (p: string) => ({ isFile: () => true, mode: 0o600, size: (virtual.files.get(p) ?? Buffer.from(`module:${p}`)).length }), writeFile: async (p: string, data: string, options?: { flag?: string }) => { if (options?.flag === 'wx' && virtual.files.has(p)) throw new Error('EEXIST'); virtual.files.set(p, Buffer.from(data)); } }));
vi.mock('node:process', () => ({ loadEnvFile: virtual.load }));
import { dispatchVision, finalizeVision } from '../scripts/dispatch-vision';
import { candidate, visionEnvelope } from '../scripts/prepare-vision';
import { DO_ENDPOINT, prepareDigitalOceanRequest } from '../../../packages/clinical-core/src/digitalocean';
const directory = '/synthetic/candidate', id = 'DO-V901', root = process.cwd(), preflight = resolve(root, `docs/implementation/evidence/${id}-PREFLIGHT.json`), output = resolve(root, `docs/implementation/evidence/${id}.json`);
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
beforeEach(async () => {
  virtual.files.clear(); virtual.load.mockReset(); vi.stubEnv('DIGITALOCEAN_MODEL_ACCESS_KEY', 'synthetic-unit-secret');
  const video = Buffer.from('synthetic-byte-source'), frame = Buffer.from([255,216,255,192,0,8,8,0,2,0,2,1,255,217]);
  const source = { mediaHash: hash(video), bytes: video.length, imageHash: hash(frame), imageBytes: frame.length, atMs: 1250, offsetMs: 250, segmentStartMs: 1000, segmentEndMs: 2000, geometry: { width: 2, height: 2 } };
  const wire = await prepareDigitalOceanRequest({ endpoint: DO_ENDPOINT, apiKey: 'synthetic', model: candidate.model, timeoutMs: 15_000, maxOutputTokens: 1024, maxRequestBytes: 64_000, responseFormat: 'json' }, visionEnvelope(source.mediaHash, frame).messages);
  for (const [name, bytes] of [['DO-V1-SYNTHETIC.webm', video], ['DO-V1-FRAME.jpg', frame], ['DO-V1-REQUEST.json', wire.body], ['DO-V1-PREFLIGHT.json', JSON.stringify({ id: 'DO-V1-PREFLIGHT', state: 'unreserved-candidate', dispatched: false, providerCalls: 0, limits: candidate, sources: [source], inputHash: hash(wire.body), requestBytes: wire.requestBytes })]] as const) virtual.files.set(`${directory}/${name}`, Buffer.from(bytes));
  virtual.files.set('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md', Buffer.from(`| ${id} / date / root | qwen3.8-max vision | included credits | $0.10; one call;64000 bytes;1024 tokens;15s | pending | pending | $0 | Reserved prospectively |`));
  virtual.files.set('/synthetic/key.env', Buffer.from('synthetic environment fixture'));
  await finalizeVision(directory, id, Date.now() + 60_000, preflight);
});
afterEach(() => vi.unstubAllEnvs());
const valid = { id: 'f1', type: 'tentative-screen', statement: 'At 1250 ms the screen shows "Delivery $5".', supports: ['screen-observation:synthetic-video:1250:1251'], counterevidence: [], limitations: 'Single sampled frame.' };
function response(statement = valid.statement) { return Response.json({ id: 'synthetic-provider-receipt', model: candidate.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ findings: [{ ...valid, statement }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }); }
describe('root-only one-shot vision dispatch with synthetic in-memory authority', () => {
  it('writes exclusive intent before the only exact request, preserves usage and denies repeat/alternate receipts', async () => {
    const fetcher = vi.fn(async (url, init) => { expect(JSON.parse(virtual.files.get(output)!.toString()).calls).toBe(1); expect(String(url)).toBe(`${DO_ENDPOINT}/v1/chat/completions`); expect(JSON.parse(init!.body as string).max_tokens).toBe(1024); return response(); });
    expect((await dispatchVision(preflight, '/synthetic/key.env', output, fetcher)).state).toBe('single-fixture-qualified'); expect(fetcher).toHaveBeenCalledOnce();
    const report = JSON.parse(virtual.files.get(output)!.toString()); expect(report.usage.completion_tokens).toBe(30);
    await expect(dispatchVision(preflight, '/synthetic/key.env', output, fetcher)).rejects.toThrow('EEXIST');
    await expect(dispatchVision(preflight, '/synthetic/key.env', `${output}.other`, fetcher)).rejects.toThrow('Canonical'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('denies stale module fingerprints before credential loading or intent creation', async () => {
    virtual.files.set(resolve(root, 'apps/research-server/src/frames.ts'), Buffer.from('changed module')); const fetcher = vi.fn();
    await expect(dispatchVision(preflight, '/synthetic/key.env', output, fetcher)).rejects.toThrow('implementation changed'); expect(virtual.load).not.toHaveBeenCalled(); expect(virtual.files.has(output)).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains unknown network outcome and never retries', async () => {
    const fetcher = vi.fn(async () => { throw new Error('synthetic-unit-secret'); }); expect((await dispatchVision(preflight, '/synthetic/key.env', output, fetcher)).state).toBe('unknown'); expect(fetcher).toHaveBeenCalledOnce();
    expect(virtual.files.get(output)!.toString()).not.toContain('synthetic-unit-secret');
  });
  it('redacts a credential echoed by a synthetic provider before retaining raw response or findings', async () => {
    const fetcher = vi.fn(async () => response(`${valid.statement} synthetic-unit-secret`)); await dispatchVision(preflight, '/synthetic/key.env', output, fetcher);
    expect(virtual.files.get(output)!.toString()).not.toContain('synthetic-unit-secret'); expect(virtual.files.get(output)!.toString()).toContain('[REDACTED]');
  });
  it('retains a bounded partial response and unknown outcome after output overflow', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(256_001))); expect((await dispatchVision(preflight, '/synthetic/key.env', output, fetcher)).state).toBe('unknown');
    const report = JSON.parse(virtual.files.get(output)!.toString()); expect(report.response.capturedBytes).toBe(256_000); expect(report.response.complete).toBe(false); expect(report.errorCode).toBe('response-too-large'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('retains received bytes/status when response streaming fails before completion', async () => {
    let sent = false; const prefix = '{"id":"partial-response",';
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(prefix)); } else c.error(new Error('synthetic-unit-secret')); } })));
    expect((await dispatchVision(preflight, '/synthetic/key.env', output, fetcher)).state).toBe('unknown');
    const report = JSON.parse(virtual.files.get(output)!.toString()); expect(report.response).toMatchObject({ status: 200, complete: false, capturedBytes: prefix.length, rawText: prefix, sha256: hash(prefix) }); expect(fetcher).toHaveBeenCalledOnce(); expect(report.errorCode).toBe('network'); expect(virtual.files.get(output)!.toString()).not.toContain('synthetic-unit-secret');
  });
});
