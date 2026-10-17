import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { ActionFirstObjectDecoder } from '../../clinical-core/src/action-first-object.js';
import { digitalOceanStream, DigitalOceanStreamFailure } from '../../clinical-core/src/digitalocean-stream.js';
import type { DigitalOceanConfig, InferenceMessage } from '../../clinical-core/src/digitalocean.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import { AdaptiveError, type AdaptiveContext } from './adaptive-validation.js';
import { createReplyDraftManifest, validateReplyAdvance, validateReplyDraft, type ReplyDraft, type ReplyDraftManifest, type SourceAddress } from './adaptive-reply.js';
export const compactReplyProtocol = 'adaptive-reply-draft-compact-v1';
export const compactReplySchemaName = 'adaptive_reply_draft_compact_v1';
export const compactReplyValidationRevision = 'stream-compact-source-shape-v1';
/** Synthetic qualification diagnostics only; failed bytes never become claims. */
export function createSyntheticPartialCapture(maximumBytes = 8192) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8192) throw new AdaptiveError('invalid-synthetic-evidence-cap');
  let utf8 = '', bytes = 0, truncated = false;
  return { append(text: string) {
    if (truncated) return;
    for (const char of text) { const size = new TextEncoder().encode(char).byteLength; if (bytes + size > maximumBytes) { truncated = true; break; } utf8 += char; bytes += size; }
  }, snapshot: () => ({ syntheticOnly: true as const, utf8, bytes, capBytes: maximumBytes, truncated, admissible: false as const }) };
}
const states = { k: 'known', n: 'negative', u: 'unknown', d: 'declined', c: 'uncertain', x: 'not-applicable' } as const;
const acts = { a: 'answer', q: 'question', c: 'correction', m: 'move-on', t: 'topic-switch', u: 'unclear' } as const;
const reasons = { a: 'ambiguous', u: 'unsupported-target', c: 'capacity', f: 'conflict', r: 'recognition-unreviewed' } as const;
const subjects = { p: 'patient', o: 'other', u: 'unclear' } as const;
const ref = z.number().int().min(0).max(239), refs = z.array(ref).min(1).max(4);
const value = z.union([z.string().min(1).max(8000), z.number().finite(), z.strictObject({ feet: z.number().int().nonnegative(), inches: z.number().nonnegative().lt(12) }), z.null()]);
const compactDraftSchema = z.strictObject({
  m: z.string().regex(/^[a-f0-9]{24}$/),
  a: z.array(z.strictObject({ s: z.string().min(1).max(160), q: z.string().min(1).max(8000) })).max(240),
  c: z.array(z.strictObject({ t: z.string().min(1).max(80), k: z.enum(['k', 'n', 'u', 'd', 'c', 'x']), v: value, x: ref.nullable(), e: refs,
    o: z.enum(['p', 'o', 'u']), n: z.string().min(1).max(300).nullable(), p: z.string().min(1).max(300).nullable(), f: ref, r: z.array(z.string().min(1).max(160)).max(8) })).max(32),
  s: z.array(z.strictObject({ k: z.enum(['a', 'q', 'c', 'm', 't', 'u']), t: z.string().min(1).max(40).nullable(), r: z.null(), e: refs })).max(4),
  g: z.array(z.strictObject({ e: refs, r: z.enum(['a', 'u', 'c', 'f', 'r']) })).max(8),
  d: z.enum(['r', 'p']),
});
/** Only wire aliases and quotation references change; internal claim semantics are unchanged. */
export type CompactReplyDraft = z.infer<typeof compactDraftSchema>;
export interface CompactReplyManifest extends ReplyDraftManifest { readonly compactProtocol: typeof compactReplyProtocol }
const issued = new WeakMap<CompactReplyManifest, { expanded: ReplyDraftManifest; schema: z.ZodType<CompactReplyDraft>; signature: string; context: AdaptiveContext; contextSignature: string }>();
const hash = (input: unknown) => createHash('sha256').update(canonicalJson(input)).digest('hex');
const exactEnum = (values: string[]) => values.length ? z.enum(values as [string, ...string[]]) : z.never();
export function createCompactReplyManifest(context: AdaptiveContext, options: { replyPolicy?: 'supplied-response-v1' } = {}): CompactReplyManifest {
  const expanded = createReplyDraftManifest(context, options);
  const old = expanded.jsonSchema as any;
  const fields = old.properties.draft.properties;
  const targets = fields.claims.items.properties.targetId.enum as string[];
  const sourceIds = fields.claims.items.properties.evidence.items.properties.statementId.enum as string[];
  const topics = fields.acts.items.properties.targetTopicId.anyOf[0].enum as string[];
  const schema = compactDraftSchema.extend({ m: z.literal(expanded.id), a: z.array(compactDraftSchema.shape.a.element.extend({ s: exactEnum(sourceIds) })).max(240),
    c: z.array(compactDraftSchema.shape.c.element.extend({ t: exactEnum(targets) })).max(32),
    s: z.array(compactDraftSchema.shape.s.element.extend({ t: exactEnum(topics).nullable() })).max(4) });
  // Reuse the exact action-prefix schema and issued local actions from AS1.
  const jsonSchema = { ...old, properties: { advance: old.properties.advance, draft: z.toJSONSchema(schema, { target: 'draft-7' }) } };
  const mapping = 'The draft uses compact wire fields only: m=manifestId; a=anchor table of {s:statementId,q:exact unique quote}; c=claims {t:targetId,k:state,v:value,x:valueEvidence anchor or null,e:evidence anchors,o:subject,n:entity,p:period,f:predicate anchor,r:correctsSourceIds}; s=acts {k:kind,t:targetTopicId,r:replyId,e:evidence anchors}; g=residual {e:evidence anchors,r:reason}; d=sourceDisposition. State k/n/u/d/c/x means known/negative/unknown/declined/uncertain/not-applicable; subject p/o/u means patient/other/unclear; act a/q/c/m/t/u means answer/question/correction/move-on/topic-switch/unclear; reason a/u/c/f/r means ambiguous/unsupported-target/capacity/conflict/recognition-unreviewed; disposition r/p means represented/partially-represented. Reuse each exact anchor once, refer to its zero-based index. Every anchor must be referenced. Do not drop scope, corrections or unresolved source to shorten output. advance remains unchanged.';
  const messages: InferenceMessage[] = expanded.messages.map((message, index) => index === 0 ? { ...message, content: message.content + '\n' + mapping } : message);
  const manifest = Object.freeze({ ...expanded, compactProtocol: compactReplyProtocol, jsonSchema, messages, sha256: hash({ expanded: expanded.sha256, jsonSchema, mapping }) });
  issued.set(manifest, { expanded, schema, signature: hash(manifest), context, contextSignature: hash(context) }); return manifest;
}
function trusted(manifest: CompactReplyManifest) {
  const record = issued.get(manifest);
  if (!record || hash(manifest) !== record.signature) throw new AdaptiveError('unissued-or-mutated-compact-manifest');
  if (hash(record.context) !== record.contextSignature) throw new AdaptiveError('unissued-or-stale-reply-manifest');
  // Original validators also bind the context and all source/action authority.
  return record;
}
export function decodeCompactDraft(raw: unknown): ReplyDraft {
  const draft = compactDraftSchema.parse(raw), used = new Set<number>(), unique = new Set<string>();
  const anchors = draft.a.map(anchor => {
    const key = canonicalJson(anchor); if (unique.has(key)) throw new AdaptiveError('duplicate-compact-anchor'); unique.add(key);
    return { statementId: anchor.s, quote: anchor.q };
  });
  const address = (index: number): SourceAddress => { if (!anchors[index]) throw new AdaptiveError('invalid-compact-reference'); used.add(index); return anchors[index]; };
  const expanded: ReplyDraft = {
    manifestId: draft.m,
    claims: draft.c.map(claim => ({ targetId: claim.t, state: states[claim.k], value: claim.v, valueEvidence: claim.x === null ? null : address(claim.x), evidence: claim.e.map(address), scope: { subject: subjects[claim.o], entity: claim.n, period: claim.p, predicate: address(claim.f) }, correctsSourceIds: claim.r })),
    acts: draft.s.map(act => ({ kind: acts[act.k], targetTopicId: act.t, replyId: act.r, evidence: act.e.map(address) })),
    residual: draft.g.map(gap => ({ evidence: gap.e.map(address), reason: reasons[gap.r] })),
    sourceDisposition: draft.d === 'r' ? 'represented' : 'partially-represented',
  };
  if (used.size !== anchors.length) throw new AdaptiveError('unused-compact-anchor'); return expanded;
}
/** Offline representative serializer; no model proposal or semantic admission is invented here. */
export function encodeCompactDraft(draft: ReplyDraft): CompactReplyDraft {
  const anchors: CompactReplyDraft['a'] = [], index = new Map<string, number>();
  const address = (anchor: SourceAddress) => { const key = canonicalJson(anchor); if (!index.has(key)) { index.set(key, anchors.length); anchors.push({ s: anchor.statementId, q: anchor.quote }); } return index.get(key)!; };
  const code = <T extends Record<string, string>>(table: T, item: string) => Object.keys(table).find(key => table[key] === item) as keyof T;
  return compactDraftSchema.parse({ m: draft.manifestId, a: anchors,
    c: draft.claims.map(claim => ({ t: claim.targetId, k: code(states, claim.state), v: claim.value, x: claim.valueEvidence === null ? null : address(claim.valueEvidence), e: claim.evidence.map(address), o: code(subjects, claim.scope.subject), n: claim.scope.entity, p: claim.scope.period, f: address(claim.scope.predicate), r: claim.correctsSourceIds })),
    s: draft.acts.map(act => ({ k: code(acts, act.kind), t: act.targetTopicId, r: act.replyId, e: act.evidence.map(address) })),
    g: draft.residual.map(gap => ({ e: gap.evidence.map(address), r: code(reasons, gap.reason) })), d: draft.sourceDisposition === 'represented' ? 'r' : 'p',
  });
}
export async function consumeCompactReplyStream(config: Omit<DigitalOceanConfig, 'responseFormat'>, manifest: CompactReplyManifest,
  options: { fetcher?: Fetch; signal?: AbortSignal; onAdvance?: (packet: ReturnType<typeof validateReplyAdvance>) => void | Promise<void>; onSyntheticContent?: (text: string) => void; now?: () => number } = {}) {
  const record = trusted(manifest), decoder = new ActionFirstObjectDecoder();
  let advance: ReturnType<typeof validateReplyAdvance> | undefined, draft: ReturnType<typeof validateReplyDraft> | undefined;
  const result = await digitalOceanStream({ ...config, responseFormat: { type: 'json-schema', name: compactReplySchemaName, schema: manifest.jsonSchema } }, options.fetcher, options.now).generate([...manifest.messages], {
    signal: options.signal, onContent: async text => {
      options.onSyntheticContent?.(text);
      for (const packet of decoder.feed(text)) {
        trusted(manifest);
        if (packet.kind === 'advance') { advance = validateReplyAdvance(packet.value, record.expanded); await options.onAdvance?.(advance); }
        else { const wire = record.schema.parse(packet.value); draft = validateReplyDraft(decodeCompactDraft(wire), record.expanded); }
      }
    },
  });
  try { decoder.finish(); } catch (error) { throw new DigitalOceanStreamFailure(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'incomplete-compact-tail', { ...result.receipt, outcome: 'rejected' }); }
  if (!advance || !draft) throw new AdaptiveError('incomplete-compact-tail');
  return { advance, ...draft, compactValidationRevision: compactReplyValidationRevision, receipt: result.receipt };
}
