import { expect, it } from 'vitest';
import { context } from './fixtures/adaptive.js';
import { createReplyDraftManifest, type ReplyDraft } from '../src/adaptive-reply.js';
import { fullPolicyRevision, policyQualified } from '../src/provisional-projection.js';
import { accountForSource, prepareProvisionalCapture } from '../src/provisional-draft.js';

const left = 'I want more energy', right = 'help managing my weight';
function capture(gap: string, mode: 'distinct' | 'single' | 'rejected' = 'distinct', residual = false, edge?: 'leading' | 'trailing') {
  const ctx = context((edge === 'leading' ? 'and ' : '') + left + gap + right + (edge === 'trailing' ? ' and' : ''), ['Q01']);
  const payload = JSON.parse(String(createReplyDraftManifest(ctx).messages[1].content));
  const address = (quote: string) => ({ statementId: payload.statements.find((s: { text: string }) => s.text.includes(quote)).id, quote });
  const claim = (path: string, quote: string, subject: 'patient' | 'other' = 'patient') => ({
    targetId: payload.targets.find((t: { path: string }) => t.path === path).id, state: 'known' as const, value: quote,
    valueEvidence: address(quote), evidence: [address(quote)], scope: { subject, entity: null, period: null, predicate: address(quote) }, correctsSourceIds: [],
  });
  const claims = [claim('reason', left, mode === 'rejected' ? 'other' : 'patient'), claim('priority', right)];
  if (mode === 'single') { claims.splice(1); claims[0].evidence.push(address(right)); }
  const draft: ReplyDraft = { manifestId: 'a'.repeat(24), claims, acts: [], residual: residual ? [{ evidence: [address(gap.trim())], reason: 'ambiguous' }] : [], sourceDisposition: 'represented' };
  return { ctx, result: prepareProvisionalCapture(ctx, draft) };
}

it('records only an isolated coordinator between two admitted claims as structural audit', () => {
  const { ctx, result } = capture(' and ');
  expect(result.claims).toHaveLength(2);
  expect(result.accounting.remaining).toEqual([]);
  expect(result.accounting.structural).toEqual([{ sourceId: ctx.source.id, start: left.length, end: left.length + 5 }]);
  expect(result.claims.flatMap(c => c.evidence).some(s => ctx.source.text.slice(s.start, s.end).trim() === 'and')).toBe(false);
  expect(result.accounting.semanticReview).toBe('qualification-required');
});

it.each([' or ', ' but ', ' and not ', ' and 500 mg ', ' and sometimes ', ' and my mother ', ' only ', ' and and '])('preserves meaningful uncovered text %s', gap => {
  const { ctx, result } = capture(gap);
  expect(result.accounting.structural).toBeUndefined();
  expect(result.accounting.remaining.map(s => ctx.source.text.slice(s.start, s.end))).toContain(gap);
  expect(result.gaps.some(g => g.reason === 'unaddressed-source')).toBe(false);
  expect(result.accounting.semanticReview).toBe('qualification-required');
});

it.each(['single', 'rejected'] as const)('never closes an and gap using %s claims', mode => {
  const { result } = capture(' and ', mode);
  expect(result.accounting.structural).toBeUndefined();
  expect(result.accounting.remaining.length).toBeGreaterThan(0);
});

it('does not treat duplicated single-claim identity as two represented endpoints', () => {
  const { ctx, result } = capture(' and ', 'single');
  const duplicate = structuredClone(result.claims[0]);
  expect(accountForSource(ctx, result.accounting.addressed, [result.claims[0], duplicate]).structural).toEqual([]);
});

it('does not erase an explicit model ambiguity residual on structural text', () => {
  const { result } = capture(' and ', 'distinct', true);
  expect(result.accounting.structural).toHaveLength(1);
  expect(result.gaps.some(g => g.reason === 'ambiguous')).toBe(true);
});

it.each(['leading', 'trailing'] as const)('preserves %s standalone and as uncovered text', edge => {
  const { ctx, result } = capture(' and ', 'distinct', false, edge);
  expect(result.accounting.remaining.some(s => ctx.source.text.slice(s.start, s.end).trim() === 'and')).toBe(true);
  expect(result.gaps.some(g => g.reason === 'unaddressed-source')).toBe(false);
  expect(result.accounting.semanticReview).toBe('qualification-required');
});

it('does not inherit qualification from the predecessor accounting/projection receipt', () => {
  const current = { ...fullPolicyRevision, status: 'qualified' as const, evidenceDigest: 'a'.repeat(64) };
  expect(policyQualified(current)).toBe(true);
  expect(policyQualified({ ...current, projection: 'merge-source-no-model-stop-v3' } as any)).toBe(false);
});
