import { z } from 'zod';
import { prepareDigitalOceanRequest, type DigitalOceanConfig, type InferenceMessage, type ResponseSchemaReceipt } from './digitalocean.js';
import type { Fetch } from './transport.js';
import { requestSse, StreamTransportError, type SseOptions } from './streaming-transport.js';
import { describeRejectedStreamChunk, type StreamChunkDiagnostic } from './stream-chunk-diagnostics.js';
const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).passthrough();
const chunkSchema = z.object({
  id: z.string().min(1).max(256), model: z.string().min(1).max(256),
  choices: z.array(z.object({ index: z.literal(0), delta: z.object({ role: z.literal('assistant').optional(), content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), refusal: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).nullable().optional(), function_call: z.unknown().optional() }).strict(), finish_reason: z.string().nullable() }).passthrough()).max(1),
  usage: usageSchema.nullable().optional(),
}).passthrough();
export interface DigitalOceanStreamReceipt {
  requestId?: string; model: DigitalOceanConfig['model']; requestBytes: number; responseSchema?: ResponseSchemaReceipt;
  outcome: 'complete' | 'unknown' | 'rejected'; providerExecution: 'completed' | 'unknown'; usage: z.infer<typeof usageSchema> | 'unknown'; finishReason?: string;
  timings: { dispatchMs: number; headersMs?: number; firstContentMs?: number; terminalMs?: number };
  contentBytes: number;
  wireBytes?: number; eventCount?: number; reasoningBytes?: number;
  limits?: { wireBytes: number; eventCount: number; eventBytes: number; contentBytes: number; reasoningBytes: number };
  cleanup?: Parameters<NonNullable<SseOptions['onCleanup']>>[0];
}
export class DigitalOceanStreamFailure extends Error {
  constructor(readonly code: string, readonly receipt: DigitalOceanStreamReceipt) { super(code); this.name = 'DigitalOceanStreamFailure'; }
}
/** Separate opt-in request; the existing nonstream serializer and adapter remain byte-identical. */
export async function prepareDigitalOceanStreamRequest(config: DigitalOceanConfig, messages: InferenceMessage[]) {
  const prepared = await prepareDigitalOceanRequest(config, messages);
  const body = JSON.stringify({ ...JSON.parse(prepared.body), stream: true, stream_options: { include_usage: true } });
  const requestBytes = new TextEncoder().encode(body).byteLength;
  if (requestBytes > (config.maxRequestBytes ?? 1000000)) throw new StreamTransportError('inference-input-too-large');
  return { body, requestBytes, ...(prepared.responseSchema ? { responseSchema: prepared.responseSchema } : {}) };
}
export interface DigitalOceanStreamLimits { maxWireBytes: number; maxEvents: number; maxReasoningBytes: number }
/** Full-only candidate: 512 framing bytes per output token/event, separate
 * bounded content/reasoning allowances and eight role/terminal events. This is
 * an explicit tested allowance, not a guarantee about a provider's framing. */
