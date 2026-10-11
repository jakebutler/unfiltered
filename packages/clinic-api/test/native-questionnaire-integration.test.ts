import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext } from '../src/adaptive-validation.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { describe, expect, it } from 'vitest';
import { conversation } from '../src/conversation.js';
import { handoffs } from '../src/handoffs.js';
import { createDraft, document, DRAFT_SYSTEM, readDraft } from '../src/store.js';
import type { ClinicApiConfig, Draft, StaffAssignment } from '../src/types.js';
import { digest, validateSubmissionIntegrity, unresolvedRecognitionSourceIds } from '../../clinical-core/src/domain.js';
import { planHandoff } from '../../clinical-core/src/fhir.js';
import { MedplumClient, type DeliveryQualification } from '../../clinical-core/src/medplum.js';
import { getNativeQuestionnaireDefinition } from '../../clinic-content/src/native-questionnaire.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
const scenarios = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'] as const;
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const staff: StaffAssignment[] = ['physician', 'registered-dietitian', 'administrative'].map((role, index) => ({ membershipId: `member-${index}`, profile: `Practitioner/staff-${index}`, policy: 'AccessPolicy/synthetic', role, name: `Synthetic staff ${index}`, patients: [patient.reference], careTeams: [Object.values(patient.careTeams)[index]] })) as StaffAssignment[];
const configuration = (): ClinicApiConfig => ({ origin: 'http://127.0.0.1:5173', medplumBaseUrl: 'http://localhost:8103/', projectId: 'synthetic-project', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', cookieSecret: 'synthetic-cookie-key-at-least32characters', mentalHealth: 'phq4', patients: Object.fromEntries(scenarios.map(scenario => [scenario, patient])) as ClinicApiConfig['patients'], staff });
const draftFor = (scenario: Draft['scenario']): Draft => { const at = new Date().toISOString(); return { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario, revision: 0, savedAt: at, createdAt: at, phase: 'conversation', turns: [{ id: 'source-1', role: 'patient', text: 'Synthetic patient request for clinician review.', at, channel: 'text' }], topics: {}, requests: {}, version: 1 }; };
async function setup(scenario: Draft['scenario'] = 'billing') {
  const native = mockFhir({ atomic: false }), definition = await getNativeQuestionnaireDefinition(), config = configuration();
  const initial = new MedplumClient({ baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic-token', mode: 'local', timeoutMs: 1000 }, native.fetcher);
  const questionnaire = (await initial.request('Questionnaire', 'POST', definition.questionnaire)).body as { id: string; meta: { versionId: string } };
  config.nativeQuestionnaire = { ...definition.binding, reference: `Questionnaire/${questionnaire.id}/_history/${questionnaire.meta.versionId}` };
  const client = new MedplumClient({ ...initial.config, nativeQuestionnaire: config.nativeQuestionnaire }, native.fetcher), c = conversation(config), h = handoffs(config);
  const q: DeliveryQualification = { deliveryContract: 'conditional-resumable-v1', baseUrl: client.config.baseUrl, mode: 'local', credentialFingerprint: await digest(client.config.accessToken), conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true, qualifiedAt: new Date().toISOString() };
  let draft = draftFor(scenario);
  if (scenario === 'billing') { draft = c.select(draft, 'W05', 'issueType'); draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text: 'bill-question' }); }
  draft.preview = await c.preview(draft); draft.phase = 'review'; draft.confirmed = await c.finalize(draft); draft.preview = undefined; draft.phase = 'confirmed';
  return { native, config, client, c, h, q, draft, id: `${draft.id}.v1` };
}
describe('native questionnaire integration and recovery boundaries', () => {
  it('binds every scenario capture before confirmation and serializes honest nested partial responses', async () => {
    const c = conversation(configuration()), definition = await getNativeQuestionnaireDefinition();
    for (const scenario of scenarios) {
      const draft = draftFor(scenario), preview = await c.preview(draft), submission = preview.confirmation.submission;
      expect(submission.questionnaireCapture?.definition).toEqual(definition.binding);
      expect(submission.questionnaire).toBe(`${definition.binding.canonical}|${definition.binding.version}`);
      expect(preview.digest).toBe(await digest(submission));
      const qr = (await planHandoff(preview.confirmation)).components[1].resource;
      expect(qr.status).toBe('stopped'); expect(qr.item).toEqual(expect.arrayContaining([expect.objectContaining({ item: expect.any(Array) })]));
      const altered = structuredClone(submission); altered.questionnaireCapture!.definition.digest = '0'.repeat(64);
      await expect(planHandoff({ ...preview.confirmation, submission: altered, digest: await digest(altered) })).rejects.toThrow('questionnaire-definition-mismatch');
      const foreign = structuredClone(submission); foreign.questionnaireCapture!.topics.W05 = { presented: true, answers: { issueType: { state: 'known', value: 'bill-question', sourceIds: ['other-patient-source'] } } };
      expect(() => validateSubmissionIntegrity(foreign)).toThrow('questionnaire-source-out-of-scope');
      const recognition = structuredClone(submission); recognition.sources[0].channel = 'unreviewed-transcript';
      expect(() => validateSubmissionIntegrity(recognition)).toThrow('questionnaire-recognition-mismatch');
      const timestamp = structuredClone(submission); timestamp.questionnaireCapture!.topics.Q04 = { presented: true, answers: { 'currentWeightEstimate.statedAt': { state: 'known', value: '2025-01-01T00:00:00.000Z', sourceIds: ['source-1'] } } };
      expect(() => validateSubmissionIntegrity(timestamp)).toThrow('questionnaire-source-time-mismatch');
    }
  });
  it('credits validated cross-topic volunteered values before choosing the next question', () => {
    const c = conversation(configuration()), draft = draftFor('first-intake');
    const text = 'I want help improving energy. My priority is walking with my family. My height is 170 cm.';
    draft.turns[0].text = text;
    const ctx: AdaptiveContext = { binding: { operationId: 'op', sessionId: draft.id, patient: draft.patient, scenario: draft.scenario, revision: 0, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'bound-local-snapshot' }, source: draft.turns[0], sources: draft.turns, topics: c.captureDefinitions(draft), responses: draft.topics, displayed: { topicId: 'Q01', promptId: 'Q01', targetPaths: ['reason'] }, nativeRouting: {} };
    const fact = (topicId: string, path: string, quote: string, transform: 'verbatim' | 'explicit-number' | 'explicit-unit') => ({ topicId, path, state: 'known', transform, evidence: [{ sourceId: 'source-1', start: text.indexOf(quote), end: text.indexOf(quote) + quote.length }] });
    const outcome = applyValidatedTurn(ctx, validateAdaptiveProposal({ schema: 1, facts: [fact('Q01', 'reason', 'I want help improving energy.', 'verbatim'), fact('Q01', 'priority', 'My priority is walking with my family.', 'verbatim'), fact('Q04', 'height.value', '170', 'explicit-number'), fact('Q04', 'height.unit', 'cm', 'explicit-unit')], newItems: [], completedLists: [], acts: [] }, ctx));
    expect(outcome.clarifications).toEqual([]);
    draft.topics = outcome.responses as Draft['topics'];
    expect(c.view(draft).currentPrompt?.topicId).toBe('Q02');
    const next = eligibleAdaptiveProbes({ ...ctx, responses: outcome.responses });
    expect(next.some(probe => probe.topicId === 'Q01')).toBe(false);
    expect(next.some(probe => probe.topicId === 'Q04' && probe.targetPaths.some(path => path === 'height.value' || path === 'height.unit'))).toBe(false);
    expect(next.some(probe => probe.topicId === 'Q04' && probe.targetPaths.includes('lastMeasuredWeight.value'))).toBe(true);
  });
  it('revalidates persisted adaptive questions against the active closed catalog before display', () => {
    const c = conversation(configuration()), draft = draftFor('first-intake');
    draft.adaptive = { mode: 'adaptive', operations: {}, exchange: { state: {}, status: 'question', prompt: { topicId: 'Q01', promptId: 'invented-question', targetPaths: ['reason'], kind: 'question', text: 'Invented unapproved clinical question', labels: [], optional: false } } };
    expect(c.view(draft, true, true).currentPrompt?.text).not.toContain('Invented');
    expect(c.view(draft, true, true).currentPrompt?.id).toBe('Q01:reason');
    draft.topics.Q06 = { presented: true, answers: { 'conditions.diabetes': { state: 'negative', sourceIds: ['source-1'] }, 'conditions.prediabetes': { state: 'negative', sourceIds: ['source-1'] } } };
    draft.adaptive.exchange!.prompt = { topicId: 'DM', promptId: 'DM01', targetPaths: ['typeStatus'], kind: 'question', text: 'What type of diabetes were you told you have?', labels: [], optional: false };
    expect(c.view(draft, true, true).currentPrompt?.topicId).not.toBe('DM');
  });
  it('offers authored fallbacks without record context and renders only server-verified appointment and plan templates', () => {
    const config = configuration(), absent = conversation(config);
    expect(absent.view(draftFor('pre-visit')).currentPrompt?.text).toMatch(/don't have a confirmed appointment/);
    expect(absent.view(draftFor('post-visit')).currentPrompt?.text).toMatch(/don't have a follow-up plan/);
    config.patients['pre-visit'] = { ...patient, nativeContext: { appointment: { reference: 'Appointment/verified', version: '2', startsAt: '2026-10-20T10:00:00-07:00', timezone: 'America/Los_Angeles', priorUpdateAt: '2026-10-01T10:00:00-07:00' } } };
    config.patients['post-visit'] = { ...patient, nativeContext: { plan: { reference: 'CarePlan/verified', version: '2', author: 'Dr. Synthetic, physician', recordedAt: '2026-10-01T10:00:00-07:00', text: 'Synthetic recorded plan' } } };
    const c = conversation(config);
    expect(c.view(draftFor('pre-visit')).currentPrompt?.text).toContain('2026-10-20T10:00:00-07:00 America/Los_Angeles');
    expect(c.view(draftFor('post-visit')).currentPrompt?.text).toContain('Dr. Synthetic, physician');
    expect(c.view(draftFor('post-visit')).currentPrompt?.text).not.toMatch(/\[[^\]]+\]/);
  });
  it('explains purpose then preserves the authored gentle stop choice after two unsuccessful answers', () => {
    const c = conversation(configuration()), draft = draftFor('first-intake');
    const firstSource = { ...draft.turns[0], text: 'I eat normally' }, secondSource = { ...firstSource, id: 'source-2', text: 'I cannot give more detail' };
    let context: AdaptiveContext = { binding: { operationId: 'op', sessionId: draft.id, patient: draft.patient, scenario: draft.scenario, revision: 0, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'bound-local-snapshot' }, source: firstSource, sources: [firstSource], topics: c.captureDefinitions(draft).filter(topic => topic.id === 'Q11'), responses: {}, displayed: { topicId: 'Q11', promptId: 'Q11', targetPaths: ['typicality'] }, nativeRouting: {} };
    const failed = (sourceId: string) => ({ responses: {}, updates: [], provenance: [], clarifications: [], acts: [], sourceId, hasUnresolvedInterpretation: true });
    const first = selectAdaptiveDialogue(context, failed(firstSource.id));
    expect(first.reply?.id).toBe('COPY-02'); expect(first.state.lastUnsuccessful?.purposeExplained).toBe(true);
    context = { ...context, source: secondSource, sources: [firstSource, secondSource], dialogue: first.state };
    const second = selectAdaptiveDialogue(context, failed(secondSource.id));
    expect(second.prompt?.promptId).toBe('stop-choice'); expect(second.status).toBe('clarification');
    expect(second.prompt?.text).toMatch(/move on|come back/i);
  });
  it('asks only the missing measured-weight date after a supplied reading and units', () => {
    const c = conversation(configuration()); let draft = draftFor('first-intake');
    draft.turns[0].text = 'My last measured weight was 82 kg.';
    draft.topics.Q04 = { presented: true, answers: { 'lastMeasuredWeight.value': { state: 'known', value: 82, sourceIds: ['source-1'] }, 'lastMeasuredWeight.unit': { state: 'known', value: 'kg', sourceIds: ['source-1'] } } };
    draft = c.select(draft, 'Q04', 'lastMeasuredWeight.measuredWhen');
    expect(c.view(draft).currentPrompt?.text).toBe('About when was your weight measured?');
    expect(c.view(draft).currentPrompt?.text).not.toMatch(/reading|units/);
  });
  it('skips an explicitly negative branch, asks a condition-specific uncertain discriminator, and recomputes after correction', async () => {
    const c = conversation(configuration()); let draft = draftFor('first-intake');
    const answer = (value: string) => { draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text: value }); };
    draft = c.select(draft, 'Q06', 'conditions.prediabetes'); answer('__negative');
    draft = c.select(draft, 'Q06', 'conditions.diabetes'); answer('__negative');
    expect(c.definitions(draft).some(topic => topic.id === 'DM')).toBe(false);
    expect(() => c.select(draft, 'DM')).toThrow('unknown-topic');
    draft = c.select(draft, 'Q06', 'conditions.diabetes'); answer('__uncertain');
    expect(c.view(draft).currentPrompt?.id).toBe('Q06:conditions.diabetes.uncertainDiagnosis');
    answer('I do not remember what the clinician called it.');
    expect(c.view(draft).currentPrompt?.id).not.toBe('Q06:conditions.diabetes.uncertainDiagnosis');
    draft = c.select(draft, 'Q06', 'conditions.diabetes'); answer('true');
    expect(c.definitions(draft).some(topic => topic.id === 'DM')).toBe(true);
    draft = c.select(draft, 'DM', 'typeStatus'); answer('Type 2 diabetes, as reported by my clinician.');
    draft = c.select(draft, 'Q06', 'conditions.diabetes'); answer('__negative');
    expect(c.definitions(draft).some(topic => topic.id === 'DM')).toBe(false);
    const capture = (await c.preview(draft)).confirmation.submission.questionnaireCapture!;
    expect(capture.topics.DM.answers).toEqual({});
    expect(capture.inactiveHistory).toEqual(expect.arrayContaining([expect.objectContaining({ topicId: 'DM', path: 'typeStatus', reason: 'disabled-by-correction' })]));
  });
  it('reuses detailed surgery effects with their original source and instance before choosing a digestive followup', async () => {
    const c = conversation(configuration()); let draft = draftFor('first-intake');
    const value = 'Since surgery I still have trouble eating solid food now.'; draft.turns[0].text = value;
    draft.topics.Q07 = { presented: true, answers: { events: { state: 'known', sourceIds: ['source-1'], complete: true, items: [{ id: 'surgery-1', answers: { event: { state: 'known', value: 'Patient-reported surgery', sourceIds: ['source-1'] }, when: { state: 'unknown', sourceIds: ['source-1'] }, effects: { state: 'known', value, sourceIds: ['source-1'] } } }] } } };
    c.synchronize(draft);
    expect(draft.topics.GI?.answers.effect).toMatchObject({ state: 'known', value, sourceIds: ['source-1'] });
    expect(draft.topics.Q07.answers.events).toMatchObject({ items: [{ id: 'surgery-1', answers: { effects: { state: 'known', value } } }] });
    const context: AdaptiveContext = { binding: { operationId: 'op', sessionId: draft.id, patient: draft.patient, scenario: draft.scenario, revision: 0, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'bound-local-snapshot' }, source: draft.turns[0], sources: draft.turns, topics: c.captureDefinitions(draft), responses: c.effective(draft, true).responses, nativeRouting: { context: c.nativeContext(draft) } };
    expect(eligibleAdaptiveProbes(context).some(probe => probe.promptId === 'GI01')).toBe(false);
    const submission = (await c.preview(draft)).confirmation.submission, capture = submission.questionnaireCapture!;
    expect(capture.topics.GI.answers.effect).toMatchObject({ state: 'known', value, sourceIds: ['source-1'] });
    expect(capture.context?.surgeryEatingEffect).toMatchObject({ topicId: 'Q07', path: 'events[surgery-1].effects', sourceIds: ['source-1'] });
    const forged = structuredClone(submission), effect = forged.questionnaireCapture!.topics.GI.answers.effect;
    if (effect?.state !== 'known' || effect.items) throw new Error('expected scalar reuse');
    forged.questionnaireCapture!.topics.GI.answers.effect = { ...effect, value: 'Invented effect not stated at its reused origin.' };
    expect(() => validateSubmissionIntegrity(forged)).toThrow(/questionnaire-reuse/);
    const answer = (text: string) => { draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text }); };
    draft = c.select(draft, 'Q07', 'events[surgery-1].effects'); answer('__negative');
    expect(draft.topics.GI?.answers.effect).toBeUndefined();
    expect(draft.questionnaireHistory).toEqual(expect.arrayContaining([expect.objectContaining({ topicId: 'GI', path: 'effect', answer: expect.objectContaining({ value, sourceIds: ['source-1'] }) })]));
    const revised = 'Since surgery I now have difficulty drinking large amounts.';
    draft = c.select(draft, 'Q07', 'events[surgery-1].effects'); answer(revised);
    expect(draft.topics.GI?.answers.effect).toMatchObject({ state: 'known', value: revised, sourceIds: [draft.turns.at(-1)!.id] });
    expect(draft.topics.GI?.answers.effect?.sourceIds).not.toContain('source-1');
    draft = c.select(draft, 'GI', 'effect'); answer('My current eating difficulty is specifically with very large meals.');
    const direct = structuredClone(draft.topics.GI.answers.effect);
    draft = c.select(draft, 'Q07', 'events[surgery-1].effects'); answer('Since surgery I now have trouble eating crunchy food.');
    expect(draft.topics.GI.answers.effect).toEqual(direct);

    const missing = draftFor('first-intake'); missing.topics.Q06 = { presented: true, answers: { 'conditions.digestive': { state: 'known', value: true, sourceIds: ['source-1'] } } }; c.synchronize(missing);
    expect(eligibleAdaptiveProbes({ ...context, sources: missing.turns, source: missing.turns[0], responses: c.effective(missing, true).responses, nativeRouting: { context: c.nativeContext(missing) } }).some(probe => probe.promptId === 'GI01')).toBe(true);
  });
  it('does not reuse a confirmed child effect from an unresolved raw parent collection in the same turn', async () => {
    const c = conversation(configuration()), draft = draftFor('first-intake');
    draft.turns = [{ id: 'raw-parent', role: 'patient', text: 'unclear surgery list recognition', at: '2026-10-10T10:00:00.000Z', channel: 'unreviewed-transcript', displayedPromptId: 'Q07:events' }, { id: 'confirmed-child', role: 'patient', text: 'Since surgery I still have trouble eating solid food now.', at: '2026-10-10T10:00:01.000Z', channel: 'confirmed-transcript', displayedPromptId: 'Q07:events[surgery-1].effects' }];
    draft.topics.Q07 = { presented: true, answers: { events: { state: 'known', sourceIds: ['raw-parent'], complete: true, items: [{ id: 'surgery-1', answers: { effects: { state: 'known', value: draft.turns[1].text, sourceIds: ['confirmed-child'] } } }] } } };
    c.synchronize(draft);
    expect(draft.topics.Q07.answers.events).toBeUndefined();
    expect(draft.topics.GI?.answers.effect).toBeUndefined();
    expect(c.nativeContext(draft)?.surgeryEatingEffect).toBeUndefined();
    expect(draft.questionnaireHistory).toEqual(expect.arrayContaining([expect.objectContaining({ topicId: 'Q07', path: 'events', answer: expect.objectContaining({ sourceIds: ['raw-parent'] }) })]));
    const capture = (await c.preview(draft)).confirmation.submission.questionnaireCapture!;
    expect(capture.topics.GI?.answers.effect).toBeUndefined();
    expect(capture.routingDecisions.find(decision => decision.ruleId === 'branch.digestive')?.outcome).not.toBe('applicable');
    expect(capture.unreviewedSourceIds).toContain('raw-parent');
  });
  it('reuses an explicit apnea diagnosis before sleep questioning and removes the derived label after correction', async () => {
    const c = conversation(configuration()); let draft = draftFor('first-intake');
    draft.turns[0].text = 'I was told I have sleep apnea.';
    draft.topics.Q06 = { presented: true, answers: { 'conditions.sleepApnea': { state: 'known', value: true, sourceIds: ['source-1'] } } };
    c.synchronize(draft);
    expect(draft.topics.Q15?.answers.condition).toMatchObject({ state: 'known', value: 'sleep apnea', sourceIds: ['source-1'], reusedFrom: { topicId: 'Q06', path: 'conditions.sleepApnea' } });
    const context: AdaptiveContext = { binding: { operationId: 'op', sessionId: draft.id, patient: draft.patient, scenario: draft.scenario, revision: 0, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'bound-local-snapshot' }, source: draft.turns[0], sources: draft.turns, topics: c.captureDefinitions(draft), responses: c.effective(draft, true).responses, nativeRouting: { context: c.nativeContext(draft) } };
    expect(eligibleAdaptiveProbes(context).some(probe => probe.topicId === 'Q15' && probe.targetPaths.includes('condition'))).toBe(false);
    expect((await c.preview(draft)).confirmation.submission.questionnaireCapture!.topics.Q15.answers.condition).toMatchObject({ reusedFrom: { topicId: 'Q06', path: 'conditions.sleepApnea' } });
    draft = c.select(draft, 'Q15', 'treatment'); draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text: 'I use a device prescribed by my clinician.' });
    const treatment = structuredClone(draft.topics.Q15.answers.treatment);
    draft = c.select(draft, 'Q06', 'conditions.sleepApnea'); draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text: '__negative' });
    expect(draft.topics.Q15?.answers.condition).toBeUndefined();
    expect(draft.topics.Q15?.answers.treatment).toBeUndefined();
    expect(draft.questionnaireHistory).toEqual(expect.arrayContaining([expect.objectContaining({ topicId: 'Q15', path: 'treatment', answer: treatment })]));
    expect(draft.questionnaireHistory).toEqual(expect.arrayContaining([expect.objectContaining({ topicId: 'Q15', path: 'condition', answer: expect.objectContaining({ value: 'sleep apnea', sourceIds: ['source-1'] }) })]));
  });
  it('does not revive earlier descendants after positive-negative-positive correction before any preview', () => {
    const c = conversation(configuration()); let draft = draftFor('first-intake');
    const answer = (value: string) => { draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text: value }); };
    draft = c.select(draft, 'Q12', 'concern'); answer('I have an eating concern I want the team to review.');
    draft = c.select(draft, 'Q12', 'timing'); answer('This concern was in the past.');
    const priorTiming = draft.topics.Q12.answers.timing;
    draft = c.select(draft, 'Q12', 'concern'); answer('__negative');
    expect(draft.topics.Q12.answers.timing).toBeUndefined();
    expect(draft.questionnaireHistory).toEqual(expect.arrayContaining([expect.objectContaining({ topicId: 'Q12', path: 'timing', answer: priorTiming })]));
    draft = c.select(draft, 'Q12', 'concern'); answer('I have a new eating concern now.');
    expect(draft.topics.Q12.answers.timing).toBeUndefined();
    expect(c.view(draft).currentPrompt?.id).toBe('Q12:timing');
    expect(draft.turns.some(turn => turn.text.includes('This concern was in the past.'))).toBe(true);
  });
  it('retains historical raw speech while a later exact same-field confirmation restores completeness', async () => {
    const c = conversation(configuration()); let draft = draftFor('first-intake'), count = 0;
    while (c.view(draft).currentPrompt) {
      const prompt = c.view(draft).currentPrompt!; expect(++count).toBeLessThan(150);
      const text = prompt.choices ? prompt.choices.find(choice => choice.value === '__negative')?.value ?? prompt.choices.find(choice => choice.value === '__done')?.value ?? prompt.choices.find(choice => choice.value === '__topic-not-applicable')?.value ?? prompt.choices[0].value : prompt.id === 'Q04:height.value' ? '170' : prompt.id === 'Q04:lastMeasuredWeight.value' ? '82' : 'Synthetic typical detail recalled for this fixture.';
      draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: prompt.id, action: 'answer', text });
    }
    expect(c.view(draft).completeness).toBe('complete');
    draft = c.select(draft, 'Q16', 'MH01');
    draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text: 'I am fine', choiceTranscriptOnly: true, channel: 'unreviewed-transcript' });
    const raw = draft.turns.at(-1)!; expect(c.view(draft).completeness).toBe('partial');
    draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text: '1', channel: 'confirmed-transcript', choiceConfirmation: { optionTranscript: 'Several days.', confirmationTranscript: 'Yes.', confirmationMethod: 'voice' } });
    expect(c.view(draft).completeness).toBe('complete');
    const preview = await c.preview(draft); expect(preview.confirmation.submission.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: raw.id, channel: 'unreviewed-transcript', displayedPromptId: 'Q16:MH01' })]));
    expect(preview.confirmation.submission.questionnaireCapture!.unreviewedSourceIds).not.toContain(raw.id);
    expect((await planHandoff(preview.confirmation)).components[1].resource.status).toBe('completed');
  }, 15000);
  it('resolves reviewed recognition for explicit missing and negative states without fabricating clinical answers', () => {
    const sources = [{ id: 'raw', patient: patient.reference, kind: 'patient-statement' as const, text: 'unclear recognition', capturedAt: '2026-10-10T10:00:00.000Z', channel: 'unreviewed-transcript' as const, displayedPromptId: 'Q06:conditions.diabetes' }, { id: 'reviewed', patient: patient.reference, kind: 'patient-statement' as const, text: 'reviewed exact choice', capturedAt: '2026-10-10T10:00:01.000Z', channel: 'confirmed-transcript' as const, displayedPromptId: 'Q06:conditions.diabetes' }];
    for (const state of ['negative', 'unknown', 'declined', 'not-applicable'] as const) {
      const topics = { Q06: { presented: true, answers: { 'conditions.diabetes': { state, sourceIds: ['reviewed'] } } } };
      expect(unresolvedRecognitionSourceIds(sources, topics)).toEqual([]);
      expect(topics.Q06.answers['conditions.diabetes'].state).toBe(state);
      expect(unresolvedRecognitionSourceIds([{ ...sources[0] }, { ...sources[1], displayedPromptId: 'Q06:conditions.prediabetes' }], topics)).toEqual(['raw']);
    }
  });
  it('requires exact read-only native Questionnaire history before writes and rejects altered same-version resources', async () => {
    const f = await setup(); const calls = f.native.counters.requests;
    await expect(new MedplumClient({ ...f.client.config, nativeQuestionnaire: undefined }, f.native.fetcher).deliver(f.draft.confirmed!.confirmation, f.q)).rejects.toThrow('native-questionnaire-binding-required');
    expect(f.native.counters.requests).toBe(calls);
    const reference = f.config.nativeQuestionnaire!.reference.split('/_history/')[0], resource = structuredClone(f.native.resources.get(reference)!);
    (resource.item as Array<{text?: string}>)[0].text = 'Altered same version content';
    f.native.histories.get(reference)![0] = resource;
    await expect(f.client.deliver(f.draft.confirmed!.confirmation, f.q)).rejects.toThrow('native-questionnaire-resource-mismatch');
  });
  it('keeps received work visible beside an expired unconfirmed draft and omits clinical completeness for admin', async () => {
    const f = await setup(); await createDraft(f.client, f.draft); await f.h.snapshot(f.client, f.draft); expect((await f.client.deliver(f.draft.confirmed!.confirmation, f.q)).receipt.state).toBe('received');
    const stale = { ...draftFor('billing'), createdAt: '2026-08-01T00:00:00.000Z' }; await f.client.request('DocumentReference', 'POST', document(DRAFT_SYSTEM, stale.id, stale.patient, stale));
    await expect(readDraft(f.client, stale.id, stale.patient)).rejects.toThrow('session-expired');
    const detail = await f.h.view(f.client, f.client, staff[2], f.id), queue = await f.h.queue(f.client, f.client, staff[2]);
    expect(detail.deliveryState).toBe('received'); expect(queue.items).toHaveLength(1); expect(detail).not.toHaveProperty('completeness'); expect(queue.items[0]).not.toHaveProperty('completeness');
    expect(detail.sources).toEqual([]); expect(JSON.stringify(detail)).not.toContain('Synthetic patient request for clinician review.');
  });
  it('retains expired confirmed no-snapshot intent and resumes it without a patient-session revival', async () => {
    const f = await setup(); f.draft.createdAt = '2026-08-01T00:00:00.000Z'; await f.client.request('DocumentReference', 'POST', document(DRAFT_SYSTEM, f.draft.id, f.draft.patient, f.draft));
    await expect(readDraft(f.client, f.draft.id, f.draft.patient)).rejects.toThrow('session-expired');
    const queue = await f.h.queue(f.client, f.client, staff[0]); expect(queue.recovery.map(row => row.id)).toContain(f.id);
    expect((await f.h.resume(f.client, f.client, staff[0], f.id, f.q)).deliveryState).toBe('received');
    await expect(readDraft(f.client, f.draft.id, f.draft.patient)).rejects.toThrow('session-expired');
  });
});
