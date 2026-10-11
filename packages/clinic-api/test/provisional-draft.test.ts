import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { context } from './fixtures/adaptive.js';
import { createReplyDraftManifest, type ReplyDraft } from '../src/adaptive-reply.js';
import { prepareProvisionalCapture, provisionalResponses } from '../src/provisional-draft.js';
import { selectUsefulAdvance, type IssuedReplyAction } from '../src/reply-usefulness.js';
const text = "I'm five feet eight inches. The scale read 230 pounds on August 12. I'm not sure whether that still reflects my weight; I estimate 235 pounds now.";
function recorded() {
  const ctx = context(text, ['Q04', 'Q05']); ctx.source.id = 'development-g1';
  const manifest = createReplyDraftManifest(ctx), payload = JSON.parse(String(manifest.messages[1].content));
  const receipt = JSON.parse(readFileSync(new URL('../../../docs/implementation/evidence/DO-AS2.json', import.meta.url), 'utf8'));
  return { ctx, payload, draft: receipt.draft as ReplyDraft, advance: receipt.advances[0].packet };
}
it('normalizes retained AS2 strings and explicit uncertainty without admitting the unsupported datePrecision proposal', () => {
  const { ctx, draft } = recorded(), capture = prepareProvisionalCapture(ctx, draft);
  expect(capture.claims).toHaveLength(8);
  expect(capture.claims.find(claim => claim.path === 'height.value')!.value).toEqual({ feet: 5, inches: 8 });
  expect(capture.claims.find(claim => claim.path === 'lastMeasuredWeight.value')!.value).toBe(230);
  expect(capture.claims.find(claim => claim.path === 'currentWeightEstimate.value')!.value).toBe(235);
  expect(capture.claims.find(claim => claim.path === 'lastMeasuredWeight.measuredWhen')!.value).toBe('August 12');
  expect(capture.claims.find(claim => claim.path === 'lastMeasuredWeight.representsCurrent')!.state).toBe('uncertain');
  expect(capture.claims.some(claim => claim.path === 'lastMeasuredWeight.datePrecision')).toBe(false);
  expect(capture.gaps.some(gap => gap.targetId === 'Q04-5')).toBe(true);
  expect(capture.accounting.semanticReview).toBe('qualification-required');
  expect(() => provisionalResponses({}, [capture], undefined as any)).toThrow('provisional-policy-unqualified');
});
it('rejects cropped calendar day12 and wrong literal/unit without truth-laundering them through review projection', () => {
  const { ctx, draft } = recorded(), wrong = structuredClone(draft);
  wrong.claims.find(claim => claim.targetId === 'Q04-4')!.value = '12';
  wrong.claims.find(claim => claim.targetId === 'Q04-2')!.value = '23';
  wrong.claims.find(claim => claim.targetId === 'Q04-3')!.value = 'kg';
  const capture = prepareProvisionalCapture(ctx, wrong);
  expect(capture.gaps.map(gap => gap.reason)).toEqual(expect.arrayContaining(['temporal-crop', 'value-not-in-source']));
  const projected = provisionalResponses({}, [capture], { policy: 'provisional-context-v1', status: 'qualified' });
  expect(projected.Q04!.answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
  expect(projected.Q04!.answers['lastMeasuredWeight.value']).toBeUndefined();
  expect(projected.Q04!.answers['lastMeasuredWeight.unit']).toBeUndefined();
});
it('retains typed model interpretation of word numbers and paraphrase as provisional fidelity, without literal-only admission', () => {
  const ctx = context('The reading was two hundred thirty pounds. I had a sore knee for three weeks.', ['Q04', 'Q02']);
  const payload = JSON.parse(String(createReplyDraftManifest(ctx).messages[1].content));
  const target = payload.targets.find((target: { path: string }) => target.path === 'lastMeasuredWeight.value');
  const address = { statementId: payload.statements[0].id, quote: payload.statements[0].text };
  const draft: ReplyDraft = { manifestId: 'a'.repeat(24), claims: [{ targetId: target.id, state: 'known', value: 230, valueEvidence: address, evidence: [address], scope: { subject: 'patient', entity: 'measured-weight', period: null, predicate: address }, correctsSourceIds: [] }], acts: [], residual: [], sourceDisposition: 'represented' };
  const capture = prepareProvisionalCapture(ctx, draft);
  expect(capture.claims[0]).toMatchObject({ value: 230, fidelity: 'model-interpreted', attribution: 'proposed-patient-report' });
  expect(capture.accounting.remaining).not.toHaveLength(0); // volunteered knee remains visible
});
it('direct correction wins over proposed value in qualified projection', () => {
  const { ctx, draft } = recorded(), capture = prepareProvisionalCapture(ctx, draft);
  const direct = { Q04: { presented: true, answers: { 'lastMeasuredWeight.value': { state: 'known' as const, value: 240, sourceIds: ['patient-correction'] } } } };
  const result = provisionalResponses(direct, [capture], { policy: 'provisional-context-v1', status: 'qualified' });
  expect(result.Q04!.answers['lastMeasuredWeight.value']).toEqual(direct.Q04.answers['lastMeasuredWeight.value']);
});
it('retains natural unknown/refusal phrasing as provisional interpretation while rejecting clinician-owned uncertainty', () => {
  const { ctx, draft } = recorded();
  const unknown = structuredClone(draft); unknown.claims = [unknown.claims.find(claim => claim.targetId === 'Q04-7')!]; unknown.acts = []; unknown.residual = [];
  const original = unknown.claims[0].scope.predicate.quote;
  const replace = (before: string, phrase: string) => {
    ctx.source.text = ctx.source.text.replace(before, phrase);
    const payload = JSON.parse(String(createReplyDraftManifest(ctx).messages[1].content));
    const predicate = { statementId: payload.statements.find((statement: { text: string }) => statement.text.includes(phrase)).id, quote: phrase };
    unknown.claims[0].scope.predicate = predicate; unknown.claims[0].evidence = [predicate];
  };
  replace(original, 'Whether that is current escapes me');
  const capture = prepareProvisionalCapture(ctx, unknown);
  expect(capture.claims[0]).toMatchObject({ state: 'unknown', fidelity: 'model-interpreted' });
  replace('Whether that is current escapes me', 'My doctor does not know whether it is current');
  const rejected = prepareProvisionalCapture(ctx, unknown);
  expect(rejected.claims).toEqual([]); expect(rejected.gaps[0].reason).toBe('ownership');
});
it('known AS2 advancea3 is rejected as repeated supplied uncertainty and replaced only by an issued next-topic question', () => {
  const { ctx, payload, advance } = recorded();
  const result = selectUsefulAdvance(ctx, advance, payload.actions as IssuedReplyAction[]);
  expect(result).toMatchObject({ nominatedActionId: 'a3', rejectedNomination: 'supplied-uncertainty', action: { topicId: 'Q05' } });
  expect(result!.action.promptId).not.toBe('Q04b');
});
it('mixed medication uncertainty does not incorrectly suppress a separate measured-weight recency action', () => {
  const { ctx, payload, advance } = recorded(); ctx.source.text = 'I am unsure about my medicines, but my current weight was measured yesterday.';
  expect(selectUsefulAdvance(ctx, advance, payload.actions as IssuedReplyAction[])).toMatchObject({ action: { id: 'a3' } });
});
it('supplied refusal and source-bound move-on cannot select another question from the stopped topic', () => {
  const { ctx, payload, advance } = recorded(); ctx.source.text = 'I would rather not discuss this now.';
  expect(selectUsefulAdvance(ctx, advance, payload.actions as IssuedReplyAction[])).toMatchObject({ rejectedNomination: 'supplied-refusal', action: { topicId: 'Q05' } });
  expect(selectUsefulAdvance(ctx, { ...advance, controls: [{ kind: 'move-on', targetTopicId: 'Q04', replyId: null, evidence: [] }] }, payload.actions as IssuedReplyAction[])).toMatchObject({ rejectedNomination: 'supplied-refusal', action: { topicId: 'Q05' } });
});
