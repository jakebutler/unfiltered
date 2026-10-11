import { z } from 'zod';
import { ClinicalError } from './domain.js';
import { requestJson, type Fetch } from './transport.js';

export const DO_ENDPOINT = 'https://inference.do-ai.run';
export const DO_MODELS = ['glm-5.3-flash', 'glm-5.3', 'qwen3.8-max', 'kimi-k3', 'deepseek-v4.1-flash'] as const;
const configSchema = z.object({
  endpoint: z.literal(DO_ENDPOINT), apiKey: z.string().min(1).max(4096), model: z.enum(DO_MODELS),
  timeoutMs: z.number().int().min(100).max(60000), maxOutputTokens: z.number().int().min(1).max(4096),
  responseFormat: z.union([z.enum(['text', 'json']), z.object({
    type: z.literal('json-schema'), name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), schema: z.record(z.unknown()),
  }).strict()]).optional(),
  maxRequestBytes: z.number().int().min(1).max(1_000_000).optional(),
}).strict();
export type DigitalOceanConfig = z.infer<typeof configSchema>;
const messageSchema = z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.union([
  z.string().min(1).max(32000),
  z.array(z.union([
    z.object({ type: z.literal('text'), text: z.string().min(1).max(16000) }).strict(),
    // Only bounded supplied image data; this adapter does not fetch arbitrary URLs.
    z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/).max(500000) }).strict() }).strict(),
  ])).min(1).max(4),
]) }).strict();
const inputSchema = z.array(messageSchema).min(1).max(40);
export type InferenceMessage = z.infer<typeof messageSchema>;
const responseSchema = z.object({ id: z.string(), model: z.string(), choices: z.array(z.object({ finish_reason: z.string().nullable(), message: z.object({ content: z.string().min(1) }) })).min(1), usage: z.object({ prompt_tokens: z.number().nonnegative(), completion_tokens: z.number().nonnegative(), total_tokens: z.number().nonnegative() }).optional() });
export interface ResponseSchemaReceipt { name: string; sha256: string; }
/** Bounded metadata only. Provider text, headers, URLs and errors never cross this observer. */
export interface FailedInferenceMetadata {
  finishReason: 'length' | 'content_filter' | 'tool_calls' | 'function_call' | 'null' | 'other';
  choiceCount: number;
  contentCharacters: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}
export function failedInferenceMetadata(response: z.infer<typeof responseSchema>): FailedInferenceMetadata {
  const reason = response.choices[0].finish_reason;
  const usage = response.usage;
  return {
    finishReason: reason === null ? 'null' : ['length', 'content_filter', 'tool_calls', 'function_call'].includes(reason) ? reason as FailedInferenceMetadata['finishReason'] : 'other',
    choiceCount: Math.min(response.choices.length, 256000),
    contentCharacters: Math.min(response.choices[0].message.content.length, 256000),
    ...(usage && Object.values(usage).every(value => Number.isSafeInteger(value) && value <= 100_000_000) ? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } } : {}),
  };
}

/** Exact serialized request accounting, including the requested native schema, before dispatch. No credentials returned. */
export async function prepareDigitalOceanRequest(config: DigitalOceanConfig, messages: InferenceMessage[]) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success || !parsed.data.apiKey.trim()) throw new ClinicalError('invalid-inference-configuration');
  const c = parsed.data, parsedMessages = inputSchema.safeParse(messages);
  if (!parsedMessages.success) throw new ClinicalError('invalid-inference-input');
  let responseSchema: ResponseSchemaReceipt | undefined;
  if (typeof c.responseFormat === 'object') {
    let schemaText: string;
    try { schemaText = JSON.stringify(c.responseFormat.schema); } catch { throw new ClinicalError('invalid-inference-schema'); }
    if (c.responseFormat.schema.type !== 'object' || new TextEncoder().encode(schemaText).length > 32000) throw new ClinicalError('invalid-inference-schema');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(schemaText));
    responseSchema = { name: c.responseFormat.name, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
  }
  const format = typeof c.responseFormat === 'object' ? { type: 'json_schema', json_schema: { name: c.responseFormat.name, strict: true, schema: c.responseFormat.schema } }
    : c.responseFormat === 'json' ? { type: 'json_object' } : undefined;
  // Finite alternative-model compatibility settings; provider support is
  // observed by the explicit probe, never assumed from successful serialization.
  // GLM-5.3 always reasons; DO's documented Chat Completions field is reasoning_effort.
  // Existing Qwen/GLM Flash and Kimi wire defaults remain exact.
  const tokenControls = c.model === 'kimi-k3'
    ? { max_completion_tokens: c.maxOutputTokens, reasoning_effort: 'low' }
    : c.model === 'deepseek-v4.1-flash' || c.model === 'glm-5.3'
      ? { max_tokens: c.maxOutputTokens, reasoning_effort: 'low' }
      : { max_tokens: c.maxOutputTokens };
  const body = JSON.stringify({ model: c.model, messages: parsedMessages.data, ...tokenControls, stream: false, ...(format ? { response_format: format } : {}) });
  const requestBytes = new TextEncoder().encode(body).byteLength;
  if (requestBytes > (c.maxRequestBytes ?? 1_000_000)) throw new ClinicalError('inference-input-too-large');
  return { body, requestBytes, ...(responseSchema ? { responseSchema } : {}) };
}
export function digitalOcean(config: DigitalOceanConfig, fetcher: Fetch = fetch, onFailedResponse?: (metadata: FailedInferenceMetadata) => void) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success || !parsed.data.apiKey.trim()) throw new ClinicalError('invalid-inference-configuration');
  const c = parsed.data;
  return {
    async generate(messages: InferenceMessage[]) {
      const { body, requestBytes, responseSchema: schemaReceipt } = await prepareDigitalOceanRequest(c, messages);
      const result = await requestJson(fetcher, `${c.endpoint}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' }, body }, c.timeoutMs, 256000);
      const data = responseSchema.safeParse(result.body);
      if (!data.success) throw new ClinicalError('invalid-inference-response');
      if (data.data.model !== c.model) throw new ClinicalError('inference-model-mismatch');
      if (data.data.choices[0].finish_reason !== 'stop') {
        // Observability cannot change failure semantics or cause a retry.
        try { onFailedResponse?.(failedInferenceMetadata(data.data)); } catch { /* retain original failure */ }
        throw new ClinicalError('inference-incomplete-output');
      }
      return { requestId: data.data.id, model: data.data.model, text: data.data.choices[0].message.content, usage: data.data.usage, requestBytes, ...(schemaReceipt ? { responseSchema: schemaReceipt } : {}) };
    },
  };
}
