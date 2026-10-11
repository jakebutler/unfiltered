import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { ActionFirstObjectDecoder } from '../../clinical-core/src/action-first-object.js';
import { digitalOceanStream, DigitalOceanStreamFailure, fullStreamLimits } from '../../clinical-core/src/digitalocean-stream.js';
import type { DigitalOceanConfig, InferenceMessage } from '../../clinical-core/src/digitalocean.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import { AdaptiveError } from './adaptive-validation.js';
import { assertFullReplyManifest, validateFullAdvance, validateFullDraft, type FullReplyDraft, type FullReplyManifest } from './adaptive-reply-full.js';
import type { AdaptiveStreamProposer } from './adaptive-stream-session.js';
import type { SourceAddress } from './adaptive-reply.js';

export const fullCompactProtocol = 'adaptive-reply-full-compact-v2';
export const fullCompactSchemaName = 'adaptive_reply_full_compact_v2';
export const fullCompactValidationRevision = 'full-compact-source-shape-v2';
const states = { k: 'known', n: 'negative', u: 'unknown', d: 'declined', c: 'uncertain', x: 'not-applicable' } as const;
const subjects = { p: 'patient', o: 'other', u: 'unclear' } as const;
const acts = { a: 'answer', q: 'question', c: 'correction', m: 'move-on', t: 'topic-switch', u: 'unclear' } as const;
const reasons = { a: 'ambiguous', u: 'unsupported-target', c: 'capacity', f: 'conflict', r: 'recognition-unreviewed' } as const;
const ref = z.number().int().min(0).max(559), refs = z.array(ref).min(1).max(4);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/), target = z.string().min(1).max(80);
const value = z.union([z.string().min(1).max(8000), z.number().finite(), z.strictObject({ feet: z.number().int().nonnegative(), inches: z.number().nonnegative().lt(12) }), z.null()]);
const schema = z.strictObject({ m: z.string().regex(/^[a-f0-9]{24}$/),
  a: z.array(z.strictObject({ s: z.string().min(1).max(160), q: z.string().min(1).max(8000) })).max(560),
  c: z.array(z.strictObject({ t: target, j: key.nullable(), k: z.enum(['k','n','u','d','c','x']), v: value, x: ref.nullable(), e: refs,
    o: z.enum(['p','o','u']), n: z.string().min(1).max(300).nullable(), p: z.string().min(1).max(300).nullable(), f: ref, r: z.array(z.string().min(1).max(160)).max(8) })).max(64),
  i: z.array(z.strictObject({ t: target, k: key, n: z.string().min(1).max(300), e: refs })).max(16),
  l: z.array(z.strictObject({ t: target, e: refs })).max(16),
  s: z.array(z.strictObject({ k: z.enum(['a','q','c','m','t','u']), t: z.string().min(1).max(40).nullable(), r: z.null(), e: refs })).max(4),
  g: z.array(z.strictObject({ e: refs, r: z.enum(['a','u','c','f','r']) })).max(8), d: z.enum(['r','p']) });
export type FullCompactDraft = z.infer<typeof schema>;
export interface FullCompactManifest { readonly protocol: typeof fullCompactProtocol; readonly id: string; readonly sha256: string;
  readonly messages: readonly InferenceMessage[]; readonly jsonSchema: Record<string, unknown> }
