import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdaptiveOperationView, ClinicSessionView, SourceSpan, TopicView } from '../../../packages/clinic-contract/src/index';
import { AdaptiveResponseGuard, answerBlockedByInterpretation, canQueueNextSource, metadataOnlyStreamAdvance, sourceSegments } from '../src/adaptive-state';
import { SourceInspector, TopicContent, detailDisplayText } from '../src/components';
import { AdaptiveStatus, UnresolvedSources } from '../src/AdaptiveViews';

const at = '2026-10-09T18:00:00Z';
const op = (status: AdaptiveOperationView['status'] = 'accepted', id = 'op-1'): AdaptiveOperationView => ({ id, requestId: `request-${id}`, sourceId: `source-${id}`, status, acceptedAt: at, updatedAt: at });
const session = (revision = 3, operation = op()): ClinicSessionView => ({
  id: 'session-1', scenario: 'first-intake', title: 'Intake', persona: { displayName: 'Synthetic patient', description: 'Fictional' },
  phase: 'conversation', revision, savedAt: at, completeness: 'partial', topics: [], turns: [],
  adaptive: { mode: 'adaptive', available: true, guidedFallbackAvailable: true, operation },
});
const result = (value: ClinicSessionView) => ({ session: value, operation: value.adaptive!.operation! });

describe('adaptive response races', () => {
  it('rebase proof admits tail bookkeeping but rejects changed words, answers, prompt or operation', () => {
    const current = session(3, { ...op('processing'), stream: { reply: 'saved', capture: 'pending' } });
    current.currentPrompt = { id: 'Q01:Q01', topicId: 'Q01', text: 'What matters to you?', purpose: 'Priorities', mode: 'adaptive' };
    const next = { ...current, revision: 4, adaptive: { ...current.adaptive!, operation: { ...current.adaptive!.operation!, status: 'applied' as const, stream: { reply: 'saved' as const, capture: 'saved' as const } } } };
    expect(metadataOnlyStreamAdvance(current, next)).toBe(true);
    expect(metadataOnlyStreamAdvance(current, { ...next, turns: [{ id: 'new', role: 'patient', text: 'New words', at }] })).toBe(false);
    expect(metadataOnlyStreamAdvance(current, { ...next, currentPrompt: { ...next.currentPrompt!, text: 'Different question' } })).toBe(false);
    expect(metadataOnlyStreamAdvance(current, { ...next, topics: [{ id: 'Q01', title: 'Priority', status: 'ready-for-review', required: true, missingDetails: [] }] })).toBe(false);
    expect(metadataOnlyStreamAdvance(current, session(4, op('accepted', 'queued')))).toBe(false);
  });
  it('retains active capture and finished-save rebasing through a nonempty provisional projection only', () => {
    const current = session(3, { ...op('processing'), stream: { reply: 'saved', capture: 'pending' } });
    current.speechScopeDigest = 'a'.repeat(64);
    current.currentPrompt = { id: 'Q06:Q06c', topicId: 'Q06', text: 'Same issued question', purpose: 'Medical conditions', mode: 'adaptive' };
    const next = { ...current, revision: 4, topics: [{ id: 'Q04', title: 'Height and weight', status: 'more-detail-needed' as const, required: true, missingDetails: ['unit'], details: [{ id: 'height', label: 'Height', text: '5 ft 8 in', state: 'answered' as const, sourceIds: ['original-source'], interpretation: { qualified: false, status: 'proposed' as const } }] }], adaptive: { ...current.adaptive!, operation: { ...current.adaptive!.operation!, status: 'applied' as const, stream: { reply: 'saved' as const, capture: 'saved' as const } } } };
    expect(metadataOnlyStreamAdvance(current, next)).toBe(true);
    for (const changed of [
      { ...next, speechScopeDigest: 'b'.repeat(64) }, // Direct edit despite unchanged prompt.
      { ...next, speechScopeDigest: undefined },
      { ...next, id: 'other-session' },
      { ...next, phase: 'identity' as const },
      { ...next, turns: [{ id: 'new', role: 'patient' as const, text: 'New words', at }] },
      { ...next, currentPrompt: { ...next.currentPrompt!, id: 'other-prompt' } },
      { ...next, adaptive: { ...next.adaptive, operation: op('applied', 'new-op') } },
      { ...next, notice: { tone: 'urgent' as const, text: 'Safety pause' } },
      { ...next, adaptive: { ...next.adaptive, reply: { id: 'new-reply', text: 'Changed reply' } } },
    ]) expect(metadataOnlyStreamAdvance(current, changed)).toBe(false);
  });
  it('lets the saved early question accept exactly one next source while an accepted queue remains blocked from dispatch', () => {
    const predecessor = { ...op('processing'), stream: { reply: 'saved' as const, capture: 'pending' as const } };
    expect(canQueueNextSource(predecessor)).toBe(true);
    expect(answerBlockedByInterpretation(predecessor)).toBe(false);
    const queued = { ...op(), queuedAfter: predecessor.id, queuedWaiting: true };
    const guard = new AdaptiveResponseGuard();
    expect(answerBlockedByInterpretation(queued)).toBe(true);
    expect(guard.claimInterpretation(queued)).toBe(false);
    expect(guard.hasAttempted(queued.id)).toBe(false);
    expect(guard.claimInterpretation({ ...queued, queuedWaiting: false })).toBe(true);
    expect(guard.claimInterpretation({ ...queued, queuedWaiting: false })).toBe(false);
  });
  it('claims one interpretation attempt, and retains that claim after a stop or failed response', () => {
    const guard = new AdaptiveResponseGuard();
    expect(guard.claimInterpretation(op())).toBe(true);
    expect(guard.claimInterpretation(op())).toBe(false);
    guard.invalidate();
    expect(guard.claimInterpretation(op())).toBe(false);
  });
  it.each(['processing', 'applied', 'failed', 'unresolved', 'discarded'] as const)('never starts inference from a %s operation', status => {
    expect(new AdaptiveResponseGuard().claimInterpretation(op(status))).toBe(false);
  });
  it('ignores a late applied result after stop, even when its revision is newer', () => {
    const guard = new AdaptiveResponseGuard(), current = session();
    const ticket = guard.ticket(current, 'op-1');
    guard.invalidate();
    expect(guard.accepts(ticket, current, result(session(5, op('applied'))))).toBe(false);
  });
  it('ignores an older status read after a newer applied result is displayed', () => {
    const guard = new AdaptiveResponseGuard();
    const ticket = guard.ticket(session(), 'op-1');
    expect(guard.accepts(ticket, session(5, op('applied')), result(session(4, op('processing'))))).toBe(false);
  });
  it('accepts the current operation advancing revision for its durable processing claim', () => {
    const guard = new AdaptiveResponseGuard(), current = session();
    expect(guard.accepts(guard.ticket(current, 'op-1'), current, result(session(4, op('processing'))))).toBe(true);
  });
  it('ignores results from an operation superseded by a new answer', () => {
    const guard = new AdaptiveResponseGuard(), ticket = guard.ticket(session(), 'op-1');
    expect(guard.accepts(ticket, session(5, op('accepted', 'op-2')), result(session(6, op('applied'))))).toBe(false);
  });
  it('does not let replay of an older acceptance replace the latest operation', () => {
    const guard = new AdaptiveResponseGuard(), current = session(), replay = result(session(6, op('accepted', 'op-2')));
    replay.operation = op();
    expect(guard.accepts(guard.ticket(current, 'op-1'), current, replay)).toBe(false);
  });
  it.each(['identity', 'confirmed'] as const)('does not reopen conversation after the UI enters %s', phase => {
    const guard = new AdaptiveResponseGuard(), ticket = guard.ticket(session(), 'op-1');
    expect(guard.accepts(ticket, { ...session(), phase }, result(session(5, op('applied'))))).toBe(false);
  });
  it('does not cross patient sessions', () => {
    const guard = new AdaptiveResponseGuard(), ticket = guard.ticket(session(), 'op-1');
    expect(guard.accepts(ticket, { ...session(), id: 'session-2' }, result(session(5, op('applied'))))).toBe(false);
  });
});

