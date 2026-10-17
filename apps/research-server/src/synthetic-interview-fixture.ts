import { digitalOceanInterview, type InterviewProvider, type InterviewReservation } from './interview';
import type { InferenceMessage } from '../../../packages/clinical-core/src/digitalocean';

export const syntheticGoalAnswer = 'I could not find the delivery cost before confirming checkout.';
export const syntheticGoalQuestion = 'Where did you look for the delivery cost before confirming checkout?';
/** Deterministic wire double only. Uses the real bounded serializer/response parser,
 * never global fetch, a credential, provider retry, or a production fallback. */
export function syntheticGoalInterview(sessionId: string): InterviewProvider {
  if (!sessionId || sessionId.length > 160) throw new Error('Exact synthetic session required');
  const packet = (messages: InferenceMessage[], reservation: InterviewReservation) => {
    if (reservation.model !== 'qwen3.8-max' || reservation.maxInputBytes !== 64_000 || reservation.maxOutputTokens !== 512) throw new Error('Synthetic policy differs from reviewed envelope');
    const text = messages.slice(1).map(m => {
      if (m.role !== 'user' || typeof m.content !== 'string') throw new Error('Synthetic evidence packet unavailable');
      return m.content.replace(/^Study evidence continuation \d+:\n/, '');
    }).join('');
    const p = JSON.parse(text);
    if (p.currentPrompt?.id !== 'q1' || p.currentPrompt?.kind !== 'script' || p.scriptIndex !== 0 || p.savedAnswer?.promptId !== 'q1' || p.savedAnswer?.channel !== 'text' || p.savedAnswer?.intent !== 'answer' || p.savedAnswer?.text !== syntheticGoalAnswer || typeof p.savedAnswer?.sourceId !== 'string' || !p.savedAnswer.sourceId.startsWith(`${sessionId}:`) || p.goals?.length !== 1 || p.goals[0] !== 'Understand whether people can find the delivery cost before confirming checkout.') throw new Error('Not the exact deterministic fixture answer');
    return { decision: 'follow-up', question: syntheticGoalQuestion, goalIndex: 0, sourceId: p.savedAnswer.sourceId as string, quote: 'delivery cost' };
  };
  const adapter = digitalOceanInterview({ endpoint: 'https://inference.do-ai.run', apiKey: 'synthetic-no-network', model: 'qwen3.8-max', timeoutMs: 15_000, maxOutputTokens: 512, maxRequestBytes: 64_000 }, async (url, init) => {
    if (url !== 'https://inference.do-ai.run/v1/chat/completions' || init?.signal?.aborted) throw new Error('Synthetic request unavailable');
    const body = JSON.parse(String(init?.body));
    const proposal = packet(body.messages, { id: 'synthetic-local-response', model: body.model, maxInputBytes: 64_000, maxOutputTokens: body.max_tokens, expiresAt: Date.now() + 15_000 });
    return Response.json({ id: `synthetic-goal-${sessionId}`, model: 'qwen3.8-max', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }] });
  });
  return { model: adapter.model,
    prepare(messages, reservation) { packet(messages, reservation); return adapter.prepare(messages, reservation); },
    generate(messages, reservation, prepared, signal) { packet(messages, reservation); return adapter.generate(messages, reservation, prepared, signal); },
  };
}
