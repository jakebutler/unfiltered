import { scenarioIds as scenarios } from '../../clinic-content/src/workflows.js';
import { z } from 'zod';
import { representationReviewSchema, validateRepresentationBinding, validateRepresentationDigests, type TrustedRepresentationAuthority } from './representation-review.js';
import { nativeQuestionnaireCaptureSchema, validateNativeQuestionnaireCaptureShape, validateNativeQuestionnaireCapture } from './questionnaire-response.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const reference = (type: string) => z.string().regex(new RegExp(`^${type}/[A-Za-z0-9.-]{1,64}$`));
const text = z.string().min(1).max(12000);
export { scenarioIds as scenarios } from '../../clinic-content/src/workflows.js';
export const clinicalRoles = ['registered-dietitian', 'nurse-practitioner', 'physician-assistant', 'physician'] as const;
export type StaffRole = typeof clinicalRoles[number] | 'administrative';
const sourceSchema = z.object({
  id, patient: reference('Patient'),
  kind: z.enum(['patient-statement', 'patient-correction', 'assistant-statement']),
  text, capturedAt: z.string().datetime(),
  // Absence is retained for legacy sources and their existing confirmation digests.
  channel: z.enum(['text', 'confirmed-transcript', 'unreviewed-transcript']).optional(),
  corrects: id.optional(),
  displayedPromptId: z.string().min(1).max(400).optional(),
  recording: z.object({ reference: reference('DocumentReference'), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() }).strict().optional(),
}).strict();
const answerSchema = z.object({
  questionId: id,
  state: z.enum(['answered', 'negative', 'unknown', 'declined', 'uncertain', 'not-asked', 'conflicting']),
  text: text.optional(), sourceIds: z.array(id).max(600),
}).strict();
const logisticsDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
export const billingLogisticsFields: readonly string[] = ['issueType', 'serviceDate', 'requestedResolution'];
export const schedulingLogisticsFields: readonly string[] = ['intent', 'visitCategory', 'preferredDay', 'preferredWindow', 'requestedDate', 'timezone'];
/** Only approved structured logistics. Clinical text is never copied into this projection. */
export const administrativeLogisticsSchema = z.object({
  kind: z.enum(['billing', 'scheduling', 'other']),
  issueType: z.enum(['bill-question', 'coverage-question', 'payment-question', 'other-request']).optional(),
  serviceDate: logisticsDate.optional(), requestedResolution: z.enum(['explanation', 'review-possible-error', 'payment-options', 'contact-me']).optional(),
  intent: z.enum(['request', 'change', 'cancel']).optional(), visitCategory: z.enum(['first-visit', 'follow-up', 'not-sure']).optional(),
  preferredDay: z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Any day', 'Not sure']).optional(),
  preferredWindow: z.enum(['Morning', 'Afternoon', 'Evening', 'Flexible', 'Not sure']).optional(), requestedDate: logisticsDate.optional(),
  timezone: z.enum(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Other', 'Not sure']).optional(),
}).strict().superRefine((value, context) => {
  for (const field of Object.keys(value).filter(field => field !== 'kind')) if (!(value.kind === 'billing' ? billingLogisticsFields : value.kind === 'scheduling' ? schedulingLogisticsFields : []).includes(field)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'logistics-kind-mismatch', path: [field] });
});
export type AdministrativeLogistics = z.infer<typeof administrativeLogisticsSchema>;
export const submissionSchema = z.object({
  submissionId: id, version: z.number().int().min(1), patient: reference('Patient'),
  scenario: z.enum(scenarios), contentVersion: id,
  questionnaire: z.string().url().max(1000), confirmedAt: z.string().datetime(),
  previous: z.object({ submissionId: id, version: z.number().int().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  completeness: z.enum(['complete', 'partial']),
  administrativeLogistics: administrativeLogisticsSchema.optional(),
  questionnaireCapture: nativeQuestionnaireCaptureSchema.optional(),
  representationReview: representationReviewSchema.optional(),
  sources: z.array(sourceSchema).min(1).max(600), answers: z.array(answerSchema).min(1).max(150),
  work: z.array(z.object({ id, kind: z.enum(['clinical', 'administrative']), responsibility: z.enum(['nutrition', 'medical', 'administrative']), owner: reference('CareTeam') }).strict()).min(1).max(8),
}).strict();
export type Submission = z.infer<typeof submissionSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Answer = z.infer<typeof answerSchema>;
/** Retained raw speech is resolved only by current source-linked explicit confirmation for that exact field. */
export function unresolvedRecognitionSourceIds(sources: readonly Source[], topics: Readonly<Record<string, import('../../clinic-content/src/types.js').TopicResponse | undefined>>): string[] {
  const current = new Map<string, Set<string>>();
  const walk = (topicId: string, answers: import('../../clinic-content/src/types.js').SlotAnswers, prefix = '') => {
    for (const [slot, answer] of Object.entries(answers)) if (answer && answer.state !== 'not-asked') {
      const path = prefix + slot;
      if (answer.state === 'known' && answer.items) for (const item of answer.items) walk(topicId, item.answers, `${path}[${item.id}].`);
      else current.set(`${topicId}:${path}`, new Set(answer.sourceIds));
    }
  };
  for (const [topicId, topic] of Object.entries(topics)) if (topic) walk(topicId, topic.answers);
  return sources.filter(raw => raw.channel === 'unreviewed-transcript' && !sources.some(confirmed => confirmed.channel === 'confirmed-transcript' && Date.parse(confirmed.capturedAt) > Date.parse(raw.capturedAt) && !!raw.displayedPromptId && confirmed.displayedPromptId === raw.displayedPromptId && current.get(raw.displayedPromptId)?.has(confirmed.id))).map(raw => raw.id);
}


/** Reviewed content is supplied by the caller; no proposed clinical wording is embedded. */
export interface ContentContract {
  version: string;
  questionnaire: string;
  approval: { approvedBy: string; approvedAt: string };
  questions: Array<{ id: string; requiredForComplete: boolean; requiresAnsweredValue?: boolean; detailTargets: string[]; stopWhen: Array<'target-met' | 'does-not-know' | 'not-applicable' | 'patient-declines' | 'patient-moves-on' | 'resistance-after-purpose' | 'safety-interruption'> }>;
}
/** Produced by the trusted content evaluator, never accepted as a patient/browser assertion. */
export interface SufficiencyAssessment {
  submissionDigest: string; contentVersion: string; assessedBy: string; assessedAt: string;
  questions: Array<{ questionId: string; targets: Array<{ id: string; state: 'sufficient' | 'unresolved'; sourceIds: string[] }> }>;
}
export interface PatientScope { patient: string; submissionId: string; scenario: Submission['scenario']; }
export class ClinicalError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ClinicalError'; }
}
export const MAX_SUBMISSION_BYTES = 500_000;
const ensure = (condition: unknown, code: string): void => { if (!condition) throw new ClinicalError(code); };

/** Intrinsic source and revision checks also run at the persistence boundary. */
export function validateSubmissionIntegrity(input: unknown, representationAuthority?: TrustedRepresentationAuthority): Submission {
  const result = submissionSchema.safeParse(input);
  if (!result.success) throw new ClinicalError('invalid-submission');
  const s = result.data;
  const nativeReview = validateRepresentationBinding(s, representationAuthority);
  ensure(new TextEncoder().encode(canonicalJson(s)).byteLength <= MAX_SUBMISSION_BYTES, 'submission-too-large');
  ensure(new Set(s.sources.map(x => x.id)).size === s.sources.length, 'duplicate-source');
  ensure(new Set(s.answers.map(x => x.questionId)).size === s.answers.length, 'duplicate-answer');
  ensure(new Set(s.work.map(x => x.id)).size === s.work.length, 'duplicate-work');
  for (const work of s.work) ensure(work.kind === 'administrative' ? work.responsibility === 'administrative' : work.responsibility !== 'administrative', 'invalid-work-responsibility');
  ensure(!s.work.some(work => work.kind === 'administrative') || !!s.administrativeLogistics, 'missing-confirmed-administrative-logistics');
  const sources = new Map(s.sources.map(x => [x.id, x]));
  for (const source of s.sources) {
    ensure(source.patient === s.patient, 'source-patient-mismatch');
    ensure(!source.recording || source.recording.endMs > source.recording.startMs, 'invalid-source-time-range');
    if (source.kind === 'patient-correction') {
      const prior = source.corrects && sources.get(source.corrects);
      ensure(prior && prior.id !== source.id && prior.kind !== 'assistant-statement' && prior.capturedAt < source.capturedAt, 'invalid-correction');
    } else ensure(!source.corrects, 'invalid-correction');
  }
  for (const answer of s.answers) {
    ensure(new Set(answer.sourceIds).size === answer.sourceIds.length, 'duplicate-source-reference');
    ensure(answer.state === 'not-asked' ? answer.sourceIds.length === 0 && answer.text === undefined : answer.sourceIds.length > 0, 'missing-answer-source');
    ensure(!['answered', 'negative', 'uncertain', 'conflicting'].includes(answer.state) || answer.text, 'missing-answer-text');
    for (const sourceId of answer.sourceIds) ensure(sources.has(sourceId) && sources.get(sourceId)?.kind !== 'assistant-statement', 'invalid-answer-source');
  }
  if (s.questionnaireCapture) {
    const capture = validateNativeQuestionnaireCaptureShape(s.questionnaireCapture, new Set(s.sources.filter(source => source.kind !== 'assistant-statement').map(source => source.id)), nativeReview);
    const unreviewed = unresolvedRecognitionSourceIds(s.sources, capture.topics);
    ensure(unreviewed.every(sourceId => capture.unreviewedSourceIds.includes(sourceId)), 'questionnaire-recognition-mismatch');
    const timestamps = new Map(s.sources.filter(source => source.kind !== 'assistant-statement').map(source => [source.id, source.capturedAt]));
    const checkSourceTime = (answers: import('../../clinic-content/src/types.js').SlotAnswers) => {
      for (const [path, answer] of Object.entries(answers)) if (answer?.state === 'known') {
        if (path === 'statedAt' || path.endsWith('.statedAt')) ensure(typeof answer.value === 'string' && answer.sourceIds.length > 0 && answer.sourceIds.every(sourceId => timestamps.get(sourceId) === answer.value), 'questionnaire-source-time-mismatch');
        for (const item of answer.items ?? []) checkSourceTime(item.answers);
      }
    };
    for (const [topicId, topic] of Object.entries(capture.topics)) {
      const checkRecognition = (answers: import('../../clinic-content/src/types.js').SlotAnswers, prefix = '') => { for (const [slot, answer] of Object.entries(answers)) if (answer?.state === 'known') { const path = prefix + slot; ensure(answer.sourceIds.every(sourceId => sources.get(sourceId)?.channel !== 'unreviewed-transcript') || nativeReview?.reviewedFact(topicId, path, answer), 'questionnaire-recognition-mismatch'); for (const item of answer.items ?? []) checkRecognition(item.answers, `${path}[${item.id}].`); } };
      checkRecognition(topic.answers); checkSourceTime(topic.answers);
    }
    for (const entry of capture.inactiveHistory ?? []) checkSourceTime({ [entry.path]: entry.answer });
    ensure(capture.scenario === s.scenario && s.questionnaire === `${capture.definition.canonical}|${capture.definition.version}`, 'questionnaire-binding-mismatch');
  }
  if (s.previous) ensure(s.previous.submissionId === s.submissionId && s.previous.version < s.version, 'invalid-amendment');
  ensure(s.version === 1 ? !s.previous : !!s.previous, 'missing-amendment-link');
  return s;
}

export function validateSubmission(input: unknown, scope: PatientScope, content: ContentContract, assessment?: SufficiencyAssessment, representationAuthority?: TrustedRepresentationAuthority): Submission {
  const s = validateSubmissionIntegrity(input, representationAuthority);
  ensure(s.patient === scope.patient && s.submissionId === scope.submissionId && s.scenario === scope.scenario, 'scope-mismatch');
  ensure(content.approval.approvedBy.trim() && !Number.isNaN(Date.parse(content.approval.approvedAt)), 'content-not-approved');
  ensure(s.contentVersion === content.version && s.questionnaire === content.questionnaire, 'content-version-mismatch');
  ensure(new Set(content.questions.map(q => q.id)).size === content.questions.length, 'duplicate-question-definition');
  ensure(content.questions.every(q => q.detailTargets.length > 0 && new Set(q.detailTargets).size === q.detailTargets.length && q.stopWhen.includes('patient-declines') && q.stopWhen.includes('patient-moves-on') && q.stopWhen.includes('safety-interruption')), 'invalid-content-contract');
  const questions = new Map(content.questions.map(x => [x.id, x]));
  for (const answer of s.answers) ensure(questions.has(answer.questionId), 'unknown-question');
  // Missing, unknown and declined remain different. A partial handoff is always explicit.
  if (assessment) ensure(new TextEncoder().encode(canonicalJson(assessment)).byteLength <= 100_000, 'sufficiency-too-large');
  if (s.completeness === 'complete') {
    for (const q of content.questions.filter(q => q.requiredForComplete)) {
      const answer = s.answers.find(a => a.questionId === q.id);
      ensure(answer && (q.requiresAnsweredValue ? answer.state === 'answered' : ['answered', 'negative'].includes(answer.state)), 'incomplete-required-answer');
    }
    ensure(assessment && assessment.contentVersion === content.version && assessment.assessedBy.trim() && !Number.isNaN(Date.parse(assessment.assessedAt)), 'missing-trusted-sufficiency');
    ensure(new Set(assessment!.questions.map(q => q.questionId)).size === assessment!.questions.length, 'duplicate-sufficiency-question');
    for (const q of content.questions.filter(q => q.requiredForComplete)) {
      const answer = s.answers.find(a => a.questionId === q.id)!;
      const evidence = assessment!.questions.find(a => a.questionId === q.id);
      ensure(evidence && new Set(evidence.targets.map(t => t.id)).size === evidence.targets.length, 'missing-trusted-sufficiency');
      for (const target of q.detailTargets) {
        const detail = evidence!.targets.find(t => t.id === target);
        ensure(detail && detail.state === 'sufficient' && detail.sourceIds.length > 0 && detail.sourceIds.every(sourceId => answer.sourceIds.includes(sourceId)), 'insufficient-required-detail');
      }
    }
  }
  return s;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export interface ConfirmedSubmission { submission: Submission; digest: string; sufficiency?: SufficiencyAssessment; representationAuthority?: TrustedRepresentationAuthority; representationConfirmed?: true; }
/** The digest is the exact confirmation preview value; changed payloads require reconfirmation. */
export async function confirmSubmission(input: unknown, scope: PatientScope, content: ContentContract, previewDigest: string, assessment?: SufficiencyAssessment, representationAuthority?: TrustedRepresentationAuthority): Promise<ConfirmedSubmission> {
  const submission = validateSubmission(input, scope, content, assessment, representationAuthority);
  await validateRepresentationDigests(submission, representationAuthority);
  if (submission.questionnaireCapture) await validateNativeQuestionnaireCapture(submission.questionnaireCapture, new Set(submission.sources.filter(source => source.kind !== 'assistant-statement').map(source => source.id)), validateRepresentationBinding(submission, representationAuthority));
  const actual = await digest(submission);
  ensure(actual === previewDigest, 'confirmation-digest-mismatch');
  if (submission.completeness === 'complete') ensure(assessment?.submissionDigest === actual, 'sufficiency-digest-mismatch');
  return { submission, digest: actual, ...(assessment ? { sufficiency: structuredClone(assessment) } : {}), ...(representationAuthority ? { representationAuthority: structuredClone(representationAuthority) } : {}) };
}

export interface StaffContext {
  /** Trusted server-resolved identity and assignment, never browser role labels. */
  member: string; role: StaffRole; patient: string; assignedCareTeams: string[];
}
export function staffView(s: Submission, staff: StaffContext, representationAuthority?: TrustedRepresentationAuthority) {
  s = validateSubmissionIntegrity(s, representationAuthority);
  ensure(staff.member.trim() && staff.patient === s.patient, 'staff-scope-denied');
  const assigned = s.work.filter(w => staff.assignedCareTeams.includes(w.owner));
  ensure(assigned.length, 'staff-assignment-denied');
  if (clinicalRoles.includes(staff.role as typeof clinicalRoles[number]) && assigned.some(w => w.kind === 'clinical')) {
    return { visibility: 'full-clinical' as const, submission: structuredClone(s) };
  }
  ensure(staff.role === 'administrative' && assigned.some(w => w.kind === 'administrative'), 'staff-role-denied');
  // No transcript, answers, diagnosis, source URL, or clinical work leaks into this projection.
  return { visibility: 'administrative-minimal' as const, submissionId: s.submissionId, version: s.version, patient: s.patient, work: structuredClone(assigned.filter(w => w.kind === 'administrative')) };
}
export interface ReviewAction { member: string; role: StaffRole; at: string; outcome: 'reviewed' | 'needs-information' | 'declined' | 'resolved'; submissionId: string; version: number; digest: string; workId: string; }
export interface OwnWorkReceipt { state: 'own-work-verified'; digest: string; patient: string; workId: string; owner: string; task: string; anchors: { source: string; response: string }; }
export async function recordReview(s: ConfirmedSubmission, staff: StaffContext, workId: string, outcome: ReviewAction['outcome'], at: string, receipt: OwnWorkReceipt): Promise<ReviewAction> {
  s = structuredClone(s);
  ensure(await digest(s.submission) === s.digest, 'confirmation-digest-mismatch');
  ensure(receipt.state === 'own-work-verified' && receipt.digest === s.digest && receipt.patient === s.submission.patient && receipt.workId === workId && /^Task\/[A-Za-z0-9.-]+$/.test(receipt.task) && /^DocumentReference\/[A-Za-z0-9.-]+(?:\/_history\/[A-Za-z0-9.-]+)?$/.test(receipt.anchors.source) && /^QuestionnaireResponse\/[A-Za-z0-9.-]+(?:\/_history\/[A-Za-z0-9.-]+)?$/.test(receipt.anchors.response), 'review-requires-receipt');
  staffView(s.submission, staff, s.representationAuthority);
  const work = s.submission.work.find(w => w.id === workId && staff.assignedCareTeams.includes(w.owner));
  ensure(work && receipt.owner === work.owner, 'review-requires-receipt');
  ensure(work && (work.responsibility === 'administrative' ? staff.role === 'administrative' : work.responsibility === 'nutrition' ? staff.role === 'registered-dietitian' : ['nurse-practitioner', 'physician-assistant', 'physician'].includes(staff.role)), 'review-work-denied');
  ensure(!Number.isNaN(Date.parse(at)), 'invalid-review-time');
  ensure(['reviewed', 'needs-information', 'declined', 'resolved'].includes(outcome), 'invalid-review-outcome');
  return { member: staff.member, role: staff.role, at, outcome, submissionId: s.submission.submissionId, version: s.submission.version, digest: s.digest, workId };
}
