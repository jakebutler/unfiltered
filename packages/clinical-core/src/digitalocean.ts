import { z } from 'zod';
import { ClinicalError } from './domain.js';
import { requestJson, type Fetch } from './transport.js';

export const DO_ENDPOINT = 'https://inference.do-ai.run';
export const DO_MODELS = ['glm-5.3-flash', 'qwen3.8-max'] as const;
const configSchema = z.object({
  endpoint: z.literal(DO_ENDPOINT), apiKey: z.string().min(1).max(4096), model: z.enum(DO_MODELS),
  timeoutMs: z.number().int().min(100).max(60000), maxOutputTokens: z.number().int().min(1).max(4096),
  responseFormat: z.enum(['text', 'json']).optional(),
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
export function digitalOcean(config: DigitalOceanConfig, fetcher: Fetch = fetch) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success || !parsed.data.apiKey.trim()) throw new ClinicalError('invalid-inference-configuration');
  const c = parsed.data;
  return {
    async generate(messages: InferenceMessage[]) {
      const parsedMessages = inputSchema.safeParse(messages);
      if (!parsedMessages.success) throw new ClinicalError('invalid-inference-input');
      const body = JSON.stringify({ model: c.model, messages: parsedMessages.data, max_tokens: c.maxOutputTokens, stream: false, ...(c.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}) });
      if (new TextEncoder().encode(body).byteLength > 1_000_000) throw new ClinicalError('inference-input-too-large');
      const result = await requestJson(fetcher, `${c.endpoint}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' }, body }, c.timeoutMs, 256000);
      const data = responseSchema.safeParse(result.body);
      if (!data.success) throw new ClinicalError('invalid-inference-response');
      if (data.data.model !== c.model) throw new ClinicalError('inference-model-mismatch');
      if (data.data.choices[0].finish_reason !== 'stop') throw new ClinicalError('inference-incomplete-output');
      return { requestId: data.data.id, model: data.data.model, text: data.data.choices[0].message.content, usage: data.data.usage };
    },
  };
}
