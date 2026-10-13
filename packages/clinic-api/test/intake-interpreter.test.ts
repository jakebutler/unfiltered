import { describe, expect, it, vi } from 'vitest';
import { buildIntakeInterpreterMessages, createIntakeInterpreter, interpretIntakeResponse, intakeKnownAnswers, intakeRequestBytes, type IntakeInterpreter } from '../src/intake-interpreter.js';
import { AdaptiveProposalFailure } from '../src/adaptive.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import type { AdaptiveContext, AdaptiveOutcome } from '../src/adaptive-validation.js';
import { createClinicHandler } from '../src/handler.js';
import { decodeDocument } from '../src/store.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import type { AdaptiveTurnResult, ClinicSessionView, ReviewPreview } from '../../clinic-contract/src/index.js';
import { context, register, source } from './fixtures/adaptive.js';

const empty = { facts: [], items: [], listsDone: [], questions: [], moveOn: null };
const answers = (outcome: AdaptiveOutcome, topicId: string) => outcome.responses[topicId]?.answers ?? {};
function itemsOf(outcome: AdaptiveOutcome, topicId: string, list: string) {
  const answer = answers(outcome, topicId)[list];
  return answer?.state === 'known' ? answer.items ?? [] : [];
}
/** A following turn with the previous outcome as trusted prior answers. */
function nextTurn(previous: AdaptiveContext, outcome: AdaptiveOutcome, text: string, id = 'turn-2'): AdaptiveContext {
  const current = { ...source(text, id), at: '2026-10-09T12:05:00.000Z' };
  return { ...previous, source: current, sources: [...previous.sources, current], responses: outcome.responses };
}