describe('original source provenance', () => {
  const text = '🙂  Weight: 180 pounds\nNot weighed today.  ';
  const span = (start: number, end: number, sourceId = 'source-1'): SourceSpan => ({ start, end, sourceId, transform: 'explicit-unit' });
  it('highlights UTF-16 spans without changing whitespace, emoji, or newlines', () => {
    const start = text.indexOf('pounds');
    const segments = sourceSegments(text, 'source-1', [span(start, start + 6)]);
    expect(segments.map(item => item.text).join('')).toBe(text);
    expect(segments.filter(item => item.highlighted).map(item => item.text).join('')).toBe('pounds');
  });
  it('handles overlapping spans without duplicated or omitted source text', () => {
    const segments = sourceSegments(text, 'source-1', [span(4, 20), span(12, 24)]);
    expect(segments.map(item => item.text).join('')).toBe(text);
    expect(segments.filter(item => item.highlighted).map(item => item.text).join('')).toBe(text.slice(4, 24));
  });
  it('ignores foreign sources, invalid bounds, and split surrogate pairs', () => {
    const segments = sourceSegments(text, 'source-1', [span(0, 1), span(1, 2), span(-1, 2), span(0, 999), span(0, 2, 'other'), span(3.5, 7)]);
    expect(segments.map(item => item.text).join('')).toBe(text);
    expect(segments.some(item => item.highlighted)).toBe(false);
  });
  it('renders normalized detail labels beside an unchanged highlighted original source', () => {
    const html = renderToStaticMarkup(createElement(SourceInspector, { title: 'Weight unit', ids: ['source-1'], sources: [{ id: 'source-1', role: 'patient', text: '180 pounds', at }], provenance: [span(4, 10)], onClose: () => {} }));
    expect(html).toContain('180 <mark>pounds</mark>');
    expect(html).toContain('Unit normalized from the highlighted words');
    expect(html).not.toContain('Copied from the original words');
  });
  it('formats only known structured booleans and timestamps, preserving narrative strings', () => {
    const detail = (id: string, text: string): NonNullable<TopicView['details']>[number] => ({ id, text, label: id, state: 'answered', sourceIds: ['source-1'] });
    expect(detailDisplayText(detail('lastMeasuredWeight.representsCurrent', 'false'))).toBe('No');
    expect(detailDisplayText(detail('lastMeasuredWeight.representsCurrent', 'true'))).toBe('Yes');
    expect(detailDisplayText(detail('reason', 'false'))).toBe('false');
    expect(detailDisplayText(detail('currentWeightEstimate.statedAt', at))).not.toBe(at);
    expect(detailDisplayText(detail('currentWeightEstimate.statedAt', 'unknown date'))).toBe('unknown date');
  });
});

