import { confirmSubmission, digest, type ContentContract, type Submission, type SufficiencyAssessment } from '../../packages/clinical-core/src/domain.js';

/** Technical fixture only. This content is not the clinical question register or an SME approval. */
export const fixtureContent: ContentContract = {
  version: 'qualification-v1', questionnaire: 'https://corvo.example/Questionnaire/qualification-v1',
  approval: { approvedBy: 'technical-fixture-only', approvedAt: '2026-10-09T00:00:00Z' },
  questions: [
    { id: 'height', requiredForComplete: true, requiresAnsweredValue: true, detailTargets: ['value', 'unit'], stopWhen: ['target-met', 'does-not-know', 'patient-declines', 'patient-moves-on', 'safety-interruption'] },
    { id: 'weight', requiredForComplete: true, requiresAnsweredValue: true, detailTargets: ['value', 'unit'], stopWhen: ['target-met', 'does-not-know', 'patient-declines', 'patient-moves-on', 'safety-interruption'] },
  ],
};
export async function fixture(patient = 'Patient/synthetic', careTeam = 'CareTeam/synthetic', submissionId = `qualification-${crypto.randomUUID()}`) {
  const submission: Submission = {
    submissionId, version: 1, patient, scenario: 'first-intake', contentVersion: fixtureContent.version, questionnaire: fixtureContent.questionnaire,
    confirmedAt: '2026-10-09T01:00:00Z', completeness: 'complete',
    sources: [
      { id: 'turn-height', patient, kind: 'patient-statement', text: 'My height is 170 cm.', capturedAt: '2026-10-09T00:00:01Z' },
      { id: 'turn-weight', patient, kind: 'patient-statement', text: 'My weight is 80 kg.', capturedAt: '2026-10-09T00:00:02Z' },
    ],
    answers: [
      { questionId: 'height', state: 'answered', text: '170 cm (patient reported)', sourceIds: ['turn-height'] },
      { questionId: 'weight', state: 'answered', text: '80 kg (patient reported)', sourceIds: ['turn-weight'] },
    ],
    work: [{ id: 'intake', kind: 'clinical', responsibility: 'medical', owner: careTeam }],
  };
  return confirmSubmission(submission, { patient, submissionId, scenario: submission.scenario }, fixtureContent, await digest(submission), await fixtureSufficiency(submission));
}

/** Only used for known technical fixtures. A clinical evaluator must assess actual content. */
export async function fixtureSufficiency(s: Submission): Promise<SufficiencyAssessment> {
  return { submissionDigest: await digest(s), contentVersion: fixtureContent.version, assessedBy: 'technical-fixture-only', assessedAt: '2026-10-09T01:00:00Z', questions: s.answers.map(a => ({ questionId: a.questionId, targets: ['value', 'unit'].map(id => ({ id, state: 'sufficient', sourceIds: a.sourceIds })) })) };
}