describe('intake-interpreter-v1 per-fact validation', () => {
  it('applies a multi-topic volunteered answer (height, weight and goal) in one turn', () => {
    const ctx = context('I\'m 5\'8" and the scale said 212 pounds in March, maybe 215 now. I want more energy to play with my kids.', ['Q01', 'Q04']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q04', field: 'height.value', state: 'known', value: '5 ft 8 in', quote: 'I\'m 5\'8"' },
      { topic: 'Q04', field: 'lastMeasuredWeight.value', state: 'known', value: 212, quote: 'the scale said 212 pounds' },
      { topic: 'Q04', field: 'lastMeasuredWeight.unit', state: 'known', value: 'lb', quote: '212 pounds' },
      { topic: 'Q04', field: 'lastMeasuredWeight.measuredWhen', state: 'known', value: 'in March', quote: 'in March' },
      { topic: 'Q01', field: 'priority', state: 'known', value: 'more energy to play with my kids', quote: 'I want more energy to play with my kids' },
      { topic: 'Q04', field: 'currentWeightEstimate.value', state: 'known', value: 215, quote: 'maybe 215 now' },
      // The unit is not repeated next to the estimate; the turn names exactly one weight unit.
      { topic: 'Q04', field: 'currentWeightEstimate.unit', state: 'known', value: 'lb', quote: 'maybe 215 now' },
    ], ack: 'Noted your height, a 212 lb reading in March and your goal.' }, ctx);
    const q04 = answers(outcome, 'Q04');
    expect(q04['height.value']).toMatchObject({ state: 'known', value: { feet: 5, inches: 8 } });
    expect(q04['height.unit']).toMatchObject({ state: 'known', value: 'ft-in' });
    expect(q04['lastMeasuredWeight.value']).toMatchObject({ state: 'known', value: 212 });
    expect(q04['lastMeasuredWeight.unit']).toMatchObject({ state: 'known', value: 'lb' });
    expect(q04['lastMeasuredWeight.measuredWhen']).toMatchObject({ state: 'known', value: 'in March' });
    expect(answers(outcome, 'Q01').priority).toMatchObject({ state: 'known', value: 'more energy to play with my kids' });
    expect(q04['currentWeightEstimate.value']).toMatchObject({ state: 'known', value: 215 });
    expect(q04['currentWeightEstimate.unit']).toMatchObject({ state: 'known', value: 'lb' });
    expect(q04['currentWeightEstimate.statedAt']).toMatchObject({ state: 'known', value: ctx.source.at });
    expect(outcome.clarifications).toEqual([]);
    expect(outcome.rejectedCandidates).toBeUndefined();
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
    expect(outcome.acknowledgement).toMatch(/212 lb/);
    for (const entry of outcome.provenance) for (const span of entry.evidence) expect(ctx.source.text.slice(span.start, span.end).length).toBeGreaterThan(0);
  });

  it('rejects silence padded into unknown/negative and keeps only faithful facts (AF175 class)', () => {
    const ctx = context('I have had some nausea in the mornings since last week.', ['Q02', 'Q01', 'Q04']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q02', field: 'concern', state: 'known', value: 'nausea in the mornings', quote: 'some nausea in the mornings' },
      { topic: 'Q02', field: 'onset', state: 'known', value: 'since last week', quote: 'since last week' },
      { topic: 'Q02', field: 'impact', state: 'unknown', value: null, quote: 'I have had some nausea' },
      { topic: 'Q02', field: 'help', state: 'unknown', value: null, quote: 'nausea in the mornings' },
      { topic: 'Q04', field: 'height.value', state: 'unknown', value: null, quote: 'since last week' },
      { topic: 'Q01', field: 'reason', state: 'negative', value: null, quote: 'I have had' },
      { topic: 'Q01', field: 'priority', state: 'declined', value: null, quote: 'I have had some nausea' },
    ] }, ctx);
    expect(outcome.updates.map(update => `${update.topicId}:${update.path}`)).toEqual(['Q02:concern', 'Q02:onset']);
    expect(answers(outcome, 'Q04')).toEqual({});
    expect(answers(outcome, 'Q01')).toEqual({});
    expect(outcome.rejectedCandidates?.map(entry => entry.reason).sort()).toEqual(['declined-without-wording', 'negative-without-negation', 'unknown-without-wording', 'unknown-without-wording', 'unknown-without-wording']);
    // Model padding is audit-only: it never becomes a patient re-question.
    expect(outcome.clarifications).toEqual([]);
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
  });

  it('keeps a mother\'s diabetes as family history, prediabetes uncertain, no negative diabetes, and the question (AF165)', () => {
    const text = 'My mother has diabetes. I was told I might have prediabetes, but no diagnosis yet. Can you tell whether I have diabetes?';
    const ctx = context(text, ['Q06', 'Q10', 'DM']);
    const outcome = interpretIntakeResponse({ ...empty,
      facts: [
        { topic: 'Q06', field: 'conditions.prediabetes', state: 'uncertain', value: null, quote: 'I was told I might have prediabetes' },
        { topic: 'Q06', field: 'conditions.diabetes', state: 'negative', value: null, quote: 'no diagnosis yet' },
        { topic: 'Q06', field: 'conditions.diabetes', state: 'known', value: true, quote: 'My mother has diabetes' },
        { topic: 'Q06', field: 'conditions.diabetes', state: 'uncertain', value: null, quote: 'Can you tell whether I have diabetes?' },
      ],
      items: [{ topic: 'Q10', list: 'familyHistory', existing: null, fields: [
        { field: 'relationship', state: 'known', value: 'mother', quote: 'My mother' },
        { field: 'condition', state: 'known', value: 'diabetes', quote: 'My mother has diabetes' },
      ] }, { topic: 'Q06', list: 'reportedConditions', existing: null, fields: [{ field: 'term', state: 'known', value: 'diabetes', quote: 'My mother has diabetes' }] }],
      questions: [{ quote: 'Can you tell whether I have diabetes?' }],
    }, ctx);
    const family = itemsOf(outcome, 'Q10', 'familyHistory');
    expect(family).toHaveLength(1);
    expect(family[0].answers.relationship).toMatchObject({ state: 'known', value: 'mother' });
    expect(family[0].answers.condition).toMatchObject({ state: 'known', value: 'diabetes' });
    const q06 = answers(outcome, 'Q06');
    expect(q06['conditions.prediabetes']).toMatchObject({ state: 'uncertain' });
    expect(q06['conditions.diabetes']).toBeUndefined();
    expect(q06.reportedConditions).toBeUndefined();
    expect(outcome.acts).toEqual([expect.objectContaining({ kind: 'question', replyId: 'COPY-02' })]);
    expect(outcome.rejectedCandidates?.map(entry => entry.reason).sort()).toEqual(['negative-with-uncertainty', 'relative-subject', 'relative-subject', 'uncertain-without-wording']);
    expect(outcome.unresolvedQuestions).toBeUndefined();
    // The approved reply answers the question; the next question is still authored content.
    const dialogue = selectAdaptiveDialogue(ctx, outcome);
    expect(dialogue.reply?.id).toBe('COPY-02');
  });

  it('records two medicines with label vs actual use, supersedes only a cued correction, else conflicts', () => {
    const text = 'I take Metformin 750 mg, the label says twice a day but I usually only take it once in the morning. And vitamin D 1000 IU daily.';
    const ctx = context(text, ['Q08']);
    const first = interpretIntakeResponse({ ...empty, items: [
      { topic: 'Q08', list: 'medicines', existing: null, fields: [
        { field: 'name', state: 'known', value: 'Metformin', quote: 'Metformin 750 mg' },
        { field: 'strength', state: 'known', value: '750 mg', quote: '750 mg' },
        { field: 'labelDirections', state: 'known', value: 'twice a day', quote: 'the label says twice a day' },
        { field: 'actualUse', state: 'known', value: 'once in the morning', quote: 'I usually only take it once in the morning' },
      ] },
      { topic: 'Q08', list: 'medicines', existing: null, fields: [
        { field: 'name', state: 'known', value: 'Vitamin D', quote: 'vitamin D 1000 IU' },
        { field: 'strength', state: 'known', value: '1000 IU', quote: '1000 IU' },
        { field: 'actualUse', state: 'known', value: 'daily', quote: '1000 IU daily' },
      ] },
    ] }, ctx);
    const medicines = itemsOf(first, 'Q08', 'medicines');
    expect(medicines).toHaveLength(2);
    const metformin = medicines.find(item => item.answers.name?.state === 'known' && item.answers.name.value === 'Metformin')!;
    expect(metformin.answers.labelDirections).toMatchObject({ value: 'twice a day' });
    expect(metformin.answers.actualUse).toMatchObject({ value: 'once in the morning' });
    expect(first.hasUnresolvedInterpretation).toBe(false);

    const correctionContext = nextTurn(ctx, first, 'Actually the metformin is 500 mg.');
    const line = intakeKnownAnswers(correctionContext).lines.find(entry => entry.path === `medicines[${metformin.id}].strength`)!;
    expect(buildIntakeInterpreterMessages(correctionContext)[0].content).toContain(`#${line.number} Q08 medicines[${metformin.id}].strength = "750 mg"`);
    const corrected = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q08', field: `medicines[${metformin.id}].strength`, state: 'known', value: '500 mg', quote: '500 mg', corrects: line.number }] }, correctionContext);
    const after = itemsOf(corrected, 'Q08', 'medicines');
    expect(after.find(item => item.id === metformin.id)!.answers.strength).toMatchObject({ state: 'known', value: '500 mg', sourceIds: ['turn-2'] });
    expect(after.find(item => item.id !== metformin.id)!.answers.strength).toMatchObject({ state: 'known', value: '1000 IU', sourceIds: ['turn-current'] });
    expect(corrected.provenance[0]).toMatchObject({ correctsSourceIds: ['turn-current'], transform: 'interpreted-v1' });
    expect(corrected.clarifications).toEqual([]);

    // The model sometimes drops a few words from the quote without marking the gap.
    const gapped = nextTurn(ctx, first, 'Actually the metformin is 500 mg, not 750.');
    const regapped = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q08', field: `medicines[${metformin.id}].strength`, state: 'known', value: '500 mg', quote: 'actually 500 mg, not 750', corrects: line.number }] }, gapped);
    expect(itemsOf(regapped, 'Q08', 'medicines').find(item => item.id === metformin.id)!.answers.strength).toMatchObject({ state: 'known', value: '500 mg' });
    expect(regapped.rejectedCandidates ?? []).toEqual([]);
    const farApart = nextTurn(ctx, first, 'Actually I checked the bottle in the kitchen this morning. It is 500 mg, not 750.');
    const rejected = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q08', field: `medicines[${metformin.id}].strength`, state: 'known', value: '500 mg', quote: 'actually 500 mg, not 750', corrects: line.number }] }, farApart);
    expect(rejected.rejectedCandidates).toEqual([expect.objectContaining({ reason: 'quote-not-found' })]);

    const uncued = nextTurn(ctx, first, 'The metformin is 500 mg.');
    const conflicted = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q08', field: `medicines[${metformin.id}].strength`, state: 'known', value: '500 mg', quote: '500 mg', corrects: line.number }] }, uncued);
    expect(itemsOf(conflicted, 'Q08', 'medicines').find(item => item.id === metformin.id)!.answers.strength).toMatchObject({ state: 'conflicting' });
    expect(conflicted.clarifications).toEqual([expect.objectContaining({ reason: 'conflict', proposed: expect.objectContaining({ value: '500 mg' }) })]);
    expect(conflicted.hasUnresolvedInterpretation).toBe(true);
  });

  it('rejects an invented quote and falls back to exact words for an unsupported paraphrase (AF176)', () => {
    const ctx = context('I want to feel better and keep up at work.', ['Q01']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q01', field: 'reason', state: 'known', value: 'lose 30 pounds for my wedding', quote: 'I want to lose 30 pounds for my wedding' },
      { topic: 'Q01', field: 'priority', state: 'known', value: 'Patient desires substantial weight reduction', quote: 'feel better and keep up at work' },
    ], ack: 'Noted that you want to lose 30 pounds.' }, ctx);
    expect(answers(outcome, 'Q01').reason).toBeUndefined();
    expect(answers(outcome, 'Q01').priority).toMatchObject({ state: 'known', value: 'feel better and keep up at work' });
    expect(outcome.provenance[0].transform).toBe('interpreted-v1-quote');
    expect(outcome.rejectedCandidates).toEqual([expect.objectContaining({ reason: 'quote-not-found', path: 'reason' })]);
    expect(outcome.clarifications).toEqual([]);
  });

  it('records topic avoidance explicitly: the displayed detail is declined with the patient\'s words and the topic stops as patient-declines', () => {
    const base = context('I’d rather not talk about that.', ['Q17', 'Q18']);
    const ctx = { ...base, displayed: { ...base.displayed!, targetPaths: ['substances'] } };
    const outcome = interpretIntakeResponse({ ...empty, moveOn: { quote: "I'd rather not talk about that" } }, ctx);
    expect(outcome.responses.Q17).toMatchObject({ stopped: 'patient-declines' });
    expect(outcome.responses.Q17?.answers.substances).toMatchObject({ state: 'declined', sourceIds: [ctx.source.id] });
    expect(outcome.provenance).toEqual([expect.objectContaining({ topicId: 'Q17', path: 'substances', sourceText: ['I’d rather not talk about that'] })]);
    expect(outcome.acts).toEqual([expect.objectContaining({ kind: 'move-on', targetTopicId: 'Q17' })]);
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
  });

  it('a plain skip moves on without recording a decline', () => {
    const ctx = context('Can we skip this one?', ['Q17', 'Q18']);
    const outcome = interpretIntakeResponse({ ...empty, moveOn: { quote: 'Can we skip this one?' } }, ctx);
    expect(outcome.responses.Q17).toMatchObject({ stopped: 'patient-moves-on' });
    expect(outcome.updates).toEqual([]);
  });

  it('keeps facts volunteered in the same message as the avoidance', () => {
    const base = context("I'd rather not get into my childhood. Over the last five years I've gained about 30 pounds.", ['Q03', 'Q04']);
    const ctx = { ...base, displayed: { ...base.displayed!, targetPaths: ['childhood'] } };
    const outcome = interpretIntakeResponse({ ...empty, moveOn: { quote: "I'd rather not get into my childhood" },
      facts: [{ topic: 'Q03', field: 'lastFiveYears', state: 'known', value: 'gained about 30 pounds', quote: "Over the last five years I've gained about 30 pounds" }] }, ctx);
    expect(outcome.responses.Q03).toMatchObject({ stopped: 'patient-declines' });
    expect(outcome.responses.Q03?.answers.childhood).toMatchObject({ state: 'declined' });
    expect(outcome.responses.Q03?.answers.lastFiveYears).toMatchObject({ state: 'known', value: 'gained about 30 pounds' });
  });

  it('does not open the diabetes branch on explicit negatives and ignores branch facts there', () => {
    const ctx = context('I don\'t have diabetes or prediabetes.', ['Q06', 'DM']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q06', field: 'conditions.diabetes', state: 'negative', value: null, quote: 'I don\'t have diabetes' },
      { topic: 'Q06', field: 'conditions.prediabetes', state: 'negative', value: null, quote: 'I don\'t have diabetes or prediabetes' },
      { topic: 'DM', field: 'typeStatus', state: 'known', value: 'none', quote: 'diabetes or prediabetes' },
    ] }, ctx);
    expect(answers(outcome, 'Q06')['conditions.diabetes']).toMatchObject({ state: 'negative' });
    expect(answers(outcome, 'Q06')['conditions.prediabetes']).toMatchObject({ state: 'negative' });
    expect(outcome.responses.DM?.applicability ?? 'not-applicable').toBe('not-applicable');
    expect(answers(outcome, 'DM').typeStatus).toBeUndefined();
    expect(eligibleAdaptiveProbes({ ...ctx, responses: outcome.responses }).some(probe => probe.topicId === 'DM')).toBe(false);
  });

  it('opens the branch from a known diagnosis and does not pad the DM type question', () => {
    const base = context('My clinician diagnosed me with diabetes. I would like help with meals.', ['Q06', 'DM']);
    const prior = source('I have type 2 diabetes.', 'prior');
    const ctx: AdaptiveContext = { ...base, sources: [prior, base.source], responses: { Q06: { presented: true, answers: { 'conditions.diabetes': { state: 'known', value: true, sourceIds: ['prior'] } } }, DM: { presented: true, answers: {}, applicability: 'applicable', applicabilitySourceIds: ['prior'] } }, displayed: { topicId: 'DM', promptId: 'DM01', targetPaths: ['typeStatus', 'when'] } };
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'DM', field: 'concern', state: 'known', value: 'help with meals', quote: 'I would like help with meals' },
      { topic: 'DM', field: 'when', state: 'unknown', value: null, quote: 'My clinician diagnosed me with diabetes' },
      { topic: 'DM', field: 'monitoring', state: 'negative', value: null, quote: 'diagnosed me with diabetes' },
    ] }, ctx);
    expect(outcome.updates.map(update => update.path)).toEqual(['concern']);
    expect(answers(outcome, 'DM').when).toBeUndefined();
    expect(answers(outcome, 'DM').monitoring).toBeUndefined();
  });

  it('records an approximate A1C ("around 6") as an uncertain value, and still rejects uncertainty with no hedge', () => {
    const base = context('Prediabetes, which I was told last year. My A1C was around 6, but I am not sure of the exact number.', ['Q06', 'DM']);
    const ctx: AdaptiveContext = { ...base, responses: { Q06: { presented: true, answers: { 'conditions.prediabetes': { state: 'known', value: true, sourceIds: [base.source.id] } } }, DM: { presented: true, answers: {}, applicability: 'applicable', applicabilitySourceIds: [base.source.id] } } };
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'DM', field: 'a1c.value', state: 'uncertain', value: 6, quote: 'around 6' }] }, ctx);
    expect(answers(outcome, 'DM')['a1c.value']).toMatchObject({ state: 'uncertain', note: 'around 6' });
    const exact = context('Prediabetes. My A1C was 6.', ['Q06', 'DM']);
    const rejected = interpretIntakeResponse({ ...empty, facts: [{ topic: 'DM', field: 'a1c.value', state: 'uncertain', value: 6, quote: 'My A1C was 6' }] }, { ...exact, responses: { ...ctx.responses } });
    expect(answers(rejected, 'DM')['a1c.value']).toBeUndefined();
    expect(rejected.rejectedCandidates?.map(entry => entry.reason)).toContain('uncertain-without-wording');
  });

  it('fails the turn only for a non-object response and builds a bounded, identity-free request', async () => {
    const ctx = context('Hello', ['Q01']);
    expect(() => interpretIntakeResponse('not json', ctx)).toThrow('invalid-interpreter-output');
    expect(() => interpretIntakeResponse([], ctx)).toThrow('invalid-interpreter-output');
    // Malformed entries are dropped individually.
    const partial = interpretIntakeResponse({ facts: [{ nonsense: true }, { topic: 'Q01', field: 'reason', state: 'known', value: 'Hello', quote: 'Hello' }], items: 'nope' }, ctx);
    expect(partial.updates.map(update => update.path)).toEqual(['reason']);

    const full = context('I take metformin.', register.topics.map(topic => topic.id).filter(id => id !== 'Q18'));
    full.displayedText = 'What medicines do you take?';
    const messages = buildIntakeInterpreterMessages(full);
    expect(messages.map(message => message.role)).toEqual(['system', 'assistant', 'user']);
    expect(messages[2].content).toBe('I take metformin.');
    expect(intakeRequestBytes(messages)).toBeLessThan(30000);
    const serialized = JSON.stringify(messages);
    for (const secret of ['operation-secret', 'session-secret', 'Patient/secret', 'snapshot-secret']) expect(serialized).not.toContain(secret);
    expect((messages[0].content as string).split('FIELD CATALOG')[1]).not.toMatch(/MH0[1-4]|statedAt/);

    const reply = (content: string) => vi.fn(async () => new Response(JSON.stringify({ id: 'r1', model: 'glm-5.3', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'test-key', model: 'glm-5.3' as const, timeoutMs: 1000, maxOutputTokens: 100 };
    await expect(createIntakeInterpreter(config, reply('not json at all')).interpret(ctx)).rejects.toBeInstanceOf(AdaptiveProposalFailure);
    const ok = await createIntakeInterpreter(config, reply('```json\n{"facts":[{"topic":"Q01","field":"reason","state":"known","value":"Hello","quote":"Hello"}]}\n```')).interpret(ctx);
    expect(ok.receipt).toMatchObject({ evidenceProtocol: 'intake-interpreter-v1', model: 'glm-5.3' });
    expect(ok.outcome.updates).toHaveLength(1);
  });
});

// --- Handler integration: accept -> interpret -> next authored question -> review ---
const origin = 'http://127.0.0.1:5173';
const patient = { reference: 'Patient/test', displayName: 'Synthetic Patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
function handlerFixture(interpreter: IntakeInterpreter) {
  const records = new Map<string, FhirResource>();
  let sequence = 0;
  const client = {
    async request(path: string, method = 'GET', body?: FhirResource) {
      if (method === 'GET') {
        const u = new URL(path, 'http://local/fhir/R4/'), key = u.searchParams.get('identifier');
        const resources = key ? [...records.values()].filter(r => (r.identifier as { system: string; value: string }[]).some(i => `${i.system}|${i.value}` === key)) : records.has(path.split('/')[1]) ? [records.get(path.split('/')[1])!] : [];
        return { body: { resourceType: 'Bundle', type: 'searchset', total: resources.length, entry: structuredClone(resources.map(resource => ({ resource }))) } };
      }
      if (method === 'POST') {
        const resource = { ...structuredClone(body!), id: String(++sequence), meta: { versionId: '1' } };
        records.set(resource.id, resource);
        return { body: structuredClone(resource) };
      }
      const id = path.split('/')[1], previous = records.get(id)!;
      const resource = { ...structuredClone(body!), meta: { versionId: String(Number((previous.meta as { versionId: string }).versionId) + 1) } };
      records.set(id, resource);
      return { body: structuredClone(resource) };
    },
    async check() { return { state: 'unknown', present: 0 }; },
    deliver: vi.fn(async () => ({ receipt: { state: 'unknown', present: 0 }, write: 'outcome-unknown' })),
  };
  const runtime = async () => ({ client, qualification: {} } as unknown as Runtime);
  const handler = createClinicHandler(config, { runtime, adaptiveInterpreter: interpreter });
  let cookie = '';
  async function request<T = ClinicSessionView>(path: string, data?: unknown) {
    const response = await handler(new Request(`${origin}${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : { origin, 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json() as T };
  }
  const draft = () => [...records.values()].map(r => decodeDocument<Draft>(r)).find(d => d.schema === 1 && d.requests)!;
  return { request, draft };
}

describe('intake-interpreter-v1 through the clinic handler', () => {
  it('accepts, interprets, shows the guarded acknowledgement before the next authored question, and reviews', async () => {
    const interpret = vi.fn(async (ctx: AdaptiveContext) => ({
      outcome: interpretIntakeResponse({ ...empty, facts: [
        { topic: 'Q01', field: 'reason', state: 'known', value: 'more energy', quote: 'I want more energy' },
        { topic: 'Q01', field: 'priority', state: 'known', value: 'keep up with my kids on weekends', quote: 'keep up with my kids on weekends' },
      ], ack: 'Thanks, I noted that you want more energy for your kids.' }, ctx),
      receipt: { requestId: 'provider-1', model: 'glm-5.3', evidenceProtocol: 'intake-interpreter-v1' as const },
      rawProposal: { facts: [] },
    }));
    const f = handlerFixture({ interpret });
    await f.request('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
    const session = (await f.request('/api/clinic/confirm-identity', { confirmed: true })).body;
    expect(session.adaptive?.available).toBe(true);
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, text: 'I want more energy so I can keep up with my kids on weekends.', channel: 'text' });
    expect(accepted.status).toBe(202);
    const applied = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(applied.body.operation.status).toBe('applied');
    expect(applied.body.operation.hasUnresolvedInterpretation).toBe(false);
    expect(f.draft().topics.Q01?.answers.priority).toMatchObject({ state: 'known', value: 'keep up with my kids on weekends' });
    const prompt = applied.body.session.currentPrompt;
    expect(prompt?.text).toBeTruthy();
    expect(prompt?.topicId).not.toBe('Q01');
    expect(applied.body.session.adaptive?.reply?.text).toBe('Thanks, I noted that you want more energy for your kids.');
    expect(f.draft().adaptive!.operations[accepted.body.operation.id].receipt).toMatchObject({ evidenceProtocol: 'intake-interpreter-v1' });
    const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: applied.body.session.revision });
    expect(review.status).toBe(200);
    expect(JSON.stringify(review.body)).toContain('keep up with my kids on weekends');
  });
});

describe('intake-interpreter-v1 multi-turn journey through the clinic handler', () => {
  it('applies a multi-topic turn, then medicines with a question asked while another topic is displayed', async () => {
    const turns: Record<string, unknown>[] = [
      { ...empty, facts: [
        { topic: 'Q01', field: 'reason', state: 'known', value: 'more energy and to stop snacking at night', quote: 'I want more energy and to stop snacking at night' },
        { topic: 'Q04', field: 'height.value', state: 'known', value: '5 ft 4 in', quote: "I'm 5 foot 4" },
        { topic: 'Q04', field: 'lastMeasuredWeight.value', state: 'known', value: 196, quote: 'last weighed 196 pounds' },
        { topic: 'Q04', field: 'lastMeasuredWeight.unit', state: 'known', value: 'lb', quote: '196 pounds' },
        { topic: 'Q04', field: 'lastMeasuredWeight.measuredWhen', state: 'known', value: 'August', quote: 'in August' },
        { topic: 'Q04', field: 'currentWeightEstimate.value', state: 'known', value: 200, quote: 'probably around 200 now' },
      ], ack: 'Noted your goal, height and weights.' },
      { ...empty, items: [
        { topic: 'Q08', list: 'medicines', existing: null, fields: [
          { field: 'name', state: 'known', value: 'metformin', quote: 'I take metformin 500 mg' }, { field: 'strength', state: 'known', value: '500 mg', quote: 'metformin 500 mg' },
          { field: 'labelDirections', state: 'known', value: 'twice daily with meals', quote: 'the label says twice daily with meals' }, { field: 'actualUse', state: 'known', value: 'only with dinner', quote: 'I only take it with dinner' }] },
        { topic: 'Q08', list: 'medicines', existing: null, fields: [
          { field: 'name', state: 'known', value: 'lisinopril', quote: 'Also lisinopril 10 mg' }, { field: 'strength', state: 'known', value: '10 mg', quote: 'lisinopril 10 mg' }, { field: 'actualUse', state: 'known', value: 'once a day', quote: 'once a day' }] },
      ], questions: [{ quote: 'Should I double my metformin?' }], ack: 'Noted metformin and lisinopril.' },
    ];
    let turn = 0;
    const f = handlerFixture({ interpret: async ctx => ({ outcome: interpretIntakeResponse(turns[turn++], ctx), receipt: { requestId: `p${turn}`, model: 'qwen3.8-max', evidenceProtocol: 'intake-interpreter-v1' as const } }) });
    await f.request('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
    let session = (await f.request('/api/clinic/confirm-identity', { confirmed: true })).body;
    for (const text of ["I want more energy and to stop snacking at night. I'm 5 foot 4, last weighed 196 pounds at my doctor's office in August, probably around 200 now.",
      'I take metformin 500 mg, the label says twice daily with meals but I only take it with dinner. Also lisinopril 10 mg once a day. Should I double my metformin?']) {
      const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, text, channel: 'text' });
      expect(accepted.status).toBe(202);
      const applied = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expect(applied.body.operation.status).toBe('applied');
      session = applied.body.session;
    }
    const meds = f.draft().topics.Q08?.answers.medicines;
    expect(meds?.state === 'known' ? meds.items?.length : 0).toBe(2);
  });
});

describe('intake-interpreter-v1 weight estimate applicability', () => {
  it('keeps a stated current estimate by recording that the older reading is not current, with the same evidence', async () => {
    const text = "Last weighed 196 pounds in August, probably around 200 now.";
    const f = handlerFixture({ interpret: async ctx => ({ outcome: interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q04', field: 'lastMeasuredWeight.value', state: 'known', value: 196, quote: 'Last weighed 196 pounds' },
      { topic: 'Q04', field: 'lastMeasuredWeight.unit', state: 'known', value: 'lb', quote: '196 pounds' },
      { topic: 'Q04', field: 'currentWeightEstimate.value', state: 'known', value: 200, quote: 'probably around 200 now' },
    ] }, ctx), receipt: { requestId: 'p1', model: 'qwen3.8-max', evidenceProtocol: 'intake-interpreter-v1' as const } }) });
    await f.request('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
    const session = (await f.request('/api/clinic/confirm-identity', { confirmed: true })).body;
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, text, channel: 'text' });
    const applied = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    expect(applied.body.operation.status).toBe('applied');
    const q04 = f.draft().topics.Q04!.answers;
    expect(q04['currentWeightEstimate.value']).toMatchObject({ state: 'known', value: 200 });
    expect(q04['lastMeasuredWeight.representsCurrent']).toMatchObject({ state: 'known', value: false });
    expect(q04['lastMeasuredWeight.value']).toMatchObject({ state: 'known', value: 196 });
  });
});

describe('intake-interpreter-v1 topic avoidance through the clinic handler', () => {
  it('shows staff-relevant avoidance in review: declined detail with source and stopReason patient-declines', async () => {
    const f = handlerFixture({ interpret: async ctx => ({ outcome: interpretIntakeResponse({ ...empty, moveOn: { quote: "I'd rather not talk about that" } }, ctx), receipt: { requestId: 'p1', model: 'qwen3.8-max', evidenceProtocol: 'intake-interpreter-v1' as const } }) });
    await f.request('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
    const session = (await f.request('/api/clinic/confirm-identity', { confirmed: true })).body;
    const topicId = session.currentPrompt!.topicId;
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, text: "I'd rather not talk about that right now.", channel: 'text' });
    const applied = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    expect(applied.body.operation.status).toBe('applied');
    expect(applied.body.session.currentPrompt?.topicId).not.toBe(topicId);
    const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: applied.body.session.revision });
    const topic = review.body.session.topics.find(entry => entry.id === topicId)!;
    expect(topic.stopReason).toBe('patient-declines');
    expect(topic.details?.some(detail => detail.state === 'declined' && detail.sourceIds.length === 1)).toBe(true);
  });
});

describe('intake-interpreter-v1 conflicts', () => {
  it('merges two parts of one message for the same text field instead of marking a conflict', () => {
    const ctx = context('More energy, and I want to stop eating at night.', ['Q01']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q01', field: 'reason', state: 'known', value: 'more energy', quote: 'More energy' },
      { topic: 'Q01', field: 'reason', state: 'known', value: 'stop eating at night', quote: 'I want to stop eating at night' },
    ] }, ctx);
    expect(answers(outcome, 'Q01').reason).toMatchObject({ state: 'known', value: 'more energy; stop eating at night' });
    expect(outcome.clarifications).toEqual([]);
  });

  it('a correction inside one message replaces the earlier value instead of joining or conflicting', () => {
    const ctx = context('Metformin 500 mg, no wait, 850 mg. I weigh 200, sorry, 210 pounds.', ['Q04', 'Q08']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      // Out of text order on purpose: position decides, not output order.
      { topic: 'Q04', field: 'lastMeasuredWeight.value', state: 'known', value: 210, quote: '210 pounds' },
      { topic: 'Q04', field: 'lastMeasuredWeight.value', state: 'known', value: 200, quote: 'I weigh 200' },
    ], items: [{ topic: 'Q08', list: 'medicines', existing: null, fields: [
      { field: 'name', state: 'known', value: 'Metformin', quote: 'Metformin 500 mg' },
      { field: 'strength', state: 'known', value: '500 mg', quote: '500 mg' },
      { field: 'strength', state: 'known', value: '850 mg', quote: '850 mg' },
    ] }] }, ctx);
    expect(itemsOf(outcome, 'Q08', 'medicines')[0].answers.strength).toMatchObject({ state: 'known', value: '850 mg' });
    expect(answers(outcome, 'Q04')['lastMeasuredWeight.value']).toMatchObject({ state: 'known', value: 210 });
    expect(outcome.clarifications).toEqual([]);
    // Both values stay on record, the earlier one marked superseded within the same message.
    const strength = outcome.provenance.filter(entry => entry.path.endsWith('.strength'));
    expect(strength.map(entry => [entry.sourceText.join(' '), entry.transform])).toEqual([['500 mg', 'interpreted-v1-superseded-in-message'], ['850 mg', 'interpreted-v1-in-message-correction']]);
    expect(outcome.provenance.filter(entry => entry.path === 'lastMeasuredWeight.value').map(entry => entry.transform)).toEqual(['interpreted-v1', 'interpreted-v1-superseded-in-message']);
  });
  it('a corrected measurement takes the unit of the corrected value, not the superseded one', () => {
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q04', field: 'lastMeasuredWeight.value', state: 'known', value: '200 lb', quote: '200 lb' },
      { topic: 'Q04', field: 'lastMeasuredWeight.value', state: 'known', value: '90 kg', quote: '90 kg' },
    ] }, context('I weigh 200 lb, no wait, 90 kg.', ['Q04']));
    expect(answers(outcome, 'Q04')).toMatchObject({ 'lastMeasuredWeight.value': { state: 'known', value: 90 }, 'lastMeasuredWeight.unit': { state: 'known', value: 'kg' } });
    expect(outcome.clarifications).toEqual([]);
  });
  it.each([
    ['I take one tablet in the morning, then wait until bedtime. At night I take two tablets.', 'one tablet in the morning', 'two tablets'],
    ['One in the morning. Sorry, I am a bit nervous about all this. Two at night as well.', 'One in the morning', 'Two at night'],
  ])('ordinary "wait" or "sorry" between two facts is not a correction: %s', (text, first, second) => {
    const outcome = interpretIntakeResponse({ ...empty, items: [{ topic: 'Q08', list: 'medicines', existing: null, fields: [
      { field: 'name', state: 'known', value: 'metformin', quote: null },
      { field: 'actualUse', state: 'known', value: first, quote: first },
      { field: 'actualUse', state: 'known', value: second, quote: second },
    ] }] }, context(`Metformin. ${text}`, ['Q08']));
    expect(outcome.provenance.some(entry => entry.transform.endsWith('superseded-in-message'))).toBe(false);
    expect(itemsOf(outcome, 'Q08', 'medicines')[0]?.answers.actualUse).toMatchObject({ state: 'known', value: `${first}; ${second}` });
  });
  it('"and ... actually" adds to a text answer rather than correcting it', () => {
    const ctx = context('More energy, and actually to sleep better too.', ['Q01']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q01', field: 'reason', state: 'known', value: 'more energy', quote: 'More energy' },
      { topic: 'Q01', field: 'reason', state: 'known', value: 'sleep better', quote: 'to sleep better' },
    ] }, ctx);
    expect(answers(outcome, 'Q01').reason).toMatchObject({ state: 'known', value: 'more energy; sleep better' });
  });
  it('an answer to a field marked conflicting resolves it and keeps the earlier sources on record', () => {
    const first = context('I want more energy.', ['Q01']);
    const conflicted = { ...first.responses, Q01: { presented: true, answers: { reason: { state: 'conflicting' as const, sourceIds: [first.source.id], note: 'Patient statements differ; clarification is needed.' } } } };
    const ctx = nextTurn({ ...first, responses: conflicted }, { responses: conflicted } as unknown as AdaptiveOutcome, 'Mostly the energy, honestly.');
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q01', field: 'reason', state: 'known', value: 'more energy', quote: 'Mostly the energy' }] }, ctx);
    expect(answers(outcome, 'Q01').reason).toMatchObject({ state: 'known', value: 'more energy' });
    expect(outcome.provenance).toEqual([expect.objectContaining({ path: 'reason', correctsSourceIds: [first.source.id] })]);
    expect(outcome.clarifications).toEqual([]);
  });
});

describe('intake-interpreter-v1 engagement choice', () => {
  it('moves on when the reply to "move on or come back" adds nothing, so the prompt cannot loop', () => {
    const base = context("Let's come back to it later.", ['Q02', 'Q03']);
    const ctx = { ...base, displayed: { topicId: 'Q02', promptId: '__engagement-choice', targetPaths: ['onset'] } };
    const outcome = interpretIntakeResponse({ ...empty }, ctx);
    expect(outcome.responses.Q02).toMatchObject({ stopped: 'patient-moves-on' });
    expect(outcome.acts).toEqual([expect.objectContaining({ kind: 'move-on', targetTopicId: 'Q02' })]);
  });

  it('keeps a real answer given at the engagement choice instead of moving on', () => {
    const base = context('It started about two months ago.', ['Q02']);
    const ctx = { ...base, displayed: { topicId: 'Q02', promptId: '__engagement-choice', targetPaths: ['onset'] },
      responses: { Q02: { presented: true, answers: { concern: { state: 'known' as const, value: 'tired all the time', sourceIds: [base.source.id] } } } } };
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q02', field: 'onset', state: 'known', value: 'about two months ago', quote: 'about two months ago' }] }, ctx);
    expect(outcome.responses.Q02?.stopped).toBeUndefined();
    expect(answers(outcome, 'Q02').onset).toMatchObject({ state: 'known', value: 'about two months ago' });
  });
});

describe('intake-interpreter-v1 grounded replies and clarification pointers', () => {
  it('drops an acknowledgement that adds numbers or details the patient did not say', () => {
    const ctx = context('I want more energy.', ['Q01']);
    const fact = { topic: 'Q01', field: 'reason', state: 'known', value: 'more energy', quote: 'I want more energy' };
    expect(interpretIntakeResponse({ ...empty, facts: [fact], ack: 'Noted that you want more energy.' }, ctx).acknowledgement).toBe('Noted that you want more energy.');
    const invented = interpretIntakeResponse({ ...empty, facts: [fact], ack: 'Noted you want more energy after losing 10 lb with tracking points.' }, ctx);
    expect(invented.updates.length).toBeGreaterThan(0);
    expect(invented.acknowledgement).toBeUndefined();
  });

  it('never stores a clarification pointer such as "keep the first thing I said" as clinical content', () => {
    const first = context('I want more energy.', ['Q01']);
    const conflicted = { ...first.responses, Q01: { presented: true, answers: { reason: { state: 'conflicting' as const, sourceIds: [first.source.id] } } } };
    const ctx = nextTurn({ ...first, responses: conflicted }, { responses: conflicted } as unknown as AdaptiveOutcome, 'Keep the first thing I said.');
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q01', field: 'reason', state: 'known', value: 'keep the first thing I said', quote: 'Keep the first thing I said' }] }, ctx);
    expect(answers(outcome, 'Q01').reason).toMatchObject({ state: 'conflicting' });
  });

  it('appends an elaboration when a follow-up asks for more about an answered text field', () => {
    const first = context('I want more energy.', ['Q01']);
    const known = { ...first.responses, Q01: { presented: true, answers: { reason: { state: 'known' as const, value: 'more energy', sourceIds: [first.source.id] } } } };
    const next = nextTurn({ ...first, responses: known }, { responses: known } as unknown as AdaptiveOutcome, 'Also to sleep better.');
    const ctx = { ...next, displayed: { topicId: 'Q01', promptId: 'Q01.followup.1', targetPaths: ['reason'] } };
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q01', field: 'reason', state: 'known', value: 'to sleep better', quote: 'to sleep better' }] }, ctx);
    expect(answers(outcome, 'Q01').reason).toMatchObject({ state: 'known', value: 'more energy; to sleep better' });
  });
});

describe('intake-interpreter-v1 list identity and cycle guard', () => {
  it('a restated list item updates the existing item instead of adding a duplicate; mother never matches grandmother', () => {
    const first = context('I tried WW.', ['Q05', 'Q10']);
    const saved = { ...first.responses,
      Q05: { presented: true, answers: { approaches: { state: 'known' as const, sourceIds: [first.source.id], items: [{ id: 'aold_0', sourceIds: [first.source.id], answers: { approach: { state: 'known' as const, value: 'WW', sourceIds: [first.source.id] } } }] } } },
      Q10: { presented: true, answers: { familyHistory: { state: 'known' as const, sourceIds: [first.source.id], items: [{ id: 'aold_1', sourceIds: [first.source.id], answers: { condition: { state: 'known' as const, value: 'diabetes', sourceIds: [first.source.id] }, relationship: { state: 'known' as const, value: 'grandmother', sourceIds: [first.source.id] } } }] } } } };
    const ctx = nextTurn({ ...first, responses: saved }, { responses: saved } as unknown as AdaptiveOutcome, 'The WW program was in 2022. My mother has diabetes too.');
    const outcome = interpretIntakeResponse({ ...empty, items: [
      { topic: 'Q05', list: 'approaches', existing: null, fields: [{ field: 'approach', state: 'known', value: 'the WW program', quote: 'The WW program' }, { field: 'period', state: 'known', value: 'in 2022', quote: 'in 2022' }] },
      { topic: 'Q10', list: 'familyHistory', existing: null, fields: [{ field: 'relationship', state: 'known', value: 'mother', quote: 'My mother' }, { field: 'condition', state: 'known', value: 'diabetes', quote: 'has diabetes' }] },
    ] }, ctx);
    expect(itemsOf(outcome, 'Q05', 'approaches')).toHaveLength(1);
    expect(itemsOf(outcome, 'Q05', 'approaches')[0].answers.period).toMatchObject({ state: 'known', value: 'in 2022' });
    expect(itemsOf(outcome, 'Q10', 'familyHistory')).toHaveLength(2);
  });

  it('never shows the same question a third time in a session, even when every turn is unresolved', async () => {
    const f = handlerFixture({ interpret: async ctx => ({ outcome: { responses: ctx.responses, updates: [], provenance: [], acts: [], sourceId: ctx.source.id, hasUnresolvedInterpretation: true,
      clarifications: [{ topicId: 'Q01', path: 'reason', reason: 'conflict' as const, evidence: [] }] } as AdaptiveOutcome, receipt: { requestId: 'p', model: 'qwen3.8-max', evidenceProtocol: 'intake-interpreter-v1' as const } }) });
    await f.request('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
    let session = (await f.request('/api/clinic/confirm-identity', { confirmed: true })).body;
    const shown: string[] = [session.currentPrompt!.text];
    for (let turn = 0; turn < 80 && session.currentPrompt; turn++) {
      const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, text: `Answer number ${turn}.`, channel: 'text' });
      const applied = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
      session = applied.body.session;
      if (session.currentPrompt) shown.push(session.currentPrompt.text);
    }
    for (const text of shown) expect(shown.filter(entry => entry === text).length, text).toBeLessThanOrEqual(2);
    // Long enough to exhaust adaptive questions and reach the guided fallback, which must not loop either.
    expect(shown.length).toBeGreaterThan(30);
  }, 60000);
});

describe('intake-interpreter-v1 answer specificity', () => {
  it('a medicine described by its purpose is a medicine, never the condition it is for', () => {
    const ctx = context('I take some pills for my heart and arthritis meds.', ['Q06', 'Q08']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [
      { topic: 'Q06', field: 'conditions.heartDisease', state: 'known', value: true, quote: 'pills for my heart' },
      { topic: 'Q06', field: 'conditions.joint', state: 'known', value: true, quote: 'arthritis meds' },
    ], items: [
      { topic: 'Q08', list: 'medicines', existing: null, fields: [{ field: 'name', state: 'known', value: 'pills for my heart', quote: 'pills for my heart' }] },
      { topic: 'Q08', list: 'medicines', existing: null, fields: [{ field: 'name', state: 'known', value: 'arthritis meds', quote: 'arthritis meds' }] },
    ] }, ctx);
    expect(answers(outcome, 'Q06')['conditions.heartDisease']).toBeUndefined();
    expect(answers(outcome, 'Q06')['conditions.joint']).toBeUndefined();
    expect(outcome.rejectedCandidates?.map(candidate => candidate.reason)).toEqual(['condition-from-medicine-purpose', 'condition-from-medicine-purpose']);
    expect(itemsOf(outcome, 'Q08', 'medicines').map(item => item.answers.name)).toMatchObject([{ value: 'pills for my heart' }, { value: 'arthritis meds' }]);
  });
  it('a purpose clause ends at "because": the condition reported after it is still recorded', () => {
    const ctx = context('I take pills for my heart because I had a heart attack.', ['Q06']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q06', field: 'conditions.heartDisease', state: 'known', value: true, quote: 'pills for my heart because I had a heart attack' }] }, ctx);
    expect(answers(outcome, 'Q06')['conditions.heartDisease']).toMatchObject({ state: 'known' });
  });
  it('a condition named outright next to a medicine purpose is still recorded', () => {
    const ctx = context('I have heart disease, so I take pills for my heart.', ['Q06']);
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q06', field: 'conditions.heartDisease', state: 'known', value: true, quote: 'I have heart disease' }] }, ctx);
    expect(answers(outcome, 'Q06')['conditions.heartDisease']).toMatchObject({ state: 'known' });
  });
  it('the prompt carries a REFERENCE block of exact names in this message only', () => {
    const [system] = buildIntakeInterpreterMessages(context('I take Ozempic and metformin for type 2 diabetes. Lots of water too.', ['Q08']));
    const text = String(system!.content);
    expect(text).toContain('REFERENCE (exact name matches in this message)\n"ozempic" = medication name\n"metformin" = medication name\n"type 2 diabetes" = condition name (Type 2 diabetes mellitus without complications)');
    expect(text).not.toContain('"water"');
    expect(String(buildIntakeInterpreterMessages(context('I walk every day.', ['Q14']))[0]!.content)).not.toContain('REFERENCE (exact');
  });
  const followUp = (text: string) => {
    const ctx = context(text, ['Q08']);
    ctx.sources = [{ id: 'prior', role: 'patient', text: 'I take some pills for my heart.', at: '2026-10-09T11:00:00.000Z' }, ...ctx.sources];
    ctx.responses = { Q08: { presented: true, answers: { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'm1', answers: { name: { state: 'known', value: 'pills for my heart', sourceIds: ['prior'] } } }] } } } };
    ctx.displayed = { topicId: 'Q08', promptId: 'B02', targetPaths: ['medicines[m1].name'], specificity: { key: 'Q08:medicines[m1].name' } };
    return ctx;
  };
  it('a named reply to a follow-up adds to the description even when the model calls it a correction (recorded live output)', () => {
    const ctx = followUp("Oh, it's metoprolol, 25 mg.");
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q08', field: 'medicines[m1].name', state: 'known', value: 'metoprolol', quote: "it's metoprolol", corrects: 1 }],
      items: [{ topic: 'Q08', list: 'medicines', existing: 'm1', fields: [{ field: 'name', state: 'known', value: 'metoprolol', quote: "it's metoprolol" }, { field: 'strength', state: 'known', value: '25 mg', quote: '25 mg' }] }] }, ctx);
    expect(outcome.clarifications).toEqual([]);
    expect(itemsOf(outcome, 'Q08', 'medicines')[0]!.answers).toMatchObject({ name: { state: 'known', value: 'pills for my heart; metoprolol' }, strength: { value: '25 mg' } });
  });
  it('"I\'ll bring the bottle" to a follow-up keeps the description and is not an unresolved turn (recorded live output)', () => {
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q08', field: 'medicines[m1].name', state: 'unknown', value: null, quote: "I'm not sure" }] }, followUp("I'm not sure, I'll bring the bottle next time."));
    expect(outcome.updates).toEqual([]);
    expect(outcome.clarifications).toEqual([]);
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
  });
  it('"Yes" to a spelling question is settled even when the model restates the name with a quote it cannot support', () => {
    const ctx = followUp('Yes');
    ctx.displayed = { ...ctx.displayed!, specificity: { key: 'Q08:medicines[m1].name', spelling: { system: 'rxnorm', code: '6809', display: 'metformin' } } };
    const outcome = interpretIntakeResponse({ ...empty, items: [{ topic: 'Q08', list: 'medicines', existing: 'm1', fields: [{ field: 'name', state: 'known', value: 'metformin', quote: 'metformin' }] }] }, ctx);
    expect(itemsOf(outcome, 'Q08', 'medicines')[0]!.answers.name).toMatchObject({ value: 'pills for my heart' });
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
  });
  it('"Yes" to a spelling question is settled even when the model files it under another question (recorded live output)', () => {
    const ctx = followUp('Yes');
    ctx.displayed = { ...ctx.displayed!, specificity: { key: 'Q08:medicines[m1].name', spelling: { system: 'rxnorm', code: '6809', display: 'metformin' } } };
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q02', field: 'concern', state: 'known', value: 'yes', quote: 'Yes' }] }, { ...ctx, topics: [...ctx.topics, ...context('x', ['Q02']).topics] });
    expect(outcome.updates).toEqual([]);
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
  });
  it('"I don\'t know" to a follow-up is never filed as an answer to a different question', () => {
    const ctx = followUp("I don't know what it was exactly.");
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q02', field: 'concern', state: 'unknown', value: null, quote: "I don't know what it was exactly" }] }, { ...ctx, topics: [...ctx.topics, ...context('x', ['Q02']).topics] });
    expect(outcome.updates).toEqual([]);
    expect(outcome.rejectedCandidates?.map(entry => entry.reason)).toEqual(['follow-up-reply-elsewhere']);
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
  });
  it.each([
    ["I'll bring the bottle. I don't know my height.", { topic: 'Q04', field: 'height.value', state: 'unknown', value: null, quote: "I don't know my height" }],
    ["I'll bring it. I get a rash from penicillin.", { topic: 'Q09', field: 'allergy', state: 'known', value: 'penicillin rash', quote: "I'll bring it. I get a rash from penicillin." }],
  ])('a follow-up reply that also says something new keeps that content: %s', (text, fact) => {
    const ctx = followUp(text);
    const outcome = interpretIntakeResponse({ ...empty, facts: [fact] }, { ...ctx, topics: [...ctx.topics, ...context('x', ['Q04', 'Q09']).topics] });
    expect(outcome.updates.length > 0 || outcome.hasUnresolvedInterpretation).toBe(true);
  });
  it('an unrelated reply to a spelling question is not settled by the question alone', () => {
    const ctx = followUp('No, and I get a rash from antibiotics.');
    ctx.displayed = { ...ctx.displayed!, specificity: { key: 'Q08:medicines[m1].name', spelling: { system: 'rxnorm', code: '6809', display: 'metformin' } } };
    expect(interpretIntakeResponse(empty, ctx).hasUnresolvedInterpretation).toBe(true);
  });
  it('an explicit correction in reply to a follow-up replaces the earlier words, with lineage', () => {
    const ctx = context('No, actually daily now, I was wrong about occasionally.', ['Q14']);
    ctx.sources = [{ id: 'prior', role: 'patient', text: 'I walk occasionally.', at: '2026-10-09T11:00:00.000Z' }, ...ctx.sources];
    ctx.responses = { Q14: { presented: true, answers: { frequency: { state: 'known', value: 'occasionally', sourceIds: ['prior'] } } } };
    ctx.displayed = { topicId: 'Q14', promptId: 'B02', targetPaths: ['frequency'], specificity: { key: 'Q14:frequency' } };
    const outcome = interpretIntakeResponse({ ...empty, facts: [{ topic: 'Q14', field: 'frequency', state: 'known', value: 'daily', quote: 'actually daily now', corrects: 1 }] }, ctx);
    expect(answers(outcome, 'Q14').frequency).toMatchObject({ state: 'known', value: 'daily' });
    expect(outcome.provenance.find(entry => entry.path === 'frequency')?.correctsSourceIds).toEqual(['prior']);
  });
});