describe('recovery and unresolved source UI', () => {
  it('presents unmapped passages as interpreter limitations with source access and no invalid topic editor', () => {
    const topic: TopicView = { id: 'interpretation', title: 'Saved wording needs review', required: false, status: 'stopped-with-gaps', missingDetails: [],
      answer: { state: 'uncertain', text: 'Some wording was not mapped.', sourceIds: ['raw'] },
      interpretationGaps: [{ id: 'op:0', reason: 'unsupported-target', evidence: [{ sourceId: 'raw', start: 0, end: 9 }] }] };
    const html = renderToStaticMarkup(createElement(TopicContent, { topic, onSource() {}, onChange() {} }));
    expect(html).toContain('Interpretation incomplete');
    expect(html).toContain('limitation of the interpreter');
    expect(html).toContain('Inspect retained wording');
    expect(html).toContain('View original answer');
    expect(html).not.toContain('>Not sure<');
    expect(html).not.toContain('Change');
  });

  it('offers stop and guided controls once a reading is slow', () => {
    const html = renderToStaticMarkup(createElement(AdaptiveStatus, { operation: op('processing'), working: true, slow: true, uncertain: false, message: '', canInterpret: false, busy: false, hasDraft: false, onCheck: () => {}, onInterpret: () => {}, onStop: () => {}, onGuided: () => {} }));
    expect(html).toContain('Stop and keep my message as written');
    expect(html).toContain('Stop and switch to set questions');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('Continue this saved answer');
  });
  it('stays quiet during a normal reading and offers a status check only when the result is uncertain', () => {
    const props = { working: true, slow: false, uncertain: false, message: '', canInterpret: false, busy: false, hasDraft: false, onCheck: () => {}, onInterpret: () => {}, onStop: () => {}, onGuided: () => {} };
    expect(renderToStaticMarkup(createElement(AdaptiveStatus, { ...props, operation: op('processing') }))).toBe('');
    const uncertain = renderToStaticMarkup(createElement(AdaptiveStatus, { ...props, working: false, uncertain: true, operation: op('accepted') }));
    expect(uncertain).toContain('Check status');
    expect(uncertain).toContain('Stop and keep my message as written');
    const failed = renderToStaticMarkup(createElement(AdaptiveStatus, { ...props, working: false, operation: op('failed') }));
    expect(failed).toContain('saved as you wrote it');
    expect(failed).toContain('Switch to set questions');
    expect(failed).not.toContain('Stop and keep');
  });
  it('uses plain patient wording for interpreted details without exposing source ids', () => {
    const topic: TopicView = { id: 'Q04', title: 'Height and weight', required: true, status: 'ready-for-review', missingDetails: [],
      details: [{ id: 'weight', label: 'Weight', text: '180 lb', state: 'answered', sourceIds: ['raw-id'], interpretation: { qualified: false, status: 'proposed' } }] };
    const patient = renderToStaticMarkup(createElement(TopicContent, { topic, onSource() {}, audience: 'patient' }));
    expect(patient).toContain('From your message');
    expect(patient).not.toContain('Proposed interpretation');
    const staff = renderToStaticMarkup(createElement(TopicContent, { topic, onSource() {} }));
    expect(staff).toContain('Proposed interpretation of your words');
    const source = renderToStaticMarkup(createElement(SourceInspector, { title: 'Weight', ids: ['raw-id'], sources: [{ id: 'raw-id', role: 'patient', text: 'About 180 lb', at }], provenance: [{ sourceId: 'raw-id', start: 6, end: 12, transform: 'provisional-patient-report' }], onClose: () => {}, audience: 'patient' }));
    expect(source).toContain('<mark>180 lb</mark>');
    expect(source).not.toContain('raw-id</p>');
    expect(source).not.toContain('not independently verified');
  });
  it('keeps historical unresolved sources accessible after a newer operation succeeds', () => {
    const value = session(8, op('applied', 'new'));
    value.adaptive!.unresolvedSources = [{ sourceId: 'earlier-source', reason: 'failed' }];
    value.turns = [{ id: 'earlier-source', role: 'patient', text: '  Original words\nunchanged.  ', at }];
    const html = renderToStaticMarkup(createElement(UnresolvedSources, { session: value, expanded: true }));
    expect(html).toContain('<details open="">');
    expect(html).toContain('  Original words\nunchanged.  ');
  });
});
