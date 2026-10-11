import type { AdaptiveOperationView, AdaptiveTurnResult, ClinicSessionView, SourceSpan } from '../../../packages/clinic-contract/src/index';

export const isPendingInterpretation = (operation?: AdaptiveOperationView) => operation?.status === 'accepted' || operation?.status === 'processing';
export const canQueueNextSource = (operation?: AdaptiveOperationView) => operation?.status === 'processing' && operation.stream?.reply === 'saved' && operation.stream.capture === 'pending';
export const answerBlockedByInterpretation = (operation?: AdaptiveOperationView) => isPendingInterpretation(operation) && !canQueueNextSource(operation);
/** A raw save may rebase only across bookkeeping for the same issued question.
 * New words, answers, identity/phase, operation or prompt must still conflict. */
export function metadataOnlyStreamAdvance(current: ClinicSessionView, next: ClinicSessionView): boolean {
  const operation = current.adaptive?.operation;
  return Boolean(operation && (operation.stream || operation.queuedAfter) && current.id === next.id
    && current.phase === 'conversation' && next.phase === 'conversation' && next.revision >= current.revision
    && next.adaptive?.operation?.id === operation.id && current.adaptive?.mode === next.adaptive.mode
    && JSON.stringify(current.currentPrompt) === JSON.stringify(next.currentPrompt)
    && JSON.stringify(current.turns) === JSON.stringify(next.turns)
    && JSON.stringify(current.notice) === JSON.stringify(next.notice)
    && JSON.stringify(current.adaptive?.reply) === JSON.stringify(next.adaptive?.reply)
    && (current.speechScopeDigest !== undefined || next.speechScopeDigest !== undefined
      ? /^[a-f0-9]{64}$/.test(current.speechScopeDigest ?? '') && current.speechScopeDigest === next.speechScopeDigest
      : JSON.stringify(current.topics) === JSON.stringify(next.topics)));
}
export interface AdaptiveTicket { epoch: number; sessionId: string; operationId: string; revision: number; }

/** Local guard supplements the server CAS: a stopped or superseded response cannot replace the UI. */
export class AdaptiveResponseGuard {
  private epoch = 0;
  private attempted = new Set<string>();
  invalidate() { this.epoch += 1; }
  claimInterpretation(operation: AdaptiveOperationView) {
    if (operation.status !== 'accepted' || operation.queuedWaiting || this.attempted.has(operation.id)) return false;
    this.attempted.add(operation.id); return true;
  }
  hasAttempted(id: string) { return this.attempted.has(id); }
  ticket(session: ClinicSessionView, operationId: string): AdaptiveTicket {
    return { epoch: this.epoch, sessionId: session.id, operationId, revision: session.revision };
  }
  isCurrent(ticket: AdaptiveTicket, current?: ClinicSessionView) {
    return Boolean(current && this.epoch === ticket.epoch && current.id === ticket.sessionId
      && current.phase !== 'identity' && current.phase !== 'confirmed'
      && current.adaptive?.operation?.id === ticket.operationId);
  }
  accepts(ticket: AdaptiveTicket, current: ClinicSessionView | undefined, result: AdaptiveTurnResult) {
    return this.isCurrent(ticket, current) && result.operation.id === ticket.operationId
      && result.session.id === ticket.sessionId && result.session.revision >= ticket.revision
      && result.session.revision >= current!.revision
      && result.session.adaptive?.operation?.id === ticket.operationId;
  }
}

export const sourceTransformLabels: Record<string, string> = {
  'provisional-patient-report': 'Proposed interpretation of these patient words; not independently verified',
  'superseded-patient-report': 'Earlier patient report retained after a source-linked correction',
  'unmapped': 'These words were retained for human review; no structured answer was inferred from this passage.',
  verbatim: 'Copied from the original words',
  'explicit-number': 'Number recorded from the highlighted words',
  'explicit-unit': 'Unit normalized from the highlighted words',
  'explicit-choice': 'Response matched to a defined choice',
  'explicit-height': 'Height structured from the highlighted words',
  'explicit-height-unit': 'Height unit recorded from the highlighted words',
  'scoped-response': 'Response interpreted in the displayed question’s context',
  'source-timestamp': 'Time derived from when this answer was saved',
  'estimate-implies-not-current': 'Patient stated a different current weight, so the reading is not treated as current',
  'explicit-list-completion': 'List completion recorded from the highlighted words',
};

/** Patient-facing wording for the same transforms. Staff keep the clinical labels above. */
export const patientSourceTransformLabels: Record<string, string> = {
  'provisional-patient-report': 'Taken from your words by the AI assistant. Please check it’s right.',
  'superseded-patient-report': 'An earlier answer you later corrected. It stays on record.',
  'unmapped': 'Kept as you wrote it. It wasn’t turned into an answer.',
  verbatim: 'Copied from your words',
  'explicit-number': 'Number taken from the highlighted words',
  'explicit-unit': 'Unit taken from the highlighted words',
  'explicit-choice': 'Matched to one of the answer choices',
  'explicit-height': 'Height taken from the highlighted words',
  'explicit-height-unit': 'Height unit taken from the highlighted words',
  'scoped-response': 'Read as an answer to the question you were asked',
  'source-timestamp': 'Time based on when you sent this message',
  'estimate-implies-not-current': 'You gave a different weight for now, so the older reading isn’t treated as current',
  'explicit-list-completion': 'Your list marked complete from the highlighted words',
};

/** Offsets are JavaScript UTF-16 string indices into the unchanged saved source. */
export function sourceSegments(text: string, sourceId: string, provenance: SourceSpan[] = []) {
  const splitsCharacter = (offset: number) => offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
    && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF;
  const valid = provenance.filter(span => span.sourceId === sourceId && Number.isInteger(span.start)
    && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= text.length
    && !splitsCharacter(span.start) && !splitsCharacter(span.end));
  const boundaries = [...new Set([0, text.length, ...valid.flatMap(span => [span.start, span.end])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return { text: text.slice(start, end), highlighted: valid.some(span => span.start <= start && span.end >= end) };
  });
}
