import { z } from 'zod';
import { nativeCanonicalJson, nativeResolveSlot, nativeTopics, type NativeQuestionnaireCapture, type NativeRepresentationAuthority } from '../../clinic-content/src/native-questionnaire.js';
import { nativeSlotAnswerSchema } from './questionnaire-response.js';
import type { Source, Submission } from './domain.js';

export const REPRESENTATION_POLICY = 'patient-fact-representation-v2' as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const qualificationSchema = z.object({ policy: z.string(), schema: z.string(), normalization: z.string(), catalog: z.string(), projection: z.string(), status: z.literal('qualified'), evidenceDigest: hash }).strict();
export type RepresentationQualification = z.infer<typeof qualificationSchema>;
export const representationFactSchema = z.object({
  topicId: z.string().min(1).max(40), path: z.string().min(1).max(300), answer: nativeSlotAnswerSchema,
  evidence: z.array(z.object({ sourceId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(), sourceDigest: hash }).strict()).min(1).max(256),
  claimIds: z.array(hash).max(64), correctsSourceIds: z.array(z.string()).max(600),
  origin: z.enum(['claim', 'collection', 'derived-source-time', 'native-reuse']),
}).strict();
export type RepresentationFact = z.infer<typeof representationFactSchema>;
export const representationReviewSchema = z.object({
  policy: z.literal(REPRESENTATION_POLICY), digest: hash,
  patient: z.string(), submissionId: z.string(), version: z.number().int().positive(), contentVersion: z.string(),
  nativeDefinition: z.object({ canonical: z.string(), version: z.string(), digest: hash }).strict(),
  qualification: qualificationSchema, representationQualification: z.object({ policy: z.literal(REPRESENTATION_POLICY), status: z.literal('qualified'), evidenceDigest: hash, extractionSchema:z.literal('turn-bound-typed-v1').optional() }).strict(), captureDigest: hash, sourceInventoryDigest: hash,
  facts: z.array(representationFactSchema).min(1).max(1500), accountedSourceIds: z.array(z.string()).max(600),
}).strict();
export type RepresentationReview = z.infer<typeof representationReviewSchema>;
/** Caller-owned expected server projection and independently qualified policy.
 * Never construct this authority by copying submitted review metadata. */
export interface TrustedRepresentationAuthority { expected: RepresentationReview; qualification: RepresentationQualification; representationQualification: RepresentationReview['representationQualification']; }
export async function representationDigest(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nativeCanonicalJson(value))))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const captureWithoutReviewBinding = (capture: NativeQuestionnaireCapture) => { const value = structuredClone(capture); delete value.reviewBinding; return value; };
export function nativeRepresentationAuthority(authority: TrustedRepresentationAuthority): NativeRepresentationAuthority {
  const record = authority.expected;
  return { binding: record.digest,
    reviewedFact: (topicId, path, answer) => record.facts.some(fact => fact.topicId === topicId && fact.path === path && nativeCanonicalJson(fact.answer) === nativeCanonicalJson(answer)),
    reviewedSourceAccountedFor: sourceId => record.accountedSourceIds.includes(sourceId),
  };
}
/** Intrinsic checks require an independent expected record before allowing any raw-speech fact. */
export function validateRepresentationBinding(s: Submission, authority?: TrustedRepresentationAuthority): NativeRepresentationAuthority | undefined {
  if (!s.representationReview) {
    if (s.questionnaireCapture?.reviewBinding) throw new Error('representation-review-missing');
    return;
  }
  const r = s.representationReview;
  if (!authority || nativeCanonicalJson(r) !== nativeCanonicalJson(authority.expected) || nativeCanonicalJson(r.qualification) !== nativeCanonicalJson(authority.qualification) || nativeCanonicalJson(r.representationQualification) !== nativeCanonicalJson(authority.representationQualification)
    || r.patient !== s.patient || r.submissionId !== s.submissionId || r.version !== s.version || r.contentVersion !== s.contentVersion
    || !s.questionnaireCapture || nativeCanonicalJson(r.nativeDefinition) !== nativeCanonicalJson(s.questionnaireCapture.definition) || s.questionnaireCapture.reviewBinding !== r.digest)
    throw new Error('representation-authority-mismatch');
  const keys = r.facts.map(f => `${f.topicId}:${f.path}`);
  if (new Set(keys).size !== keys.length || new Set(r.accountedSourceIds).size !== r.accountedSourceIds.length) throw new Error('representation-duplicate-fact');
  const sourceMap = new Map(s.sources.map(source => [source.id, source]));
  for (const fact of r.facts) {
    let current; try { current = nativeResolveSlot(nativeTopics().find(t => t.id === fact.topicId)!, s.questionnaireCapture.topics[fact.topicId], fact.path).answer; } catch { throw new Error('representation-fact-mismatch'); }
    if (nativeCanonicalJson(current) !== nativeCanonicalJson(fact.answer)) throw new Error('representation-fact-mismatch');
    if (/^MH0[1-4]$/.test(fact.path) || fact.answer.state === 'conflicting' || fact.answer.state === 'not-asked' || !fact.answer.sourceIds?.length) throw new Error('representation-ineligible-fact');
    for (const span of fact.evidence) {
      const source = sourceMap.get(span.sourceId);
      if (!source || source.kind === 'assistant-statement' || span.end <= span.start || span.end > source.text.length) throw new Error('representation-evidence-mismatch');
    }
    if (!fact.answer.sourceIds.every(id => fact.evidence.some(span => span.sourceId === id))) throw new Error('representation-evidence-mismatch');
  }
  if (!r.accountedSourceIds.every(id => sourceMap.get(id)?.channel === 'unreviewed-transcript')) throw new Error('representation-source-mismatch');
  return nativeRepresentationAuthority(authority);
}
export async function validateRepresentationDigests(s: Submission, authority?: TrustedRepresentationAuthority): Promise<void> {
  validateRepresentationBinding(s, authority);
  const r = s.representationReview; if (!r) return;
  const { digest, ...rest } = r;
  if (await representationDigest(rest) !== digest || await representationDigest(captureWithoutReviewBinding(s.questionnaireCapture!)) !== r.captureDigest || await representationDigest(s.sources) !== r.sourceInventoryDigest) throw new Error('representation-digest-mismatch');
  for (const fact of r.facts) for (const span of fact.evidence) if (await representationDigest(s.sources.find(source => source.id === span.sourceId)) !== span.sourceDigest) throw new Error('representation-source-digest-mismatch');
}
export async function sourceDigestMap(sources: readonly Source[]) { return new Map(await Promise.all(sources.map(async source => [source.id, await representationDigest(source)] as const))); }
