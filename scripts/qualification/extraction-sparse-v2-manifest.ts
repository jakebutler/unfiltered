/** Source-only candidate. No provider, credentials, activation or persistence. */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { canonicalJson } from '../../packages/clinical-core/src/domain.js';
import type { InferenceMessage } from '../../packages/clinical-core/src/digitalocean.js';
import { getNativeQuestionnaireDefinition } from '../../packages/clinic-content/src/native-questionnaire.js';
import { AdaptiveError, type AdaptiveContext } from '../../packages/clinic-api/src/adaptive-validation.js';
import { createFullReplyManifest, type FullReplyTarget } from '../../packages/clinic-api/src/adaptive-reply-full.js';
import { createGroupedExtractionManifest, compileGroupedExtraction, type GroupedExtractionManifest, type GroupedWire } from '../../packages/clinic-api/src/adaptive-extraction-grouped-v2.js';
import { assertClosedObjectArraySchema } from './extraction-object-array-codec.mjs';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const bytes = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : canonicalJson(v));
const stateNames = { k: 'known', r: 'narrow', n: 'negative', u: 'unknown', q: 'uncertain', d: 'declined', a: 'not-applicable' } as const;
type Ref = string | { s: string; q: string };
type Provenance = Ref | { e: Ref[]; p: Ref; v: Ref | null; t: string | null; c: string[] };
type Owner = 'patient' | 'unclear' | { s: 'other'; e: string };
type Value = string | number | boolean | { feet: number; inches: number } | null;
interface Fact { f: string; k: keyof typeof stateNames; s: Provenance; v: Value }
export interface SparseWire {
  m: string;
  f: (Fact & { o: Owner })[];
  i: { c: string; n: { s: 'patient' | 'other' | 'unclear'; e: string; r: Provenance } | null; x: string | null; f: Fact[] }[];
  c: { f: string; s: Provenance }[];
  e: { k: GroupedWire['events'][number]['kind']; t: string; s: Ref; o: GroupedWire['events'][number]['owner'] }[];
  r: { s: Ref[]; r: GroupedWire['residual'][number][1] }[];
  d: GroupedWire['disposition'];
}
export const sparseProtocol = 'adaptive-extraction-sparse-v2';
export const sparseSchemaName = 'adaptive_extraction_sparse_v2';
export interface SparseManifest {
  readonly id: string; readonly protocol: typeof sparseProtocol; readonly sha256: string;
  readonly contextSha256: string;
  readonly nativeDefinition: Awaited<ReturnType<typeof getNativeQuestionnaireDefinition>>['binding'];
  readonly messages: readonly InferenceMessage[]; readonly jsonSchema: Record<string, unknown>;
  readonly measurement: GroupedExtractionManifest['measurement'];
}
interface Bank { id: string; quote: string; statementId: string }
interface Existing { id: string; alias: string; topicId: string; collection: string; subject: 'patient' | 'other' }
interface Issued { context: AdaptiveContext; signature: string; grouped: GroupedExtractionManifest; schema: z.ZodType; targets: readonly FullReplyTarget[]; bank: Bank[]; existing: Existing[] }
const issued = new WeakMap<SparseManifest, Issued>();
const syntax = `Return one sparse object m,f,i,c,e,r,d. Emit ONLY observed facts; no topic objects, empty items or catalog scaffolds. Scalar/whole-list facts f are {f:issuedSlot,o:owner,k:state,s:ownProvenance,v:valueOrNull}. owner is patient, unclear or {s:other,e:entity}. Each repeated item i is {c:issuedCollectionSlot,n:newIdentityOrNull,x:existingAliasOrNull,f:nonemptyFacts}; exactly one of n/x is non-null. New identity is {s:subject,e:entity,r:identityProvenance}. Item facts use the EXACT issued child slot for that item: [new] only for n; the matching existing item slot only for x. Every item is structurally separate; never merge medicines, relatives or eating occasions. Each fact has its OWN evidence. No parallel arrays or shared field groups.
k: known=k, narrow=r, negative=n, unknown=u, uncertain=q, declined=d, not-applicable=a. v is native value for k, exact limited narrative for r, null otherwise. Source s is an issued bank alias for its ENTIRE quote, or {s:alias,q:exactUniqueSubstringOfThatQuote}; no offsets. Copy literal text; a short repeated substring is ambiguous and rejected, so include distinguishing context or use the full issued segment. Explicit provenance {e:evidenceRefs,p:predicateRef,v:valueRefOrNull,t:periodOrNull,c:earlierCorrectionAliases} preserves distinct evidence/value/predicate/period/corrections. Use it whenever those differ. These are DIFFERENT fields: fact.v is the answer; fact.s.v is the exact value-source reference inside explicit provenance. For known (fact.k=k), fact.v is the supplied native value and explicit fact.s.v is non-null. For narrow (fact.k=r), fact.v is exact limited narrative, but explicit fact.s.v=null, fact.s.t=null and fact.s.c=[]. Other states have fact.v=null and explicit fact.s.v=null. Never encode an explicitly supplied replacement value as narrow/unknown: retain the new known value separately from the rejected earlier value, with exact same-item/field correction links. If a correction cannot be represented faithfully, preserve it in residual; do not weaken provenance. Closure c is {f:issuedCollectionSlot,s:explicitFinishedListEvidence}; never close from silence or another person's list. Events e are {k:kind,t:issuedTopic,s:sourceRef,o:careOwner}; residual r is {s:sourceRefs,r:reason}. d is represented/partially-represented. One utterance can supply several issued targets. Emit EACH directly supported fact in its own field, even when the same clause also supplies another field. Keep content and quantity fields separate; putting a quantity in a content value does not satisfy its quantity target. Preserve every supplied section detail before proposing a missing-detail question; never ask again for a supplied target or revive stopped details. An absence limited to one component never means absence of all needs/items in a composite field or topic: retain its exact narrow statement and leave the broader field unresolved. Negative/finished-list evidence must cover the entire exact target or list. Unmentioned fields have no output; silence never means unknown/negative/not-applicable. No output ordering by catalog, examples, navigation or generated reply.`;
export async function createSparseManifest(context: AdaptiveContext, grouped = createGroupedExtractionManifest(context)): Promise<SparseManifest> {
  if (!context.nativeRouting) throw new AdaptiveError('sparse-native-routing-required');
  const full = createFullReplyManifest(context), payload = JSON.parse(String(grouped.messages[1].content));
  const bank: Bank[] = payload.bank, existing: Existing[] = payload.existingItems;
  const enumOf = (v: string[]) => z.enum(v as [string, ...string[]]);
  const ref = z.union([enumOf(bank.map(s => s.id)), z.strictObject({ s: enumOf(bank.map(s => s.id)), q: z.string().min(1).max(8000) })]);
  const correction = payload.priorSourceBank.length ? enumOf(payload.priorSourceBank.map((s: { id: string }) => s.id)) : z.string().min(1);
  const explicit = { e: z.array(ref).min(1).max(4), p: ref, t: z.string().min(1).max(300).nullable(), c: z.array(correction).max(payload.priorSourceBank.length ? 8 : 0) };
  const provenance = z.union([ref, z.strictObject({ ...explicit, v: ref.nullable() })]);
  const knownSource = z.union([ref, z.strictObject({ ...explicit, v: ref })]);
  const narrowSource = z.union([ref, z.strictObject({ ...explicit, v: z.null(), t: z.null(), c: z.array(correction).length(0) })]);
  const otherSource = z.union([ref, z.strictObject({ ...explicit, v: z.null() })]);
  const owner = z.union([z.enum(['patient', 'unclear']), z.strictObject({ s: z.literal('other'), e: z.string().min(1).max(300) })]);
  const value = z.union([z.string().min(1).max(8000), z.number().finite(), z.boolean(), z.strictObject({ feet: z.number().int().nonnegative(), inches: z.number().nonnegative().lt(12) })]);
  const slotIds = enumOf(full.targets.map(t => t.id));
  const fact = (scalar: boolean) => {
    const fields = { f: slotIds, ...(scalar ? { o: owner } : {}) };
    return z.discriminatedUnion('k', [
      z.strictObject({ ...fields, k: z.literal('k'), s: knownSource, v: value }),
      z.strictObject({ ...fields, k: z.literal('r'), s: narrowSource, v: z.string().min(1).max(8000) }),
      z.strictObject({ ...fields, k: z.enum(['n', 'u', 'q', 'd', 'a']), s: otherSource, v: z.null() }),
    ]);
  };
  const roots = full.targets.filter(t => t.kind === 'collection');
  const schema = z.strictObject({ m: z.literal(grouped.id), f: z.array(fact(true)).max(64),
    i: z.array(z.strictObject({ c: enumOf(roots.map(t => t.id)), n: z.strictObject({ s: z.enum(['patient', 'other', 'unclear']), e: z.string().min(1).max(300), r: provenance }).nullable(), x: (existing.length ? enumOf(existing.map(i => i.alias)) : z.string().regex(/^i\d+$/)).nullable(), f: z.array(fact(false)).min(1).max(64) })).max(16),
    c: z.array(z.strictObject({ f: enumOf(roots.map(t => t.id)), s: provenance })).max(16),
    e: z.array(z.strictObject({ k: z.enum(['move-on', 'decline', 'question', 'treatment-question', 'dose-question']), t: enumOf(context.topics.map(t => t.id)), s: ref, o: z.enum(['medical', 'nutrition', 'administrative']) })).max(4),
    r: z.array(z.strictObject({ s: z.array(ref).min(1).max(4), r: z.enum(['ambiguous', 'unsupported-target', 'capacity', 'conflict', 'recognition-unreviewed']) })).max(8), d: z.enum(['represented', 'partially-represented']) });
  const topics = payload.topics.map((topic: any) => ({ ...topic, fields: topic.fields.map((field: any) => ({ ...field, slot: full.targets.find(t => t.topicId === topic.id && t.path === field.field)!.id })) }));
  const user = canonicalJson({ ...payload, manifest: grouped.id, topics });
  // Retain clinical instructions, remove predecessor representation instructions.
  const clinical = String(grouped.messages[0].content).replace(/Output topics keyed.*?All source meaning/s, 'All source meaning').replace(/Grouped transport only reduces repeated representation; it never repairs meaning\./, 'Exact quotes establish provenance, not semantic correctness.');
  const messages: InferenceMessage[] = [{ role: 'system', content: `${clinical}\n${syntax}` }, { role: 'user', content: user }];
  const nativeDefinition = (await getNativeQuestionnaireDefinition()).binding;
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', reused: 'ref' });
  assertClosedObjectArraySchema(jsonSchema);
  const contextSha256 = hash(context);
  const m: SparseManifest = Object.freeze({ id: grouped.id, protocol: sparseProtocol, sha256: hash({ messages, jsonSchema, nativeDefinition, contextSha256 }), nativeDefinition, contextSha256, messages, jsonSchema,
    measurement: { ...grouped.measurement, schemaBytes: bytes(jsonSchema), userBytes: bytes(user), instructionBytes: bytes(String(messages[0].content)), requestBodyBytes: bytes({ messages, jsonSchema }) } });
  if (m.measurement.schemaBytes > 32000 || m.measurement.requestBodyBytes > 131072) throw new AdaptiveError('sparse-request-capacity');
  issued.set(m, { context, signature: hash(m), grouped, schema, targets: full.targets, bank, existing });
  return m;
}
function trusted(m: SparseManifest) {
  const r = issued.get(m);
  if (!r || r.signature !== hash(m) || hash(r.context) !== m.contextSha256) throw new AdaptiveError('unissued-or-stale-sparse-manifest');
  return r;
}
/** Unique literal addressing, scoped to one issued source; never normalize or choose the first match. */
function ref(r: Issued, source: Ref): string | [string, number, number] {
  const id = typeof source === 'string' ? source : source.s, bank = r.bank.find(s => s.id === id);
  if (!bank) throw new AdaptiveError('invalid-sparse-source');
  if (typeof source === 'string') return source;
  const start = bank.quote.indexOf(source.q);
  if (!source.q.trim() || start < 0) throw new AdaptiveError('sparse-quote-not-found');
  if (bank.quote.indexOf(source.q, start + 1) >= 0) throw new AdaptiveError('ambiguous-sparse-quote');
  return [id, start, start + source.q.length];
}
function provenance(r: Issued, source: Provenance): any {
  return typeof source === 'string' || 's' in source ? ref(r, source as Ref) : { e: source.e.map(s => ref(r, s)), p: ref(r, source.p), v: source.v === null ? null : ref(r, source.v), t: source.t, c: source.c };
}
export function decodeSparseExtraction(raw: unknown, m: SparseManifest) {
  const r = trusted(m), wire = r.schema.parse(raw) as SparseWire;
  if (wire.f.length + wire.i.reduce((n, i) => n + i.f.length, 0) > 64) throw new AdaptiveError('sparse-fact-capacity');
  const groupedWire: GroupedWire = { m: m.id, topics: {}, events: wire.e.map(e => ({ kind: e.k, topic: e.t, source: ref(r, e.s), owner: e.o })), residual: wire.r.map(v => [v.s.map(s => ref(r, s)), v.r]), disposition: wire.d };
  const owner = (o: Owner): any => typeof o === 'string' ? o : ['other', o.e];
  const topic = (id: string, o?: Owner): any => {
    const present = groupedWire.topics[id];
    if (present && o && canonicalJson(present.owner) !== canonicalJson(owner(o))) throw new AdaptiveError('sparse-topic-owner-conflict');
    return present ?? (groupedWire.topics[id] = { owner: o ? owner(o) : 'patient' });
  };
  const target = (id: string) => { const t = r.targets.find(t => t.id === id); if (!t) throw new AdaptiveError('invalid-sparse-slot'); return t; };
  const unique = new Set<string>();
  const add = (container: any, f: Fact, field: string, address: string) => {
    if (unique.has(address)) throw new AdaptiveError('duplicate-sparse-slot'); unique.add(address);
    if (f.k === 'k' ? f.v === null : f.k === 'r' ? typeof f.v !== 'string' : f.v !== null) throw new AdaptiveError('invalid-sparse-state-value');
    const state = stateNames[f.k], p = provenance(r, f.s);
    // Grouping is exclusively server-side and includes every provenance dimension.
    const groups = (container[state] ??= []);
    let group = groups.find((g: any) => canonicalJson(g[0]) === canonicalJson(p));
    if (!group) { group = [p, f.k === 'k' || f.k === 'r' ? {} : []]; groups.push(group); }
    if (f.k === 'k' || f.k === 'r') group[1][field] = f.v; else group[1].push(field);
  };
  for (const f of wire.f) {
    const t = target(f.f); if (t.collection) throw new AdaptiveError('sparse-child-in-scalar');
    add(topic(t.topicId, f.o), f, t.path, `${t.id}:scalar`);
  }
  const identities = new Set<string>();
  const nonPatientLists = new Set<string>();
  for (const i of wire.i) {
    const root = target(i.c);
    if (root.kind !== 'collection' || Boolean(i.n) === Boolean(i.x)) throw new AdaptiveError('invalid-sparse-item-identity');
    const existing = i.x ? r.existing.find(e => e.alias === i.x && e.topicId === root.topicId && e.collection === root.path) : undefined;
    if (i.x && !existing) throw new AdaptiveError('sparse-existing-owner-mismatch');
    if ((i.n?.s ?? existing?.subject) !== 'patient') nonPatientLists.add(i.c);
    const identity = i.n ? { new: [i.n.s, i.n.e, provenance(r, i.n.r)] } : { existing: i.x };
    const identityKey = canonicalJson([i.c, identity]);
    if (identities.has(identityKey)) throw new AdaptiveError('duplicate-sparse-item'); identities.add(identityKey);
    const container: any = { ...identity };
    const top = topic(root.topicId); top.lists ??= {}; const list = (top.lists[root.path] ??= { items: [] }); list.items ??= []; list.items.push(container);
    for (const f of i.f) {
      const t = target(f.f);
      if (t.topicId !== root.topicId || t.collection !== root.path || (i.n ? !t.newItem : t.newItem || !t.path.startsWith(`${root.path}[${existing!.id}].`))) throw new AdaptiveError('sparse-item-slot-mismatch');
      add(container, f, t.definition.id, `${identityKey}:${t.id}`);
    }
  }
  const closures = new Set<string>();
  for (const c of wire.c) {
    const t = target(c.f); if (nonPatientLists.has(c.f)) throw new AdaptiveError('sparse-nonpatient-list-closure');
    if (t.kind !== 'collection' || closures.has(t.id)) throw new AdaptiveError('invalid-sparse-closure'); closures.add(t.id);
    const top = topic(t.topicId); top.lists ??= {}; const list = (top.lists[t.path] ??= {}); list.closed = provenance(r, c.s);
  }
  const compiled = compileGroupedExtraction(groupedWire, r.grouped);
  return { groupedWire, ...compiled };
}
/** Authored fixture adapter only. This function never supplies examples to the model. */
export function encodeSparseExtraction(g: GroupedWire, m: SparseManifest): SparseWire {
  const r = trusted(m); compileGroupedExtraction(g, r.grouped);
  const quote = (p: any): any => typeof p === 'string' ? p : Array.isArray(p) ? { s: p[0], q: r.bank.find(s => s.id === p[0])!.quote.slice(p[1], p[2]) } : { e: p.e.map(quote), p: quote(p.p), v: p.v === null ? null : quote(p.v), t: p.t, c: p.c };
  const slot = (topic: string, path: string) => r.targets.find(t => t.topicId === topic && t.path === path)!.id;
  const facts = (data: any, topic: string, path: (f: string) => string): Fact[] => Object.entries(stateNames).flatMap(([k, state]) => (data[state] ?? []).flatMap(([s, fields]: any) => (k === 'k' || k === 'r' ? Object.entries(fields) : fields.map((f: string) => [f, null])).map(([f, v]: any) => ({ f: slot(topic, path(f)), k, s: quote(s), v })))) as Fact[];
  const wire: SparseWire = { m: g.m, f: [], i: [], c: [], e: g.events.map(e => ({ k: e.kind, t: e.topic, s: quote(e.source), o: e.owner })), r: g.residual.map(([s, reason]) => ({ s: s.map(quote), r: reason })), d: g.disposition };
  for (const [id, t] of Object.entries(g.topics)) {
    const o: Owner = Array.isArray(t.owner) ? { s: 'other', e: t.owner[1] } : t.owner;
    wire.f.push(...facts(t, id, f => f).map(f => ({ ...f, o })));
    for (const [c, list] of Object.entries(t.lists ?? {})) {
      wire.f.push(...facts(list, id, f => f).map(f => ({ ...f, o })));
      for (const item of list.items ?? []) {
        const existing = item.existing ? r.existing.find(i => i.alias === item.existing)! : undefined;
        wire.i.push({ c: slot(id, c), n: item.new ? { s: item.new[0], e: item.new[1], r: quote(item.new[2]) } : null, x: item.existing ?? null, f: facts(item, id, f => `${c}[${item.new ? 'new' : existing!.id}].${f}`) });
      }
      if (list.closed) wire.c.push({ f: slot(id, c), s: quote(list.closed) });
    }
  }
  decodeSparseExtraction(wire, m); return wire;
}
/** Budget depends on emitted fact/source representation; excludes hidden model reasoning. */
export function sparseOutputBudget(wire: SparseWire) {
  const outputBytes = bytes(wire), facts = wire.f.length + wire.i.reduce((n, i) => n + i.f.length, 0);
  const conservativeOutputTokens = Math.ceil(outputBytes * 0.5);
  return { outputBytes, facts, conservativeOutputTokens, maxOutputTokens: Math.ceil((conservativeOutputTokens * 1.5 + 256) / 256) * 256, tokenizerVerified: false, providerReasoningTokensKnown: false };
}
