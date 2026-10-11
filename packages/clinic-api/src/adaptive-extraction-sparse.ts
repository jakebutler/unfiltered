/** Optional canonical-route codec. No factory activation, credentials or clinical credit. */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import type { InferenceMessage } from '../../clinical-core/src/digitalocean.js';
import { getNativeQuestionnaireDefinition } from '../../clinic-content/src/native-questionnaire.js';
import { AdaptiveError, type AdaptiveContext } from './adaptive-validation.js';
import { createFullReplyManifest, type FullReplyTarget } from './adaptive-reply-full.js';
import { currentSourceStatementId, resolveCurrentSourceQuote, resolveAnchoredCurrentQuote } from './adaptive-source.js';
import { domainCollectionSubjects } from './adaptive-reply-domain.js';
import { createGroupedExtractionManifest, compileGroupedExtraction, type GroupedExtractionManifest, type GroupedWire } from './adaptive-extraction-grouped-v2.js';
import assert from 'node:assert/strict';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const bytes = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : canonicalJson(v));
const stateNames = { k: 'known', r: 'narrow', n: 'negative', u: 'unknown', q: 'uncertain', d: 'declined', a: 'not-applicable' } as const;
type Ref = string | { s: string; q: string; anchor?: string };
type Provenance = Ref | { e: Ref[]; p: Ref; v: Ref | null; t: string | null; c: string[] };
type Owner = 'patient' | 'unclear' | { s: 'other'; e: string };
type Value = string | number | boolean | { feet: number; inches: number } | null;
interface Fact { f: string; k: keyof typeof stateNames; s: Provenance; v: Value }
interface BridgeWire {
  m: string;
  f: (Fact & { o: Owner })[];
  i: { c: string; n: { s: 'patient' | 'other' | 'unclear'; e: string; r: Provenance } | null; x: string | null; f: Fact[] }[];
  c: { f: string; s: Provenance }[];
  e: { k: GroupedWire['events'][number]['kind']; t: string; s: Ref; o: GroupedWire['events'][number]['owner'] }[];
  r: { s: Ref[]; r: GroupedWire['residual'][number][1] }[];
  d: GroupedWire['disposition'];
}
/** Reported values are supplied patient reports, not verified clinical facts. */
interface ReportedAttribute { attribute: string; value: Exclude<Value, null> }
interface ExceptionAttribute { attribute: string; kind: 'not-recalled' | 'possible' | 'declined' | 'explicit-none' | 'not-applicable' | 'limited-report'; sourceQuote: string; text?: string }
interface AttributeProvenance { attributes: string[]; evidenceQuotes: string[]; predicateQuote: string; valueQuote: string | null; period: string | null; correctsSourceIds: string[] }
interface Report { sourceQuote: string; reported: ReportedAttribute[]; exceptions: ExceptionAttribute[]; provenance: AttributeProvenance[] }
export interface SparseWire {
  manifestId: string;
  reports: Report[];
  items: (Report & { collection: string; newItem: { subject: 'patient' | 'other' | 'unclear'; entity: string; sourceQuotes: string[] } | null; existingItem: string | null })[];
  finishedLists: { collection: string; sourceQuotes: string[] }[];
  questions: { kind: GroupedWire['events'][number]['kind']; topic: string; sourceQuote: string; careOwner: GroupedWire['events'][number]['owner'] }[];
  unmapped: { sourceQuotes: string[]; reason: GroupedWire['residual'][number][1] }[];
  sourceDisposition: GroupedWire['disposition'];
}
export const sparseProtocol = 'adaptive-extraction-readable-v6';
export const sparseSchemaName = 'adaptive_extraction_readable_v6';
export interface SparseManifest {
  readonly id: string; readonly protocol: typeof sparseProtocol | 'adaptive-extraction-focused-v1'; readonly sha256: string;
  readonly contextSha256: string;
  readonly nativeDefinition: Awaited<ReturnType<typeof getNativeQuestionnaireDefinition>>['binding'];
  readonly messages: readonly InferenceMessage[]; readonly jsonSchema: Record<string, unknown>;
  readonly measurement: GroupedExtractionManifest['measurement'];
}
interface Bank { id: string; quote: string; statementId: string }
interface Existing { id: string; alias: string; topicId: string; collection: string; subject: 'patient' | 'other' }
export interface SparseOptions { focusedTopicIds?: readonly string[]; anchoredQuotes?: boolean; strictAnnotationAttributes?: boolean; noncapturableCollectionTopics?: readonly string[] }
interface Issued { options: SparseOptions; context: AdaptiveContext; signature: string; grouped: GroupedExtractionManifest; schema: z.ZodType; targets: readonly FullReplyTarget[]; bank: Bank[]; existing: Existing[] }
const issued = new WeakMap<SparseManifest, Issued>();
const syntax = `Return one readable sparse object: manifestId, reports, items, finishedLists, questions, unmapped, sourceDisposition. Extract every supplied detail across ALL issued topics, including volunteered topics; the displayed question does not restrict capture. Missing attributes have no entry. Omitted allowsExplicitNone/allowsNotApplicable capability flags mean false; limited-report is permitted only for text and collection attributes; top-level stopRules applies unless a topic overrides it. Do not populate the catalog, emit empty records, or infer unknown/none/closure from silence.
A report groups coherent patient-owned detail: sourceQuote is its exact supporting current-source text; reported is an array of {attribute,value} using the readable full topic.field attribute. A supplied value is a patient report by default: it needs no assertion or knowledge-state label. Presence and true/false choices use JSON booleans; other choices use their offered values. Preserve native types, quantities, units, complete dates/time zones, label directions versus actual use, and periods. Content mentioning a quantity does not supply a separate quantity attribute; emit every supplied attribute. Use the authored label, meaning and when context of each attribute, rather than matching a word alone. Conditional support/concern attributes describe that exact concern, not arbitrary requests elsewhere.
An item groups one medicine, relative or eating occasion: collection is the readable topic.collection; reported uses its readable child attributes. Exactly one of newItem/existingItem is non-null. newItem supplies subject, entity and exact identity sourceQuotes; existingItem is an issued existing alias. Never join medicines, relatives or occasions, recreate an existing corrected item, use scalar/root/global handles as child attributes, or select an unissued target. The server resolves collection + exact item + child to an actual issued native target.
Clinical subject is the person whose history, medicine, preference or episode the record describes, not the speaker, diagnosing clinician or care-team addressee. Reports are patient-only; item subjects use collection.allowedSubjects. A named care owner or relationship is an attribute value and does not change the subject. Patient-only targets never authorize relabeling third-party content as patient-owned; preserve unsupported person/concept meaning in unmapped. Split patient and family reports.
exceptions has entries ONLY for an expressly supplied qualifier at the exact identified attribute: not-recalled means the patient explicitly cannot recall/does not know that detail; possible means doubt about that assertion; declined requires an actual refusal; explicit-none covers the whole field; not-applicable requires explicit inapplicability; limited-report preserves exact text describing less than the field. Only limited-report has text, copied exactly. Unmentioned detail is absent, never an exception. Possible diagnosis is possible, never a supplied affirmative diagnosis. Negative alternatives in a correction reject the old value, not the entire field: emit only the supplied replacement with valid same-item/attribute prior-source links. A component-only absence in a composite attribute uses limited-report with exact text; it cannot be whole-field explicit-none. A known replacement cannot be weakened to limited/unknown. Each attribute appears at most once across reported and exceptions.
sourceQuote and all provenance quotes are exact unique contiguous substrings of the bound immutable CURRENT patient source, including across sentences. No normalization, offsets, history search or repeated occurrence selection. A quote may support several faithful attributes, but its coverage never proves completeness or meaning. provenance is normally []; add an entry only when selected attributes have distinct evidence/predicate/value quotes, period or correction links. Each entry specifies attributes, evidenceQuotes, predicateQuote, valueQuote, period, correctsSourceIds. valueQuote is required and non-null for supplied values, null for exceptions. Preserve every provenance dimension; prior links may name only issued earlier sources genuinely corrected at the exact same item/attribute. Reaffirmation with the unchanged active meaning retains both evidence sources and does not supersede the prior value.
finishedLists supplies collection and exact sourceQuotes for an explicitly finished entire list, never current-use wording or absence of further items. questions describe an explicit question/request or direct displayed-topic move-on/decline act, never inferred commands. careOwner is its issued care-team owner, separate from clinical subject. Keep question events separate from patient/family facts. unmapped retains supplied meaning not faithfully representable, with exact sourceQuotes and reason. sourceDisposition is descriptive only; no model output can grant readiness, choose a branch, generate a clinical reply or certify completeness. Full source and proposed/unresolved details remain available for patient review. Do not infer PHQ choices or latent affect; exact screening-choice route remains separate. No examples, generated replies, catalog ordering or scaffolds.`;
const exceptionStates = { 'not-recalled': 'u', possible: 'q', declined: 'd', 'explicit-none': 'n', 'not-applicable': 'a', 'limited-report': 'r' } as const;
const collectionName = (target: FullReplyTarget) => `${target.topicId}.${target.path}`;
const scalarName = (target: FullReplyTarget) => `${target.topicId}.${target.path}`;
function nativeValue(target: FullReplyTarget): z.ZodType {
  if (target.kind === 'presence' || target.kind === 'choice' && target.choices?.length && target.choices.every(v => ['true', 'false'].includes(String(v)))) return z.boolean();
  if (target.kind === 'positive-number') return z.union([z.number().finite(), z.string().min(1).max(8000)]);
  if (target.kind === 'height-value') return z.union([z.number().finite(), z.string().min(1).max(8000), z.strictObject({ feet: z.number().int().nonnegative(), inches: z.number().nonnegative().lt(12) })]);
  if (target.kind === 'choice' && target.choices?.length) return z.enum(target.choices.map(String) as [string, ...string[]]);
  return z.string().min(1).max(8000);
}
export async function createSparseManifest(context: AdaptiveContext, grouped = createGroupedExtractionManifest(context), options: SparseOptions = {}): Promise<SparseManifest> {
  if (!context.nativeRouting) throw new AdaptiveError('sparse-native-routing-required');
  options = Object.freeze({ ...options, ...(options.focusedTopicIds ? { focusedTopicIds: Object.freeze([...options.focusedTopicIds]) } : {}), ...(options.noncapturableCollectionTopics ? { noncapturableCollectionTopics: Object.freeze([...options.noncapturableCollectionTopics]) } : {}) });
  const full = createFullReplyManifest(context), targets = full.targets.filter(t => (!options.focusedTopicIds || options.focusedTopicIds.includes(t.topicId)) && !(options.noncapturableCollectionTopics?.includes(t.topicId) && (t.kind === 'collection' || t.collection))), payload = JSON.parse(String(grouped.messages[1].content));
  const bank: Bank[] = payload.bank, existing: Existing[] = payload.existingItems;
  const enums = new Map<string, z.ZodType>();
  const enumOf = (v: string[]): any => { if (!v.length) throw new AdaptiveError('empty-sparse-schema-choice'); const key = canonicalJson(v); if (!enums.has(key)) enums.set(key, z.enum(v as [string, ...string[]])); return enums.get(key)!; };
  const values = new Map<string, z.ZodType>();
  const unionOf = (v: z.ZodType[]): z.ZodType => { if (!v.length) throw new AdaptiveError('empty-sparse-schema-choice'); return v.length === 1 ? v[0] : z.union(v as [z.ZodType, z.ZodType, ...z.ZodType[]]); };
  // No issued choice means exactly an empty array. A simple item type with
  // maxItems=0 avoids invalid empty enums and provider-unsupported `not`.
  const emptyArray = () => z.array(z.string()).max(0);
  const quote = z.string().min(1).max(8000), correction = payload.priorSourceBank.length ? enumOf(payload.priorSourceBank.map((s: { id: string }) => s.id)) : z.string().min(1);
  // An annotation can name only an attribute actually selected in its own record (checked before expansion).
  const annotation = z.strictObject({ attributes: z.array(z.string().min(1).max(160)).min(1).max(64), evidenceQuotes: z.array(quote).min(1).max(4), predicateQuote: quote, valueQuote: quote.nullable(), period: z.string().min(1).max(300).nullable(), correctsSourceIds: z.array(correction).max(payload.priorSourceBank.length ? 8 : 0) });
  
  const quotedEvidence = z.array(quote).min(1).max(4);
  const attributes = (targets: readonly FullReplyTarget[], child = false) => {
    const name = (t: FullReplyTarget) => child ? t.definition.id : scalarName(t);
    // Share only identical native type schemas; allowed attribute sets remain exact.
    const types = new Map<string, { value: z.ZodType; targets: FullReplyTarget[] }>();
    for (const t of targets.filter(t => t.kind !== 'collection')) {
      const candidate = nativeValue(t), key = canonicalJson(z.toJSONSchema(candidate, { target: 'draft-7' }));
      if (!values.has(key)) values.set(key, candidate);
      const group = types.get(key) ?? { value: values.get(key)!, targets: [] }; group.targets.push(t); types.set(key, group);
    }
    const reported = [...types.values()].map(type => z.strictObject({ attribute: enumOf(type.targets.map(name)), value: type.value }));
    const variants: z.ZodType[] = targets.length ? [z.strictObject({ attribute: enumOf(targets.map(name)), kind: enumOf(['not-recalled', 'possible', 'declined']), sourceQuote: quote })] : [];
    for (const [kind, allowed] of [['explicit-none', targets.filter(t => t.definition.acceptsNegative && t.definition.extractionNegativeScope !== 'composite')], ['not-applicable', targets.filter(t => t.definition.acceptsNotApplicable)], ['limited-report', targets.filter(t => t.kind === 'text' || t.kind === 'collection')]] as const) {
      if (allowed.length) variants.push(z.strictObject({ attribute: enumOf(allowed.map(name)), kind: z.literal(kind), sourceQuote: quote, ...(kind === 'limited-report' ? { text: quote } : {}) }));
    }
    return { sourceQuote: quote, reported: reported.length ? z.array(unionOf(reported)).max(64) : emptyArray(), exceptions: variants.length ? z.array(unionOf(variants)).max(64) : emptyArray(), provenance: targets.length ? z.array(options.strictAnnotationAttributes ? annotation.extend({ attributes: z.array(enumOf(targets.map(name))).min(1).max(64) }) : annotation).max(64) : emptyArray() };
  };
  const roots = targets.filter(t => t.kind === 'collection');
  const identities = new Map<string, z.ZodType>();
  const items = roots.map(root => {
    const subjects = domainCollectionSubjects(root), identityKey = canonicalJson(subjects);
    if (!identities.has(identityKey)) identities.set(identityKey, z.strictObject({ subject: enumOf(subjects), entity: z.string().min(1).max(300), sourceQuotes: quotedEvidence }).nullable());
    const aliases = existing.filter(item => item.topicId === root.topicId && item.collection === root.path).map(item => item.alias);
    return z.strictObject({ collection: z.literal(collectionName(root)), newItem: identities.get(identityKey)!, existingItem: aliases.length ? enumOf(aliases).nullable() : z.null(), ...attributes(targets.filter(t => t.topicId === root.topicId && t.collection === root.path && t.newItem), true) });
  });
  const questionFields = { sourceQuote: quote, careOwner: z.enum(['medical', 'nutrition', 'administrative']) };
  const question = context.topics.length ? z.strictObject({ ...questionFields, kind: z.enum(['question', 'treatment-question', 'dose-question']), topic: enumOf(context.topics.map(t => t.id)) }) : undefined;
  const event = question && context.displayed ? z.union([question, z.strictObject({ ...questionFields, kind: z.enum(['move-on', 'decline']), topic: z.literal(context.displayed.topicId) })]) : question;
  const scalarTargets = targets.filter(t => !t.collection);
  const schema = z.strictObject({ manifestId: z.literal(grouped.id), reports: scalarTargets.length ? z.array(z.strictObject(attributes(scalarTargets))).max(64) : emptyArray(),
    items: items.length ? z.array(z.discriminatedUnion('collection', items as [typeof items[number], ...typeof items[number][]])).max(16) : emptyArray(),
    finishedLists: roots.length ? z.array(z.strictObject({ collection: enumOf(roots.map(collectionName)), sourceQuotes: quotedEvidence })).max(16) : emptyArray(),
    questions: event ? z.array(event).max(4) : emptyArray(), unmapped: z.array(z.strictObject({ sourceQuotes: z.array(quote).min(1).max(4), reason: enumOf(['ambiguous', 'unsupported-target', 'capacity', 'conflict', ...(context.source.channel === 'unreviewed-transcript' ? ['recognition-unreviewed'] : [])]) })).max(8), sourceDisposition: z.enum(['represented', 'partially-represented']) });
  const describe = (t: FullReplyTarget, field: any, child = false) => {
    const { negative, notApplicable, slot, field: oldField, ...meaning } = field ?? { label: t.definition.label };
    return { ...meaning, attribute: child ? t.definition.id : scalarName(t), type: t.kind, ...(t.choices?.length ? { choices: t.choices } : {}), ...(t.definition.when ? { when: t.definition.when } : {}), ...(t.definition.extractionNegativeScope ? { negativeScope: t.definition.extractionNegativeScope } : {}), ...(t.definition.acceptsNegative && t.definition.extractionNegativeScope !== 'composite' ? { allowsExplicitNone: true } : {}), ...(t.definition.acceptsNotApplicable ? { allowsNotApplicable: true } : {}) };
  };
  const commonStopRules = payload.topics[0]?.stopRules ?? [];
  const topics = payload.topics.filter((topic: any) => !options.focusedTopicIds || options.focusedTopicIds.includes(topic.id)).map((topic: any) => ({ id: topic.id, purpose: topic.purpose, minimums: topic.minimums, presentation: topic.presentation, applicability: topic.applicability, ...(canonicalJson(topic.stopRules) === canonicalJson(commonStopRules) ? {} : { stopRules: topic.stopRules }), allowedSubjects: ['patient'],
    attributes: targets.filter(t => t.topicId === topic.id && !t.collection).map(t => describe(t, topic.fields.find((f: any) => f.field === t.path))),
    collections: roots.filter(t => t.topicId === topic.id).map(root => ({ collection: collectionName(root), label: root.definition.label, allowedSubjects: domainCollectionSubjects(root), attributes: targets.filter(t => t.topicId === root.topicId && t.collection === root.path && t.newItem).map(t => describe(t, topic.fields.find((f: any) => f.field === t.path), true)) })) }));
  // Source, authored context and exact issued identities; no duplicated compact field/state catalog.
  const user = canonicalJson({ manifestId: grouped.id, source: context.source.text, scenario: payload.scenario, purpose: payload.purpose, displayed: payload.displayed, stopRules: commonStopRules, topics, prior: payload.prior, existingItems: existing, priorSourceBank: payload.priorSourceBank, sourceAdmission: { channel: context.source.channel ?? 'text', recognitionUnreviewed: context.source.channel === 'unreviewed-transcript' } });
  const messages: InferenceMessage[] = [{ role: 'system', content: options.anchoredQuotes ? syntax.replace('sourceQuote and all provenance quotes are exact unique contiguous substrings of the bound immutable CURRENT patient source, including across sentences.', 'Each record sourceQuote is an exact uniquely occurring contiguous anchor in the immutable CURRENT source. Its provenance evidence/predicate/value quotes must each occur exactly once within that record anchor; they may recur elsewhere in the source. Other required quotes remain globally unique current-source quotes. No quote outside its record anchor is admitted.') : syntax }, { role: 'user', content: user }];
  const nativeDefinition = (await getNativeQuestionnaireDefinition()).binding, jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', reused: 'ref' });
  assertClosedSchema(jsonSchema);
  const contextSha256 = hash(context);
  const m: SparseManifest = Object.freeze({ id: grouped.id, protocol: options.anchoredQuotes || options.focusedTopicIds || options.strictAnnotationAttributes ? 'adaptive-extraction-focused-v1' : sparseProtocol, sha256: hash({ messages, jsonSchema, nativeDefinition, contextSha256 }), nativeDefinition, contextSha256, messages, jsonSchema, measurement: { ...grouped.measurement, schemaBytes: bytes(jsonSchema), userBytes: bytes(user), instructionBytes: bytes(String(messages[0].content)), requestBodyBytes: bytes({ messages, jsonSchema }) } });
  if (messages.some(message => String(message.content).length > 32000) || m.measurement.schemaBytes > 32000 || m.measurement.requestBodyBytes > 131072) throw Object.assign(new AdaptiveError('sparse-request-capacity'), { measurement: m.measurement });
  issued.set(m, { options, context, signature: hash(m), grouped, schema, targets: full.targets, bank, existing }); return m;
}
function trusted(m: SparseManifest) {
  const r = issued.get(m);
  if (!r || r.signature !== hash(m) || hash(r.context) !== m.contextSha256) throw new AdaptiveError('unissued-or-stale-sparse-manifest');
  return r;
}
/** Unique literal addressing, scoped to one issued source; never normalize or choose the first match. */
function ref(r: Issued, source: Ref): string | [string, number, number] | [string, number, number, string] {
  const id = typeof source === 'string' ? source : source.s, bank = r.bank.find(s => s.id === id);
  if (!bank) throw new AdaptiveError('invalid-sparse-source');
  const span = typeof source !== 'string' && source.anchor !== undefined ? resolveAnchoredCurrentQuote(r.context, source.anchor, source.q) : resolveCurrentSourceQuote(r.context, typeof source === 'string' ? bank.quote : source.q);
  const current = r.bank.find(entry => entry.statementId === currentSourceStatementId(r.context));
  if (!current) throw new AdaptiveError('invalid-sparse-current-source');
  return typeof source !== 'string' && source.anchor !== undefined ? [current.id, span.start, span.end, source.anchor] : [current.id, span.start, span.end];
}
function provenance(r: Issued, source: Provenance): any {
  return typeof source === 'string' || 's' in source ? ref(r, source as Ref) : { e: source.e.map(s => ref(r, s)), p: ref(r, source.p), v: source.v === null ? null : ref(r, source.v), t: source.t, c: source.c };
}
/** Mechanical readable-record expansion; compiler retains all value/source/ownership authority. */
function toBridge(wire: SparseWire, r: Issued): BridgeWire {
  const source = (quote: string): Ref => ({ s: r.bank[0].id, q: quote });
  const attributes = (record: Report, slot: (name: string) => string): Fact[] => {
    if (!record.reported.length && !record.exceptions.length) throw new AdaptiveError('empty-sparse-report');
    const selected = [...record.reported, ...record.exceptions].map(a => a.attribute);
    if (new Set(selected).size !== selected.length) throw new AdaptiveError('duplicate-sparse-slot');
    const overrides = new Map<string, AttributeProvenance>();
    for (const p of record.provenance) for (const attribute of p.attributes) {
      if (overrides.has(attribute) || ![...record.reported, ...record.exceptions].some(f => f.attribute === attribute)) throw new AdaptiveError('invalid-sparse-provenance-attribute');
      overrides.set(attribute, p);
    }
    const own = (attribute: string, quote: string, known: boolean): Provenance => {
      const p = overrides.get(attribute);
      if (!p) return source(quote);
      if (known !== (p.valueQuote !== null)) throw new AdaptiveError('invalid-sparse-state-value');
      const cite = (q: string): Ref => r.options.anchoredQuotes ? { ...source(q) as { s: string; q: string }, anchor: record.sourceQuote } : source(q);
      return { e: p.evidenceQuotes.map(cite), p: cite(p.predicateQuote), v: p.valueQuote === null ? null : cite(p.valueQuote), t: p.period, c: p.correctsSourceIds };
    };
    // The shared citation is checked even when every attribute has distinct provenance.
    ref(r, source(record.sourceQuote));
    for (const exception of record.exceptions) ref(r, source(exception.sourceQuote));
    return [...record.reported.map(a => ({ f: slot(a.attribute), k: 'k' as const, v: a.value, s: own(a.attribute, record.sourceQuote, true) })), ...record.exceptions.map(a => ({ f: slot(a.attribute), k: exceptionStates[a.kind], v: a.kind === 'limited-report' ? a.text! : null, s: own(a.attribute, a.sourceQuote, false) }))];
  };
  const scalar = (attribute: string) => { const target = r.targets.find(t => !t.collection && scalarName(t) === attribute); if (!target) throw new AdaptiveError('invalid-sparse-slot'); return target.id; };
  const root = (collection: string) => { const target = r.targets.find(t => t.kind === 'collection' && collectionName(t) === collection); if (!target) throw new AdaptiveError('invalid-sparse-slot'); return target.id; };
  return { m: wire.manifestId, f: wire.reports.flatMap(report => attributes(report, scalar).map(f => ({ ...f, o: 'patient' }))),
    i: wire.items.map(item => ({ c: root(item.collection), n: item.newItem ? { s: item.newItem.subject, e: item.newItem.entity, r: { e: item.newItem.sourceQuotes.map(source), p: source(item.newItem.sourceQuotes[0]), v: null, t: null, c: [] } } : null, x: item.existingItem, f: attributes(item, name => name) })),
    c: wire.finishedLists.map(c => ({ f: root(c.collection), s: { e: c.sourceQuotes.map(source), p: source(c.sourceQuotes[0]), v: null, t: null, c: [] } })), e: wire.questions.map(e => ({ k: e.kind, t: e.topic, s: source(e.sourceQuote), o: e.careOwner })), r: wire.unmapped.map(u => ({ s: u.sourceQuotes.map(source), r: u.reason })), d: wire.sourceDisposition };
}
function fromBridge(wire: BridgeWire, r: Issued): SparseWire {
  if (wire.f.some(f => f.o !== 'patient')) throw new AdaptiveError('sparse-scalar-owner-required');
  const quote = (s: Ref): string => typeof s === 'string' ? r.bank.find(b => b.id === s)!.quote : s.q;
  const facts = (entries: Fact[], attribute: (f: Fact) => string): Report => {
    const sourceQuote = entries.length ? quote(typeof entries[0].s === 'string' || 's' in entries[0].s ? entries[0].s as Ref : entries[0].s.p) : r.context.source.text;
    const report: Report = { sourceQuote, reported: [], exceptions: [], provenance: [] };
    for (const f of entries) {
      const name = attribute(f), ownQuote = quote(typeof f.s === 'string' || 's' in f.s ? f.s as Ref : f.s.p);
      if (f.k === 'k') report.reported.push({ attribute: name, value: f.v! });
      else report.exceptions.push({ attribute: name, kind: Object.keys(exceptionStates).find(k => exceptionStates[k as keyof typeof exceptionStates] === f.k) as ExceptionAttribute['kind'], sourceQuote: ownQuote, ...(f.k === 'r' ? { text: String(f.v) } : {}) });
      if (typeof f.s !== 'string' && !('s' in f.s)) report.provenance.push({ attributes: [name], evidenceQuotes: f.s.e.map(quote), predicateQuote: quote(f.s.p), valueQuote: f.s.v === null ? null : quote(f.s.v), period: f.s.t, correctsSourceIds: f.s.c });
      else if (f.k === 'k' && ownQuote !== sourceQuote) report.provenance.push({ attributes: [name], evidenceQuotes: [ownQuote], predicateQuote: ownQuote, valueQuote: ownQuote, period: null, correctsSourceIds: [] });
    }
    return report;
  };
  const target = (id: string) => r.targets.find(t => t.id === id)!;
  return { manifestId: wire.m, reports: wire.f.map(f => facts([f], f => scalarName(target(f.f)))),
    items: wire.i.map(i => ({ collection: collectionName(target(i.c)), newItem: i.n ? { subject: i.n.s, entity: i.n.e, sourceQuotes: typeof i.n.r === 'string' || 's' in i.n.r ? [quote(i.n.r as Ref)] : i.n.r.e.map(quote) } : null, existingItem: i.x, ...facts(i.f, f => f.f) })),
    finishedLists: wire.c.map(c => ({ collection: collectionName(target(c.f)), sourceQuotes: typeof c.s === 'string' || 's' in c.s ? [quote(c.s as Ref)] : c.s.e.map(quote) })), questions: wire.e.map(e => ({ kind: e.k, topic: e.t, sourceQuote: quote(e.s), careOwner: e.o })), unmapped: wire.r.map(u => ({ sourceQuotes: u.s.map(quote), reason: u.r })), sourceDisposition: wire.d };
}
export function assertSparseShape(raw: unknown, m: SparseManifest) { return trusted(m).schema.parse(raw); }
export function decodeSparseExtraction(raw: unknown, m: SparseManifest) {
  const r = trusted(m), wire = toBridge(r.schema.parse(raw) as SparseWire, r);
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
      const path = `${root.path}[${i.n ? 'new' : existing!.id}].${f.f}`;
      const t = r.targets.find(t => t.topicId === root.topicId && t.collection === root.path && t.path === path);
      if (!t || (i.n ? !t.newItem : t.newItem)) throw new AdaptiveError('sparse-item-slot-mismatch');
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
  const facts = (data: any, topic: string, path: (f: string) => string, child = false): Fact[] => Object.entries(stateNames).flatMap(([k, state]) => (data[state] ?? []).flatMap(([s, fields]: any) => (k === 'k' || k === 'r' ? Object.entries(fields) : fields.map((f: string) => [f, null])).map(([f, v]: any) => ({ f: child ? f : slot(topic, path(f)), k, s: quote(s), v })))) as Fact[];
  const wire: BridgeWire = { m: g.m, f: [], i: [], c: [], e: g.events.map(e => ({ k: e.kind, t: e.topic, s: quote(e.source), o: e.owner })), r: g.residual.map(([s, reason]) => ({ s: s.map(quote), r: reason })), d: g.disposition };
  for (const [id, t] of Object.entries(g.topics)) {
    const o: Owner = Array.isArray(t.owner) ? { s: 'other', e: t.owner[1] } : t.owner;
    wire.f.push(...facts(t, id, f => f).map(f => ({ ...f, o })));
    for (const [c, list] of Object.entries(t.lists ?? {})) {
      wire.f.push(...facts(list, id, f => f).map(f => ({ ...f, o })));
      for (const item of list.items ?? []) {
        const existing = item.existing ? r.existing.find(i => i.alias === item.existing)! : undefined;
        wire.i.push({ c: slot(id, c), n: item.new ? { s: item.new[0], e: item.new[1], r: quote(item.new[2]) } : null, x: item.existing ?? null, f: facts(item, id, f => `${c}[${item.new ? 'new' : existing!.id}].${f}`, true) });
      }
      if (list.closed) wire.c.push({ f: slot(id, c), s: quote(list.closed) });
    }
  }
  const readable = fromBridge(wire, r); decodeSparseExtraction(readable, m); return readable;
}
/** Budget depends on emitted fact/source representation; excludes hidden model reasoning. */
export function sparseOutputBudget(wire: SparseWire) {
  const outputBytes = bytes(wire), facts = wire.reports.reduce((n, report) => n + report.reported.length + report.exceptions.length, 0) + wire.items.reduce((n, item) => n + item.reported.length + item.exceptions.length, 0);
  const conservativeOutputTokens = Math.ceil(outputBytes * 0.5);
  return { outputBytes, facts, conservativeOutputTokens, maxOutputTokens: Math.ceil((conservativeOutputTokens * 1.5 + 256) / 256) * 256, tokenizerVerified: false, providerReasoningTokensKnown: false };
}

/** Preserve the previously reviewed closed object/array schema surface. */
function assertClosedSchema(value: any): void {
  if (!value || typeof value !== 'object') return;
  assert(!('allOf' in value) && !('propertyNames' in value) && !('prefixItems' in value));
  assert(!Array.isArray(value.items));
  if (value.type === 'object') {
    assert.equal(value.additionalProperties, false);
    assert.deepEqual(new Set(value.required), new Set(Object.keys(value.properties)));
  }
  for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(assertClosedSchema); else assertClosedSchema(child);
}
