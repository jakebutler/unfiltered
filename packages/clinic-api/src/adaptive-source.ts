import { createHash } from 'node:crypto';
import { AdaptiveError, type AdaptiveContext, type EvidenceSpan } from './adaptive-validation.js';

export const segmentedEvidenceProtocol = 'current-source-quote-v4' as const;
export interface SourceSegment { readonly id: string; readonly kind: 'sentence' | 'literal'; readonly start: number; readonly end: number; readonly text: string; }
const issued = new WeakMap<readonly SourceSegment[], string>();
export const currentSourceStatementId = (context: AdaptiveContext) => `current_${createHash('sha256').update(snapshot(context)).digest('hex').slice(0,24)}`;
const snapshot = (context: AdaptiveContext) => JSON.stringify([context.source.id, context.source.at, context.source.text]);

/** Addressing aids only. The complete immutable source remains the semantic validator's context. */
export function adaptiveSourceSegments(context: AdaptiveContext): readonly SourceSegment[] {
  const source = context.source, matching = context.sources.filter(candidate => candidate.id === source.id);
  if (source.role !== 'patient' || !/^[A-Za-z0-9_-]{1,64}$/.test(source.id) || !source.text.trim() || source.text.length > 8000
    || matching.length !== 1 || matching[0].role !== source.role || matching[0].text !== source.text || matching[0].at !== source.at) throw new AdaptiveError('invalid-adaptive-source');
  const signature = snapshot(context), digest = createHash('sha256').update(signature).digest('hex').slice(0, 24);
  const segments: SourceSegment[] = [];
  const append = (kind: SourceSegment['kind'], start: number, end: number) => {
    segments.push(Object.freeze({ id: `s${digest}_${segments.length}`, kind, start, end, text: source.text.slice(start, end) }));
  };
  // Preserve all bytes, whitespace and punctuation. Decimals and common titles/initials are not sentence boundaries.
  const ends = [...source.text.matchAll(/[.!?](?=\s|$)|\r?\n/g)].filter(match => {
    if (match[0] !== '.') return true;
    return !/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|[A-Z])$/i.test(source.text.slice(0, match.index));
  }).map(match => match.index! + match[0].length);
  if (ends.at(-1) !== source.text.length) ends.push(source.text.length);
  const step = Math.max(1, Math.ceil(ends.length / 64));
  let start = 0;
  for (let i = step - 1; i < ends.length + step - 1; i += step) {
    const end = ends[Math.min(i, ends.length - 1)];
    if (end > start) append('sentence', start, end);
    start = end;
  }
  // Lexical numeric/unit spans avoid occurrence arithmetic within a sentence. No values are inferred or normalized.
  const literals = [...source.text.matchAll(/\b(?:\d+(?:\.\d+)?|pounds?|lbs?|kilograms?|kg|stones?|st|centimet(?:er|re)s?|cm|met(?:er|re)s?|m|inches|inch|in|feet|foot|ft)\b/gi)];
  if (literals.length > 192) throw new AdaptiveError('source-segment-limit');
  for (const match of literals) append('literal', match.index!, match.index! + match[0].length);
  issued.set(segments, signature);
  return Object.freeze(segments);
}

export function resolveSegmentQuote(context: AdaptiveContext, segments: readonly SourceSegment[], evidence: { segmentId: string; quote: string; anchor?: string }): EvidenceSpan {
  if (issued.get(segments) !== snapshot(context)) throw new AdaptiveError('invalid-source-segment');
  if (evidence.anchor !== undefined) {
    if (context.sourceQuoteProtocol !== 'unique-anchor-v1' || evidence.segmentId !== currentSourceStatementId(context)) throw new AdaptiveError('unissued-source-anchor-protocol');
    return resolveAnchoredCurrentQuote(context, evidence.anchor, evidence.quote);
  }
  const segment = evidence.segmentId === currentSourceStatementId(context)
    ? { start: 0, text: context.source.text }
    : segments.find(candidate => candidate.id === evidence.segmentId);
  if (!segment || !evidence.quote.trim()) throw new AdaptiveError('invalid-source-segment');
  const position = segment.text.indexOf(evidence.quote);
  if (position < 0) throw new AdaptiveError('source-quote-not-found');
  if (segment.text.indexOf(evidence.quote, position + 1) >= 0) throw new AdaptiveError('ambiguous-source-quote');
  const start = segment.start + position, end = start + evidence.quote.length;
  const split = (offset: number) => offset > 0 && offset < context.source.text.length && /[\uD800-\uDBFF]/.test(context.source.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(context.source.text[offset]);
  if (split(start) || split(end) || context.source.text.slice(start, end) !== evidence.quote) throw new AdaptiveError('invalid-source-quote');
  return { sourceId: context.source.id, start, end };
}

/** Versioned exact unique quote over the bound immutable current patient source. */
export function resolveCurrentSourceQuote(context: AdaptiveContext, quote: string): EvidenceSpan {
  return resolveSegmentQuote(context, adaptiveSourceSegments(context), { segmentId: currentSourceStatementId(context), quote });
}

/** A unique whole-source anchor may contain a globally repeated subquote. The
 * subquote must occur exactly once inside that exact anchor; no normalization
 * or historical search. This opt-in protocol never changes v4 receipts. */
export function resolveAnchoredCurrentQuote(context: AdaptiveContext, anchor: string, quote: string): EvidenceSpan {
  const bound = resolveCurrentSourceQuote(context, anchor);
  if (!quote.trim()) throw new AdaptiveError('invalid-source-quote');
  const start = anchor.indexOf(quote);
  if (start < 0) throw new AdaptiveError('source-quote-not-in-anchor');
  if (anchor.indexOf(quote, start + 1) >= 0) throw new AdaptiveError('ambiguous-source-quote');
  const absolute = bound.start + start, end = absolute + quote.length;
  const split = (offset: number) => offset > 0 && offset < context.source.text.length && /[\uD800-\uDBFF]/.test(context.source.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(context.source.text[offset]);
  if (split(absolute) || split(end) || context.source.text.slice(absolute, end) !== quote) throw new AdaptiveError('invalid-source-quote');
  return { sourceId: bound.sourceId, start: absolute, end };
}
