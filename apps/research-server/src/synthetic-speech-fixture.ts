import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { createResearchSpeechTransport } from './research-speech';
import { convexResearchSpeechAuthority } from './speech-authority';
import { createAllocatedResearchSpeechIngress } from './speech-ingress';
import type { ResearchServerConfig } from './config';

export const syntheticTranscript = 'I expected an email receipt';
/** Opt-in loopback fixture: authority, quota and transport are real; provider ports
 * produce fixed synthetic data locally. Never falls through to network providers. */
export function createSyntheticResearchSpeech(config: ResearchServerConfig, allocationId: string, mp3: Uint8Array) {
  if (config.deployment !== 'http://127.0.0.1:3210' || config.publicOrigin !== 'http://127.0.0.1:5174' || !mp3.length || mp3.length > 16_384) throw new Error('Bounded local synthetic voice fixture required');
  class SyntheticRecognizer extends EventEmitter {
    readyState = 0; bufferedAmount = 0; private recognized = false;
    constructor() { super(); queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open'); } }); }
    send(value: string | Uint8Array) {
      if (this.readyState !== 1) throw new Error('Synthetic recognizer is closed');
      if (typeof value !== 'string' && !this.recognized) {
        this.recognized = true;
        this.emit('message', Buffer.from(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: syntheticTranscript }] }, start: 0, duration: 1, is_final: true, speech_final: true })), false);
      }
      if (value === '{"type":"CloseStream"}') this.close();
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', 1000)); }
    terminate() { this.close(); }
  }
  return createResearchSpeechTransport({
    enabled: true, origin: config.publicOrigin, listenerHost: new URL(config.bindOrigin).host,
    authority: convexResearchSpeechAuthority(config.deployment, config.gatewaySecret),
    ingress: createAllocatedResearchSpeechIngress({ ...config, allocationId }),
    deepgramApiKey: 'synthetic-no-network', elevenlabsApiKey: 'synthetic-no-network',
    connect: () => new SyntheticRecognizer() as unknown as WebSocket,
    fetcher: async (_input, init) => {
      if (init?.signal?.aborted) throw new Error('Synthetic output interrupted');
      return new Response(mp3.slice(), { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(mp3.length) } });
    },
  });
}