const hash = (input: unknown) => createHash('sha256').update(canonicalJson(input)).digest('hex');
const issued = new WeakMap<FullCompactManifest, { full: FullReplyManifest; signature: string; schema: z.ZodType<FullCompactDraft> }>();
const exactEnum = (values: string[]) => values.length ? z.enum(values as [string,...string[]]) : z.never();
export function createFullCompactManifest(full: FullReplyManifest): FullCompactManifest {
  assertFullReplyManifest(full);
  const payload = JSON.parse(String(full.messages[1].content)) as { statements: { id: string }[] };
  const collections = full.targets.filter(target => target.kind === 'collection').map(target => target.id);
  const constrained = schema.extend({ m: z.literal(full.id), a: z.array(schema.shape.a.element.extend({ s: exactEnum(payload.statements.map(statement => statement.id)) })).max(560),
    c: z.array(schema.shape.c.element.extend({ t: exactEnum(full.targets.map(target => target.id)) })).max(64),
    i: z.array(schema.shape.i.element.extend({ t: exactEnum(collections) })).max(16), l: z.array(schema.shape.l.element.extend({ t: exactEnum(collections) })).max(16) });
  const old = full.jsonSchema as { properties: { advance: unknown } };
  const jsonSchema = { ...full.jsonSchema, properties: { advance: old.properties.advance, draft: z.toJSONSchema(constrained, { target: 'draft-7' }) } };
  const mapping = 'Only draft uses compact keys: m=manifestId; a=unique exact quote anchors {s:statementId,q:quote}; c=claims {t:targetId,j:itemKey or null,k:state,v:value,x:valueEvidence anchor or null,e:evidence anchors,o:subject,n:entity or null,p:period or null,f:predicate anchor,r:correctsSourceIds}; i=items {t:collectionId,k:key,n:entity,e:evidence anchors}; l=closures {t:collectionId,e:evidence anchors}; s=acts {k:kind,t:targetTopicId or null,r:replyId null,e:evidence anchors}; g=residual {e:evidence anchors,r:reason}; d=sourceDisposition. State k/n/u/d/c/x=known/negative/unknown/declined/uncertain/not-applicable; subject p/o/u=patient/other/unclear; act a/q/c/m/t/u=answer/question/correction/move-on/topic-switch/unclear; reason a/u/c/f/r=ambiguous/unsupported-target/capacity/conflict/recognition-unreviewed; disposition r/p=represented/partially-represented. Reuse anchors by zero-based index, each referenced at least once. Preserve every semantic and evidence field. advance remains unchanged and comes first.';
  const messages: InferenceMessage[] = full.messages.map((message,index) => {
    const content = index === 0 ? message.content + '\n' + mapping : message.content;
    if (typeof content !== 'string' || content.length <= 32000) return { ...message, content };
    // Preserve the complete source/catalog JSON using the transport's existing
    // bounded text-part representation. Do not widen legacy message limits.
    if (content.length > 64000) throw new AdaptiveError('full-stream-message-too-large');
    const parts: { type: 'text'; text: string }[] = [];
    for (let start = 0; start < content.length;) {
      let end = Math.min(content.length,start + 16000);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end-1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
      parts.push({ type: 'text', text: content.slice(start,end) }); start = end;
    }
    if (parts.length > 4) throw new AdaptiveError('full-stream-message-too-large');
    return { ...message, content: parts };
  });
  const manifest: FullCompactManifest = Object.freeze({ protocol: fullCompactProtocol, id: full.id, sha256: hash({ full: full.sha256, jsonSchema, messages }), jsonSchema, messages });
  issued.set(manifest, { full, signature: hash(manifest), schema: constrained }); return manifest;
}
function trusted(manifest: FullCompactManifest) {
  const record = issued.get(manifest); if (!record || record.signature !== hash(manifest)) throw new AdaptiveError('unissued-or-mutated-full-compact-manifest');
  assertFullReplyManifest(record.full); return record;
}
export function decodeFullCompactDraft(raw: unknown): FullReplyDraft {
  const draft = schema.parse(raw), used = new Set<number>(), unique = new Set<string>();
  const anchors = draft.a.map(anchor => { const id = canonicalJson(anchor); if (unique.has(id)) throw new AdaptiveError('duplicate-full-compact-anchor'); unique.add(id); return { statementId: anchor.s, quote: anchor.q }; });
  const address = (index: number): SourceAddress => { if (!anchors[index]) throw new AdaptiveError('invalid-full-compact-reference'); used.add(index); return anchors[index]; };
  const expanded: FullReplyDraft = { manifestId: draft.m,
    claims: draft.c.map(claim => ({ targetId: claim.t, itemKey: claim.j, state: states[claim.k], value: claim.v, valueEvidence: claim.x === null ? null : address(claim.x), evidence: claim.e.map(address), scope: { subject: subjects[claim.o], entity: claim.n, period: claim.p, predicate: address(claim.f) }, correctsSourceIds: claim.r })),
    items: draft.i.map(item => ({ collectionId: item.t, key: item.k, entity: item.n, evidence: item.e.map(address) })), closures: draft.l.map(closure => ({ collectionId: closure.t, evidence: closure.e.map(address) })),
    acts: draft.s.map(act => ({ kind: acts[act.k], targetTopicId: act.t, replyId: act.r, evidence: act.e.map(address) })), residual: draft.g.map(gap => ({ reason: reasons[gap.r], evidence: gap.e.map(address) })), sourceDisposition: draft.d === 'r' ? 'represented' : 'partially-represented' };
  if (used.size !== anchors.length) throw new AdaptiveError('unused-full-compact-anchor'); return expanded;
}
/** Offline serializer for labelled representatives, not model extraction. */
export function encodeFullCompactDraft(draft: FullReplyDraft): FullCompactDraft {
  const anchors: FullCompactDraft['a'] = [], index = new Map<string,number>();
  const address = (anchor: SourceAddress) => { const id = canonicalJson(anchor); if (!index.has(id)) { index.set(id,anchors.length); anchors.push({ s: anchor.statementId, q: anchor.quote }); } return index.get(id)!; };
  const code = <T extends Record<string,string>>(table: T, value: string) => Object.keys(table).find(key => table[key] === value) as keyof T;
  return schema.parse({ m: draft.manifestId, a: anchors,
    c: draft.claims.map(claim => ({ t: claim.targetId, j: claim.itemKey, k: code(states,claim.state), v: claim.value, x: claim.valueEvidence === null ? null : address(claim.valueEvidence), e: claim.evidence.map(address), o: code(subjects,claim.scope.subject), n: claim.scope.entity, p: claim.scope.period, f: address(claim.scope.predicate), r: claim.correctsSourceIds })),
    i: draft.items.map(item => ({ t: item.collectionId, k: item.key, n: item.entity, e: item.evidence.map(address) })), l: draft.closures.map(closure => ({ t: closure.collectionId, e: closure.evidence.map(address) })),
    s: draft.acts.map(act => ({ k: code(acts,act.kind), t: act.targetTopicId, r: act.replyId, e: act.evidence.map(address) })), g: draft.residual.map(gap => ({ e: gap.evidence.map(address), r: code(reasons,gap.reason) })), d: draft.sourceDisposition === 'represented' ? 'r' : 'p' });
}
export async function consumeFullCompactStream(config: Omit<DigitalOceanConfig,'responseFormat'>, manifest: FullCompactManifest,
  options: { fetcher?: Fetch; signal?: AbortSignal; onAdvance?: (packet: ReturnType<typeof validateFullAdvance>) => void | Promise<void>; onSyntheticContent?: (text: string) => void; now?: () => number } = {}) {
  const record = trusted(manifest), decoder = new ActionFirstObjectDecoder();
  let advance: ReturnType<typeof validateFullAdvance> | undefined, draft: FullReplyDraft | undefined;
  const result = await digitalOceanStream({ ...config, responseFormat: { type: 'json-schema', name: fullCompactSchemaName, schema: manifest.jsonSchema } },options.fetcher,options.now,fullStreamLimits(config.maxOutputTokens)).generate([...manifest.messages], { signal: options.signal, onContent: async text => {
    options.onSyntheticContent?.(text);
    for (const packet of decoder.feed(text)) { trusted(manifest);
      if (packet.kind === 'advance') { advance = validateFullAdvance(packet.value,record.full); await options.onAdvance?.(advance); }
      else draft = validateFullDraft(decodeFullCompactDraft(record.schema.parse(packet.value)),record.full);
    }
  } });
  try { decoder.finish(); } catch (error) { throw new DigitalOceanStreamFailure(error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'incomplete-full-compact-tail', { ...result.receipt, outcome: 'rejected' }); }
  if (!advance || !draft) throw new DigitalOceanStreamFailure('incomplete-full-compact-tail', { ...result.receipt, outcome: 'rejected' });
  return { advance, draft, rawOutput: result.text, admission: 'unqualified-provisional' as const, receipt: result.receipt, validationRevision: fullCompactValidationRevision };
}
/** Explicit dependency injection only: no environment/configuration activation. */
export function fullCompactStreamProposer(config: Omit<DigitalOceanConfig,'responseFormat'>, options: { fetcher?: Fetch; now?: () => number } = {}): AdaptiveStreamProposer {
  return { async propose(context, manifest, run) {
    if (manifest.protocol !== 'adaptive-reply-full-v2') throw new AdaptiveError('full-stream-manifest-required');
    assertFullReplyManifest(manifest,context);
    return consumeFullCompactStream(config,createFullCompactManifest(manifest), { ...options, ...run });
  } };
}
