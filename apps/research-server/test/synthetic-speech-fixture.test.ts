import { expect, test, vi } from 'vitest';
import { createSyntheticResearchSpeech, syntheticTranscript } from '../src/synthetic-speech-fixture';
import type { ResearchServerConfig } from '../src/config';
const state = vi.hoisted(() => ({ options: undefined as any }));
vi.mock('../src/research-speech', () => ({ createResearchSpeechTransport: (options: unknown) => { state.options = options; return options; } }));
vi.mock('../src/speech-authority', () => ({ convexResearchSpeechAuthority: () => ({ native: true }) }));
vi.mock('../src/speech-ingress', () => ({ createAllocatedResearchSpeechIngress: () => ({ allocated: true }) }));
const config = { deployment: 'http://127.0.0.1:3210', publicOrigin: 'http://127.0.0.1:5174', bindOrigin: 'http://127.0.0.1:8789', gatewaySecret: 'a'.repeat(64) } as ResearchServerConfig;
test('explicit fixture uses only local fixed recognition and MP3 provider ports', async () => {
  createSyntheticResearchSpeech(config, 'allocation-synthetic', new Uint8Array([1, 2, 3]));
  const options = state.options, provider = options.connect(), messages: string[] = [];
  provider.on('message', (bytes: Buffer) => messages.push(bytes.toString())); await Promise.resolve(); expect(provider.readyState).toBe(1);
  provider.send(new Uint8Array([0, 0])); provider.send(new Uint8Array([0, 0]));
  expect(messages).toHaveLength(1); expect(JSON.parse(messages[0]).channel.alternatives[0].transcript).toBe(syntheticTranscript);
  provider.send('{"type":"CloseStream"}'); await Promise.resolve(); expect(provider.readyState).toBe(3);
  const audio = await options.fetcher('provider route deliberately unused'); expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(options.authority).toEqual({ native: true }); expect(options.ingress).toEqual({ allocated: true });
});
test('fixture rejects non-local deployment and interrupted audio without fallback', async () => {
  expect(() => createSyntheticResearchSpeech({ ...config, deployment: 'https://remote.example' } as any, 'allocation-synthetic', new Uint8Array([1]))).toThrow();
  createSyntheticResearchSpeech(config, 'allocation-synthetic', new Uint8Array([1]));
  const abort = new AbortController(); abort.abort(); await expect(state.options.fetcher('', { signal: abort.signal })).rejects.toThrow();
});
