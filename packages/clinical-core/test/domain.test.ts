import { describe, expect, it } from 'vitest';
import { canonicalJson, clinicalRoles, confirmSubmission, digest, recordReview, staffView, validateSubmission, type OwnWorkReceipt, type StaffContext } from '../src/domain.js';
import { fixture, fixtureContent, fixtureSufficiency } from '../../../scripts/qualification/fixture.js';

const scope = (s: Awaited<ReturnType<typeof fixture>>['submission']) => ({ patient: s.patient, submissionId: s.submissionId, scenario: s.scenario });
describe('confirmed clinical domain', () => {
  it('canonicalizes object keys while preserving order, negation and Unicode', async () => {
    expect(canonicalJson({ z: 1, a: ['é', 'no'] })).toBe('{"a":["é","no"],"z":1}');
    expect(await digest({ a: 'no', b: 1 })).toBe(await digest({ b: 1, a: 'no' }));
    expect(await digest({ a: 'no' })).not.toBe(await digest({ a: 'unknown' }));
  });
  it('binds patient, scenario, submitted version and exact preview digest', async () => {
    const f = await fixture();
    expect(() => validateSubmission(f.submission, { ...scope(f.submission), patient: 'Patient/other' }, fixtureContent)).toThrow('scope-mismatch');
    f.submission.answers[0].text = '180 cm';
    await expect(confirmSubmission(f.submission, scope(f.submission), fixtureContent, f.digest, f.sufficiency)).rejects.toThrow('confirmation-digest-mismatch');
  });
  it('rejects wrong-patient evidence and source mappings to assistant speech', async () => {
    const { submission: s } = await fixture();
    s.sources[0].patient = 'Patient/other';
    expect(() => validateSubmission(s, scope(s), fixtureContent)).toThrow('source-patient-mismatch');
    s.sources[0].patient = s.patient; s.sources[0].kind = 'assistant-statement';
    expect(() => validateSubmission(s, scope(s), fixtureContent)).toThrow('invalid-answer-source');
  });
  it('retains original wording, correction identity and source times', async () => {
    const { submission: s } = await fixture();
    s.sources.push({ id: 'correction', patient: s.patient, kind: 'patient-correction', corrects: 'turn-weight', text: 'I meant 81 kg, not 80.', capturedAt: '2026-10-09T00:00:03Z' });
    s.answers[1].text = '81 kg (corrected by patient)'; s.answers[1].sourceIds = ['correction'];
    const result = validateSubmission(s, scope(s), fixtureContent, await fixtureSufficiency(s));
    expect(result.sources[1].text).toBe('My weight is 80 kg.');
    expect(result.sources[2].corrects).toBe('turn-weight');
    s.sources[2].corrects = 'correction';
    expect(() => validateSubmission(s, scope(s), fixtureContent)).toThrow('invalid-correction');
  });
  it.each(['unknown', 'declined', 'uncertain', 'conflicting', 'not-asked'] as const)('preserves %s as partial and blocks complete questionnaire claims', async state => {
    const { submission: s } = await fixture();
    s.answers[1].state = state;
    if (state === 'not-asked') { delete s.answers[1].text; s.answers[1].sourceIds = []; }
    expect(() => validateSubmission(s, scope(s), fixtureContent)).toThrow('incomplete-required-answer');
    s.completeness = 'partial';
    expect(validateSubmission(s, scope(s), fixtureContent).answers[1].state).toBe(state);
  });
  it('takes required topics and adaptive detail targets from the supplied content version', async () => {
    const { submission: s } = await fixture();
    const changed = structuredClone(fixtureContent);
    changed.questions.push({ id: 'additional-topic', requiredForComplete: true, detailTargets: ['context', 'impact'], stopWhen: ['patient-declines', 'patient-moves-on', 'safety-interruption'] });
    expect(() => validateSubmission(s, scope(s), changed)).toThrow('incomplete-required-answer');
    expect(() => validateSubmission(s, scope(s), { ...changed, version: 'new-content' })).toThrow('content-version-mismatch');
    expect(() => validateSubmission(s, scope(s), { ...changed, approval: { approvedBy: '', approvedAt: '' } })).toThrow('content-not-approved');
  });
  it('supports a detailed multi-section intake while retaining source-count and total-byte bounds', async () => {
    const { submission: s } = await fixture();
    s.completeness = 'partial';
    const source = s.sources[0];
    s.sources = Array.from({ length: 600 }, (_, index) => ({ ...source, id: `detail-${index}`, text: 'A short explicit patient detail.' }));
    s.answers = [{ ...s.answers[0], sourceIds: s.sources.map(item => item.id) }];
    expect(validateSubmission(s, scope(s), fixtureContent).sources).toHaveLength(600);
    s.sources.push({ ...source, id: 'overflow' });
    expect(() => validateSubmission(s, scope(s), fixtureContent)).toThrow('invalid-submission');
    s.sources.pop();
    s.sources = s.sources.map(item => ({ ...item, text: 'x'.repeat(1000) }));
    expect(() => validateSubmission(s, scope(s), fixtureContent)).toThrow('submission-too-large');
  });
  it('requires trusted per-target sufficiency, not merely a sparse answered string', async () => {
    const f = await fixture();
    expect(() => validateSubmission(f.submission, scope(f.submission), fixtureContent)).toThrow('missing-trusted-sufficiency');
    const assessment = structuredClone(f.sufficiency!);
    assessment.questions[0].targets[1].state = 'unresolved';
    expect(() => validateSubmission(f.submission, scope(f.submission), fixtureContent, assessment)).toThrow('insufficient-required-detail');
    f.submission.answers[0].text = 'fine';
    await expect(confirmSubmission(f.submission, scope(f.submission), fixtureContent, await digest(f.submission), f.sufficiency)).rejects.toThrow('sufficiency-digest-mismatch');
    f.submission.completeness = 'partial';
    expect(validateSubmission(f.submission, scope(f.submission), fixtureContent).completeness).toBe('partial');
  });
  it('requires an earlier same-submission version for amendments', async () => {
    const f = await fixture(); f.submission.version = 2;
    expect(() => validateSubmission(f.submission, scope(f.submission), fixtureContent)).toThrow('missing-amendment-link');
    f.submission.previous = { submissionId: f.submission.submissionId, version: 1, digest: f.digest };
    expect(validateSubmission(f.submission, scope(f.submission), fixtureContent, await fixtureSufficiency(f.submission)).version).toBe(2);
    f.submission.previous.version = 2;
    expect(() => validateSubmission(f.submission, scope(f.submission), fixtureContent)).toThrow('invalid-amendment');
  });
});
describe('staff projection and explicit review', () => {
  const context = (role: StaffContext['role']): StaffContext => ({ member: 'Practitioner/named', role, patient: 'Patient/synthetic', assignedCareTeams: ['CareTeam/synthetic'] });
  const ownReceipt = (f: Awaited<ReturnType<typeof fixture>>, workId = 'intake'): OwnWorkReceipt => ({ state: 'own-work-verified', digest: f.digest, patient: f.submission.patient, workId, owner: 'CareTeam/synthetic', task: 'Task/synthetic', anchors: { source: 'DocumentReference/source/_history/1', response: 'QuestionnaireResponse/response/_history/1' } });
  it.each(clinicalRoles)('gives the assigned %s full intake and source context', async role => {
    const f = await fixture();
    expect(staffView(f.submission, context(role))).toEqual({ visibility: 'full-clinical', submission: f.submission });
    if (role !== 'registered-dietitian') expect(await recordReview(f, context(role), 'intake', 'reviewed', '2026-10-09T02:00:00Z', ownReceipt(f))).toMatchObject({ member: 'Practitioner/named', role, version: 1, digest: f.digest });
  });
  it('restricts admin projection and cannot let admin closure close clinical work', async () => {
    const f = await fixture(); f.submission.administrativeLogistics = { kind: 'other' }; f.submission.work.push({ id: 'logistics', kind: 'administrative', responsibility: 'administrative', owner: 'CareTeam/synthetic' }); f.digest = await digest(f.submission);
    const projected = staffView(f.submission, context('administrative'));
    expect(projected).toEqual({ visibility: 'administrative-minimal', submissionId: f.submission.submissionId, version: 1, patient: f.submission.patient, work: [f.submission.work[1]] });
    await expect(recordReview(f, context('administrative'), 'intake', 'resolved', '2026-10-09T02:00:00Z', ownReceipt(f))).rejects.toThrow('review-work-denied');
    expect((await recordReview(f, context('administrative'), 'logistics', 'resolved', '2026-10-09T02:00:00Z', ownReceipt(f, 'logistics'))).workId).toBe('logistics');
    expect(f.submission.work).toHaveLength(2);
  });
  it('keeps full clinical visibility separate from nutrition and medical disposition authority', async () => {
    const f = await fixture();
    expect(staffView(f.submission, context('registered-dietitian')).visibility).toBe('full-clinical');
    await expect(recordReview(f, context('registered-dietitian'), 'intake', 'resolved', '2026-10-09T02:00:00Z', ownReceipt(f))).rejects.toThrow('review-work-denied');
    f.submission.work[0].responsibility = 'nutrition'; f.digest = await digest(f.submission);
    expect((await recordReview(f, context('registered-dietitian'), 'intake', 'reviewed', '2026-10-09T02:00:00Z', ownReceipt(f))).role).toBe('registered-dietitian');
    await expect(recordReview(f, context('physician'), 'intake', 'resolved', '2026-10-09T02:00:00Z', ownReceipt(f))).rejects.toThrow('review-work-denied');
  });
  it('requires confirmed receipt and rejects review of a mutated submitted version', async () => {
    const f = await fixture();
    await expect(recordReview(f, context('physician'), 'intake', 'reviewed', '2026-10-09T02:00:00Z', { ...ownReceipt(f), state: 'unknown' } as never)).rejects.toThrow('review-requires-receipt');
    f.submission.answers[0].text = 'Changed after confirmation';
    await expect(recordReview(f, context('physician'), 'intake', 'reviewed', '2026-10-09T02:00:00Z', ownReceipt(f))).rejects.toThrow('confirmation-digest-mismatch');
  });
  it('denies unassigned and wrong-patient staff', async () => {
    const f = await fixture();
    expect(() => staffView(f.submission, { ...context('physician'), patient: 'Patient/other' })).toThrow('staff-scope-denied');
    expect(() => staffView(f.submission, { ...context('physician'), assignedCareTeams: [] })).toThrow('staff-assignment-denied');
  });
});
