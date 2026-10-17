import { describe, it, expect } from 'vitest';
import { createAdaptiveGroupManifest, issuedAdaptiveGroupManifest } from '../src/adaptive-group-manifest.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { selectAdaptiveGroupDialogue } from '../src/dialogue.js';
import { validateAdaptiveProposalResult, prepareAdaptiveRequest } from '../src/adaptive.js';
import { adaptiveGroupProtocol, adaptiveGroupGuidanceRevision } from '../src/adaptive-group-guidance.js';
import { context, withPrior } from './fixtures/adaptive.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';

const options = { protocol: adaptiveGroupProtocol, guidanceRevision: adaptiveGroupGuidanceRevision };
const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'offline-only', model: 'qwen3.8-max' as const, timeoutMs: 15000, maxOutputTokens: 4096, maxRequestBytes: 60000 };
function packet(ctx: AdaptiveContext) {
  const manifest = createAdaptiveGroupManifest(ctx), segments = issuedAdaptiveGroupManifest(manifest, ctx).segments;
  const address = (quote: string) => {
    const index = segments.findIndex(segment => segment.text.includes(quote) && segment.text.indexOf(quote, segment.text.indexOf(quote) + 1) < 0);
    if (index < 0) throw new Error(`Missing unique quote: ${quote}`);
    return { segment: `s${index}`, quote };
  };
  const answer = (quote: string, support = quote) => ({ state: 'known', value: address(quote), support: [address(support)] });
  const wire = (groups: unknown[], other = {}) => ({ schema: 6, context: manifest.id, groups, completedLists: [], absentLists: [], sharedConcerns: [], acts: [], unmapped: [], ...other });
  return { manifest, address, answer, wire };
}

describe('independent V6 integration boundary, entirely offline', () => {
  it('keeps a later item rejection on its canonical index when the earlier anchor fails', () => {
    const ctx = context('I might take Amlodipine 5 mg. Iron 18 mg. Should I double my dose?', ['Q08']), x = packet(ctx);
    const raw = x.wire([
      { kind: 'Q08.medicines', key: 'uncertain', scope: { mode: 'new', anchor: { role: 'name', answer: x.answer('Amlodipine') } }, fields: [{ role: 'strength', answer: x.answer('5 mg') }], correct: [] },
      { kind: 'Q08.medicines', key: 'iron', scope: { mode: 'new', anchor: { role: 'name', answer: x.answer('Iron') } }, fields: [{ role: 'strength', answer: x.answer('18', 'Iron 18 mg.') }], correct: [] },
    ], { acts: [{ kind: 'question', reply: 'COPY-05', support: [x.address('Should I double my dose?')] }] });
    const groups = validateAdaptiveGroupProposal(raw, ctx, x.manifest), dialogue = selectAdaptiveGroupDialogue(ctx, groups);
    expect(groups.outcome.responses.Q08?.answers.medicines).toMatchObject({ items: [{ answers: { name: { value: 'Iron' } } }] });
    expect(dialogue.reply?.id).toBe('COPY-05');
    expect(dialogue.prompt?.targetPaths).toEqual([expect.stringMatching(/_1\]\.labelDirections$/)]);
    expect(dialogue.prompt?.text).not.toMatch(/strength/i);
    expect(dialogue.state.lastUnsuccessful).toBeUndefined();
  });

  it('keeps genuine conflict alternatives when another role is machine rejected', () => {
    const known = (value: string) => ({ state: 'known' as const, value, sourceIds: ['prior'] });
    const ctx = withPrior(context('Amlodipine 10 mg. No directions.', ['Q08']), 'Q08', { medicines: { state: 'known', complete: true, sourceIds: ['prior'], items: [{ id: 'a', answers: { name: known('Amlodipine'), strength: known('5 mg') } }] } }), x = packet(ctx);
    const raw = x.wire([{ kind: 'Q08.medicines', key: 'change', scope: { mode: 'existing', ref: 'e0', anchor: [x.address('Amlodipine')] }, fields: [
      { role: 'strength', answer: x.answer('10 mg') },
      { role: 'labelDirections', answer: { state: 'negative', value: null, support: [x.address('No directions.')] } },
    ], correct: [] }]);
    const groups = validateAdaptiveGroupProposal(raw, ctx, x.manifest), dialogue = selectAdaptiveGroupDialogue(ctx, groups);
    expect(dialogue.status).toBe('clarification');
    expect(dialogue.clarification).toMatchObject({ path: 'medicines[a].strength', reason: 'conflict', previous: { value: '5 mg' }, proposed: { value: '10 mg' } });
    expect(dialogue.prompt?.targetPaths).toEqual(['medicines[a].strength']);
    expect(dialogue.prompt?.text).not.toMatch(/directions/i);
    expect(() => selectAdaptiveGroupDialogue({ ...ctx, displayed: undefined }, groups)).toThrow('untrusted-group-result');
  });

  it('pins every independent receipt component and keeps a safe reply with all targets blocked', async () => {
    const ctx = context('No reason. No priority. Should I double my dose?', ['Q01']), x = packet(ctx);
    const raw = x.wire([{ kind: 'Q01', key: 'goals', scope: 'patient', fields: ['reason', 'priority'].map(role => ({ role, answer: { state: 'negative', value: null, support: [x.address(role === 'reason' ? 'No reason.' : 'No priority.')] } })), correct: [] }], { acts: [{ kind: 'question', reply: 'COPY-05', support: [x.address('Should I double my dose?')] }] });
    const prepared = await prepareAdaptiveRequest(ctx, config, options);
    const receipt = { requestId: 'offline-independent', model: config.model, evidenceProtocol: adaptiveGroupProtocol, manifest: prepared.manifest, guidance: prepared.guidance, responseSchema: prepared.responseSchema };
    const result = { proposal: raw, rawProposal: raw, receipt };
    const validated = validateAdaptiveProposalResult(ctx, result, options);
    expect(validated.dialogue).toMatchObject({ status: 'interpretation-review', reply: { id: 'COPY-05' } });
    expect(validated.dialogue.prompt).toBeUndefined();
    expect(validated.dialogue.state.lastUnsuccessful).toBeUndefined();
    for (const changed of [
      { ...receipt, evidenceProtocol: 'contextual-values-v5' as any },
      { ...receipt, guidance: { ...receipt.guidance!, instructionSha256: 'wrong' } },
      { ...receipt, responseSchema: { ...receipt.responseSchema!, sha256: 'wrong' } },
    ]) expect(() => validateAdaptiveProposalResult(ctx, { ...result, receipt: changed }, options)).toThrow('group-receipt-mismatch');
  });
});
