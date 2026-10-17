/** Test-only migration of authored legacy fixtures; never consumes or repairs provider output. */
import { createFullReplyManifest } from '../src/adaptive-reply-full.js';
import { createGroupedExtractionManifest } from '../src/adaptive-extraction-grouped-v2.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
import type { SparseWire } from '../src/adaptive-extraction-sparse.js';
export interface AuthoredWire { m: string; f: any[]; i: any[]; c: any[]; e: any[]; r: any[]; d: any }
export function readableFixture(wire: AuthoredWire | SparseWire, context: AdaptiveContext): SparseWire {
  if ('manifestId' in wire) return wire;
  const targets = createFullReplyManifest(context).targets, payload = JSON.parse(String(createGroupedExtractionManifest(context).messages[1].content));
  const quote = (s: any): string => typeof s === 'string' ? payload.bank.find((b: any) => b.id === s)?.quote ?? s : s.q;
  const root = (id: string) => { const t = targets.find(t => t.id === id); return t ? `${t.topicId}.${t.path}` : id; };
  const states: Record<string, string> = { r: 'limited-report', n: 'explicit-none', u: 'not-recalled', q: 'possible', d: 'declined', a: 'not-applicable' };
  const report = (facts: any[], scalar = false): any => {
    const own = (f: any) => typeof f.s === 'string' || 's' in f.s ? quote(f.s) : quote(f.s.p);
    const sourceQuote = facts.length ? own(facts[0]) : context.source.text;
    const reported: any[] = [], exceptions: any[] = [], provenance: any[] = [];
    for (const f of facts) {
      const attribute = scalar ? root(f.f) : f.f;
      if (f.k === 'k') reported.push({ attribute, value: f.v });
      else exceptions.push({ attribute, kind: states[f.k], ...(f.k === 'r' ? { text: f.v } : {}), sourceQuote: own(f) });
      if (typeof f.s !== 'string' && !('s' in f.s)) provenance.push({ attributes: [attribute], evidenceQuotes: f.s.e.map(quote), predicateQuote: quote(f.s.p), valueQuote: f.s.v === null ? null : quote(f.s.v), period: f.s.t, correctsSourceIds: f.s.c });
      else if (f.k === 'k' && own(f) !== sourceQuote) provenance.push({ attributes: [attribute], evidenceQuotes: [own(f)], predicateQuote: own(f), valueQuote: own(f), period: null, correctsSourceIds: [] });
    }
    return { sourceQuote, reported, exceptions, provenance, ...(scalar && facts.some(f => f.o !== 'patient') ? { invalidSubject: facts.find(f => f.o !== 'patient').o } : {}) };
  };
  return { manifestId: wire.m, reports: wire.f.map(f => report([f], true)), items: wire.i.map(i => ({ collection: root(i.c), newItem: i.n ? { subject: i.n.s, entity: i.n.e, sourceQuotes: typeof i.n.r === 'string' || 's' in i.n.r ? [quote(i.n.r)] : i.n.r.e.map(quote) } : null, existingItem: i.x, ...report(i.f) })), finishedLists: wire.c.map(c => ({ collection: root(c.f), sourceQuotes: typeof c.s === 'string' || 's' in c.s ? [quote(c.s)] : c.s.e.map(quote) })), questions: wire.e.map(e => ({ kind: e.k, topic: e.t, sourceQuote: quote(e.s), careOwner: e.o })), unmapped: wire.r.map(r => ({ sourceQuotes: r.s.map(quote), reason: r.r })), sourceDisposition: wire.d };
}