export function fullStreamLimits(outputTokens: number): DigitalOceanStreamLimits {
  if (!Number.isInteger(outputTokens) || outputTokens < 1 || outputTokens > 4096) throw new StreamTransportError('invalid-stream-limits');
  return { maxWireBytes: (outputTokens + 8) * 512 + 128000 + 128000, maxEvents: outputTokens + 8, maxReasoningBytes: 128000 };
}
export function digitalOceanStream(config: DigitalOceanConfig, fetcher: Fetch = fetch, now: () => number = () => performance.now(), limits?: DigitalOceanStreamLimits) {
  return { async generate(messages: InferenceMessage[], options: { signal?: AbortSignal; onContent: (text: string) => void | Promise<void>; onHeaders?: () => void; onInvalidChunk?: (diagnostic: StreamChunkDiagnostic) => void | Promise<void> } ) {
    const prepared = await prepareDigitalOceanStreamRequest(config, messages);
    const bounds = { wireBytes: limits?.maxWireBytes ?? 256000, eventCount: limits?.maxEvents ?? 4096, eventBytes: 64000, contentBytes: 128000, reasoningBytes: limits?.maxReasoningBytes ?? 256000 };
    if (!Number.isInteger(bounds.reasoningBytes) || bounds.reasoningBytes < 1 || bounds.reasoningBytes > 256000) throw new StreamTransportError('invalid-stream-limits');
    const receipt: DigitalOceanStreamReceipt = { model: config.model, requestBytes: prepared.requestBytes, responseSchema: prepared.responseSchema, outcome: 'unknown', providerExecution: 'unknown', usage: 'unknown', timings: { dispatchMs: now() }, contentBytes: 0, wireBytes: 0, eventCount: 0, reasoningBytes: 0, limits: bounds };
    const deadline = Date.now() + config.timeoutMs;
    const boundedContent = async (content: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let remove = () => {};
      const stopped = new Promise<never>((_, reject) => {
        const cancel = () => reject(new StreamTransportError('stream-cancelled'));
        remove = () => options.signal?.removeEventListener('abort', cancel);
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) cancel();
        timer = setTimeout(() => reject(new StreamTransportError('stream-consumer-timeout')), Math.max(0, deadline - Date.now()));
      });
      try { await Promise.race([Promise.resolve().then(() => options.onContent(content)), stopped]); }
      finally { if (timer) clearTimeout(timer); remove(); }
    };
    let text = '', stopped = false, done = false, usageSeen = false;
    let consumedEvent = 0, schemaValidChunks = 0;
    const fail = (code: string): never => { throw new StreamTransportError(code); };
    try {
      for await (const data of requestSse(fetcher, `${config.endpoint}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: prepared.body,
      }, { timeoutMs: config.timeoutMs, maxBytes: bounds.wireBytes, maxEvents: bounds.eventCount, signal: options.signal, onProgress: counts => Object.assign(receipt,counts), onHeaders: () => { receipt.timings.headersMs = now(); options.onHeaders?.(); }, onCleanup: state => { receipt.cleanup = state; } })) {
        consumedEvent++;
        if (done) fail('stream-data-after-done');
        if (data === '[DONE]') { if (!stopped || !text) fail('stream-premature-done'); done = true; receipt.providerExecution = 'completed'; receipt.timings.terminalMs = now(); continue; }
        let json: unknown; try { json = JSON.parse(data); } catch { fail('invalid-stream-json'); }
        const parsed = chunkSchema.safeParse(json);
        if (!parsed.success) {
          if (options.onInvalidChunk) {
            // Opt-in observability never changes validation or waits for an observer.
            try {
              const diagnostic = describeRejectedStreamChunk(json, parsed.error.issues,
                { consumedEvent, schemaValidChunksBefore: schemaValidChunks, stopSeen: stopped });
              void Promise.resolve(options.onInvalidChunk(diagnostic)).catch(() => undefined);
            } catch { /* preserve the original fail-closed result */ }
          }
          fail('invalid-stream-chunk');
        }
        schemaValidChunks++;
        const chunk = parsed.data!;
        if (chunk.model !== config.model) fail('inference-model-mismatch');
        if (receipt.requestId && receipt.requestId !== chunk.id) fail('inference-request-id-mismatch');
        receipt.requestId = chunk.id;
        if (chunk.usage) {
          if (usageSeen || !stopped || chunk.choices.length || chunk.usage.total_tokens !== chunk.usage.prompt_tokens + chunk.usage.completion_tokens) fail('invalid-stream-usage');
          usageSeen = true; receipt.usage = chunk.usage;
        }
        if (!chunk.choices.length && !chunk.usage) fail('empty-stream-chunk');
        for (const choice of chunk.choices) {
          if (choice.delta.refusal || choice.delta.tool_calls?.length || choice.delta.function_call !== undefined && choice.delta.function_call !== null) fail('unrequested-stream-tool-or-refusal');
          const content = choice.delta.content ?? '';
          receipt.reasoningBytes! += new TextEncoder().encode(choice.delta.reasoning_content ?? '').byteLength;
          if (receipt.reasoningBytes! > bounds.reasoningBytes) fail('stream-reasoning-too-large');
          if (stopped) fail('stream-choice-after-stop');
          if (content) {
            if (receipt.timings.firstContentMs === undefined) receipt.timings.firstContentMs = now();
            receipt.contentBytes += new TextEncoder().encode(content).byteLength;
            if (receipt.contentBytes > 128000) fail('stream-content-too-large');
            text += content;
            // The callback validates closed local packets; raw deltas are never patient-facing.
            await boundedContent(content);
          }
          if (choice.finish_reason !== null) {
            receipt.finishReason = choice.finish_reason;
            if (choice.finish_reason !== 'stop') fail('inference-incomplete-output');
            stopped = true;
          }
        }
      }
      if (!done) fail('stream-missing-done');
      receipt.outcome = 'complete';
      return { text, receipt };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'stream-consumer-rejected';
      receipt.outcome = ['stream-timeout', 'stream-consumer-timeout', 'stream-cancelled', 'stream-network', 'stream-invalid-utf8-or-network', 'stream-missing-done', 'stream-truncated-event'].includes(code) ? 'unknown' : 'rejected';
      throw new DigitalOceanStreamFailure(code, receipt);
    }
  } };
}
