import { createHash } from 'node:crypto';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { AdaptiveError, parseExplicitHeight, type AdaptiveContext, type EvidenceSpan } from './adaptive-validation.js';

export interface SourceHandle extends EvidenceSpan {
  readonly ref: string;
  readonly text: string;
}
export interface LexicalHandle extends SourceHandle {
  readonly kind: 'number' | 'unit' | 'height';
  readonly statement: string;
}
export interface AdaptiveSourceHandles {
  readonly statements: readonly SourceHandle[];
  readonly lexical: readonly LexicalHandle[];
}
const issued = new WeakMap<AdaptiveSourceHandles, string>();
/** Issued source spans only. No target/meaning inference and no text normalization. */
export function createAdaptiveSourceHandles(context: AdaptiveContext): AdaptiveSourceHandles {
  const source = context.source,
    matching = context.sources.filter((entry) => entry.id === source.id);
  if (
    source.role !== 'patient' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(source.id) ||
    !source.text.trim() ||
    source.text.length > 8000 ||
    matching.length !== 1 ||
    canonicalJson(matching[0]) !== canonicalJson(source)
  )
    throw new AdaptiveError('invalid-adaptive-source');
  const text = source.text,
    ends = [...text.matchAll(/[.!?](?=\s|$)|;|\r?\n/g)]
      .filter((match) => match[0] !== '.' || !/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|[A-Z])$/i.test(text.slice(0, match.index)))
      .map((match) => match.index! + match[0].length);
  if (ends.at(-1) !== text.length) ends.push(text.length);
  const statements: SourceHandle[] = [],
    step = Math.max(1, Math.ceil(ends.length / 64));
  let start = 0;
  for (let i = step - 1; i < ends.length + step - 1; i += step) {
    const end = ends[Math.min(i, ends.length - 1)];
    if (end > start)
      statements.push(
        Object.freeze({ ref: `p${statements.length}`, sourceId: source.id, start, end, text: text.slice(start, end) }),
      );
    start = end;
  }
  const lexical: LexicalHandle[] = [],
    seen = new Set<string>();
  const append = (kind: LexicalHandle['kind'], start: number, end: number) => {
    const statement = statements.find((entry) => entry.start <= start && entry.end >= end);
    if (!statement) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    lexical.push(
      Object.freeze({
        ref: `v${lexical.length}`,
        kind,
        statement: statement.ref,
        sourceId: source.id,
        start,
        end,
        text: text.slice(start, end),
      }),
    );
  };
  const height =
    /\b(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(?:feet|foot|ft\.?|')\s*(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(?:inches|inch|in\.?|\")/gi;
  for (const match of text.matchAll(height))
    if (parseExplicitHeight(match[0])) {
      append('height', match.index!, match.index! + match[0].length);
      for (const unit of match[0].matchAll(/\b(?:feet|foot|ft|inches|inch|in)\b/gi))
        append('unit', match.index! + unit.index!, match.index! + unit.index! + unit[0].length);
    }
  for (const match of text.matchAll(/\b\d+(?:\.\d+)?/g)) {
    const tail = text.slice(match.index! + match[0].length);
    if (
      /^(?:st|nd|rd|th)\b/i.test(tail) ||
      (/^[\p{L}\p{N}_]/u.test(tail) &&
        !/^(?:pounds?|lbs?|kilograms?|kg|centimet(?:er|re)s?|cm|met(?:er|re)s?|m|inches|inch|in|feet|foot|ft|mg|mcg|IU)\b/i.test(
          tail,
        ))
    )
      continue;
    append('number', match.index!, match.index! + match[0].length);
  }
  const units =
    /\b(?:\d+(?:\.\d+)?)\s*(pounds?|lbs?|kilograms?|kg|stones?|st|centimet(?:er|re)s?|cm|met(?:er|re)s?|m|inches|inch|in|feet|foot|ft|mg|mcg|IU)\b/gi;
  for (const match of text.matchAll(units)) {
    const unit = match[1],
      at = match.index! + match[0].length - unit.length,
      following = text.slice(at + unit.length).trimStart();
    // Short labels can also be prepositions/ordinals/letters. Issue them only in
    // a completed measurement form or before an explicit dimension modifier.
    if (/^(?:in|m|st)$/i.test(unit) && /^[\p{L}_]/u.test(following) && !/^(?:tall|long|wide|high)\b/i.test(following))
      continue;
    if (/^st$/i.test(unit) && at > 0 && /\d/.test(text[at - 1])) continue;
    append('unit', at, at + unit.length);
  }
  if (lexical.length > 192) throw new AdaptiveError('source-handle-limit');
  const result = Object.freeze({ statements: Object.freeze(statements), lexical: Object.freeze(lexical) });
  issued.set(result, canonicalJson(context));
  return result;
}
export function assertAdaptiveSourceHandles(context: AdaptiveContext, handles: AdaptiveSourceHandles): void {
  if (issued.get(handles) !== canonicalJson(context)) throw new AdaptiveError('stale-source-handles');
}
export function sourceHandleFingerprint(handles: AdaptiveSourceHandles): string {
  return createHash('sha256').update(canonicalJson(handles)).digest('hex');
}
