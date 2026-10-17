import { expect, it, vi } from 'vitest';
import { createFullReplyManifest, prepareFullCapture } from '../src/adaptive-reply-full.js';
import { createFullCompactManifest, encodeFullCompactDraft, fullCompactStreamProposer, consumeFullCompactStream } from '../src/adaptive-reply-full-compact.js';
import { fullDevelopmentContext, representativeFullDraft } from '../../../scripts/qualification/fixtures/adaptive-full-development.js';
import { conversation } from '../src/conversation.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
const config = { endpoint: 'https://inference.do-ai.run' as const, model: 'qwen3.8-max' as const, apiKey: 'offline-only', timeoutMs: 1000, maxOutputTokens: 4096, maxRequestBytes: 131072 };
function setup() {
  const context = fullDevelopmentContext(), full = createFullReplyManifest(context), advance = { manifestId: full.id, actionId: full.actions[0].id, controls: [], defer: [] }, draft = representativeFullDraft(full);
  const event = (content: string | null, finish: string | null = null) => `data: ${JSON.stringify({ id: 'independent-offline', model: config.model, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
  const response = () => new Response(event(JSON.stringify({ advance, draft: encodeFullCompactDraft(draft) })) + event(null, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  return { context, full, draft, response };
}
it('independently rejects complete context replacement before source A can be dispatched under context B', async () => {
  const { context, full, response } = setup(), other = structuredClone(context);
  other.binding = { ...other.binding, patient: 'Patient/other', sessionId: 'other-session', operationId: 'other-operation' };
  other.source = { ...other.source, id: 'other-source', text: 'I am a different patient with unrelated information.' }; other.sources = [other.source];
  const fetcher = vi.fn<Fetch>().mockResolvedValue(response()), onAdvance = vi.fn();
  await expect(fullCompactStreamProposer(config, { fetcher }).propose(other, full, { onAdvance, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'full-reply-context-manifest-mismatch' });
  expect(fetcher).not.toHaveBeenCalled(); expect(onAdvance).not.toHaveBeenCalled();
  await expect(fullCompactStreamProposer(config, { fetcher }).propose(structuredClone(context), full, { onAdvance, signal: new AbortController().signal })).resolves.toMatchObject({ admission: 'unqualified-provisional' }); expect(fetcher).toHaveBeenCalledOnce();
});
it('rejects changed issued manifest text before dispatch', async () => {
  const { full, response } = setup(), compact = createFullCompactManifest(full), fetcher = vi.fn<Fetch>().mockResolvedValue(response());
  (compact.messages[0] as { content: string }).content += '\nChanged instruction';
  await expect(consumeFullCompactStream(config, compact, { fetcher })).rejects.toMatchObject({ code: 'unissued-or-mutated-full-compact-manifest' }); expect(fetcher).not.toHaveBeenCalled();
});
it('rejects invented composite height before it appears in patient review or handoff preview', async () => {
  const { context, full, draft } = setup(); draft.claims[0].value = { feet: 9, inches: 11 };
  const capture = prepareFullCapture(draft, full);
  expect(capture.claims.some(claim => claim.topicId === 'Q04' && claim.path === 'height.value')).toBe(false);
  expect(capture.gaps.some(gap => gap.reason === 'value-not-in-source')).toBe(true);
  expect(capture.accounting.semanticReview).toBe('qualification-required');
  const patient = { reference: context.binding.patient, displayName: 'Synthetic', description: 'Offline', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
  const content = conversation({ mentalHealth: 'phq4', patients: { 'first-intake': patient } } as ClinicApiConfig), at = context.source.at;
  const stored = { schema: 1, id: context.binding.sessionId, patient: patient.reference, scenario: 'first-intake', revision: 1, createdAt: at, savedAt: at, phase: 'conversation', turns: [context.source], topics: {}, requests: {}, version: 1,
    adaptive: { mode: 'adaptive', operations: { 'independent-op': { id: 'independent-op', requestId: crypto.randomUUID(), sourceId: context.source.id, fingerprint: 'offline', status: 'applied', acceptedAt: at, updatedAt: at, binding: context.binding,
      stream: { protocol: 'durable-provisional-stream-v1', reply: 'withheld', capture: 'saved', targetGenerations: {}, provisional: capture } } } } } as Draft;
  const view = content.view(stored, true, true);
  expect(JSON.stringify(view)).not.toContain('9 ft 11 in');
  expect(view.completeness).toBe('partial');
  const preview = await content.preview(stored);
  expect(preview.confirmation.submission.answers.find(answer => answer.questionId === 'Q04')?.text ?? '').not.toContain('9 ft 11 in');
});
it('preserves honest composite height and exact scalar inch normalization without inventing a unit', () => {
  const { full, draft } = setup();
  expect(prepareFullCapture(draft, full).claims.find(claim => claim.path === 'height.value')).toMatchObject({ value: { feet: 5, inches: 8 }, fidelity: 'literal-supported' });
  draft.claims[0].value = 68;
  expect(prepareFullCapture(draft, full).claims.some(claim => claim.path === 'height.value')).toBe(false);
  const heightUnit = full.targets.find(target => target.topicId === 'Q04' && target.path === 'height.unit')!;
  draft.claims.push({ ...structuredClone(draft.claims[0]), targetId: heightUnit.id, value: 'in', valueEvidence: { ...draft.claims[0].valueEvidence!, quote: 'inches' } });
  expect(prepareFullCapture(draft, full).claims.find(claim => claim.path === 'height.value')).toMatchObject({ value: 68, fidelity: 'literal-supported' });
});
it('one failed request preserves unknown provider execution and cannot invoke a fallback', async () => {
  const { full } = setup(), fetcher = vi.fn<Fetch>().mockImplementation(async () => { throw new Error('synthetic-disconnect'); });
  await expect(consumeFullCompactStream(config, createFullCompactManifest(full), { fetcher })).rejects.toMatchObject({ receipt: { providerExecution: 'unknown', usage: 'unknown' } }); expect(fetcher).toHaveBeenCalledOnce();
});
