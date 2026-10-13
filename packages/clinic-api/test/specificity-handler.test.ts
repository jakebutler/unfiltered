import { describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import type { Runtime } from '../src/runtime.js';
import { readDraft } from '../src/store.js';
import type { SafetyReviewer } from '../src/safety-review.js';
import { interpretIntakeResponse, type IntakeInterpreter } from '../src/intake-interpreter.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
import type { ClinicApiConfig } from '../src/types.js';
import type { ClinicSessionView } from '../../clinic-contract/src/index.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';

const origin = 'http://localhost:5173';
const patient = { reference: 'Patient/fixture', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
const empty = { facts: [], items: [], listsDone: [], questions: [], moveOn: null, ack: null };
const cleared: SafetyReviewer = { review: vi.fn(async () => ({ concern: false, level: 'none', categories: [], rationale: '', model: 'qwen3.8-max' })) } as never;

/** The id of the first medicine already on record, for a scripted correction of that same item. */
const firstMedicine = (context: AdaptiveContext) => { const list = context.responses.Q08?.answers.medicines; return list?.state === 'known' ? list.items?.[0]?.id ?? null : null; };
/** Scripted interpreter: the name the patient used becomes the medicine name, quoted from their own words. */
function scripted(names: Record<string, string>): IntakeInterpreter {
  return { interpret: vi.fn(async (context: AdaptiveContext) => {
    const name = Object.entries(names).find(([text]) => context.source.text === text)?.[1];
    const proposal = name ? { ...empty, items: [{ topic: 'Q08', list: 'medicines', existing: firstMedicine(context), fields: [{ field: 'name', state: 'known', value: name, quote: name }] }] } : empty;
    return { outcome: interpretIntakeResponse(proposal, context) };
  }) };
}
async function fixture(interpreter: IntakeInterpreter, topicId = 'Q08') {
  const client = new MedplumClient({ baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic', mode: 'local', timeoutMs: 1000 }, mockFhir({ atomic: false }).fetcher);
  const handler = createClinicHandler(config, { runtime: async () => ({ client, qualification: {} } as unknown as Runtime), safetyReviewer: cleared, adaptiveInterpreter: interpreter });
  let cookie = '', current: ClinicSessionView;
  const call = async <T = ClinicSessionView>(path: string, data: unknown) => {
    const response = await handler(new Request(origin + path, { method: 'POST', headers: { origin, 'Content-Type': 'application/json', cookie }, body: JSON.stringify(data) }));
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0];
    return { status: response.status, body: await response.json() as T };
  };
  await call('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
  current = (await call('/api/clinic/confirm-identity', { confirmed: true })).body;
  // Start at the topic's question, as if the conversation had reached it.
  current = (await call('/api/clinic/topics', { expectedRevision: current.revision, topicId })).body;
  const say = async (text: string) => {
    const accepted = await call<{ session: ClinicSessionView; operation: { id: string } }>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: current.revision, text, channel: 'text' });
    expect(accepted.status).toBe(202);
    const done = await call<{ session: ClinicSessionView; operation: { status: string } }>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    expect(done.body.operation.status).toBe('applied');
    current = done.body.session; return current;
  };
  return { say, current: () => current, draft: async () => (await readDraft(client, current.id, patient.reference)).draft };
}
const medicines = (view: ClinicSessionView) => view.topics.find(topic => topic.id === 'Q08')!;
const nameDetail = (view: ClinicSessionView) => medicines(view).details!.find(detail => /^medicines\[[^\]]+\]\.name$/.test(detail.id))!;

describe('answer specificity in natural conversation', () => {
  it('asks once for the name behind a description, and "I\'ll bring the bottle" settles it as a visible gap', async () => {
    const f = await fixture(scripted({ 'I take some pills for my heart every morning.': 'pills for my heart' }));
    const asked = await f.say('I take some pills for my heart every morning.');
    expect(asked.currentPrompt?.text).toBe("You mentioned “pills for my heart”. Do you know the name of that medicine? It's printed on the label. It's fine to say you don't know, or that you'll bring it to your visit.");
    const settled = await f.say("I'll bring the bottle to my visit.");
    expect(settled.currentPrompt?.text).not.toContain('pills for my heart');
    const [key, state] = Object.entries((await f.draft()).specificity!)[0];
    expect(key).toMatch(/^Q08:medicines\[[^\]]+\]\.name$/);
    expect(state).toMatchObject({ asked: 1, terminal: 'will-provide' });
    // The description stays the patient's answer; the missing name is a visible gap, never complete.
    expect(nameDetail(settled)).toMatchObject({ text: 'pills for my heart', specificity: { needsDetail: 'Name of the medicine (patient will bring or check it)' } });
    expect(medicines(settled).missingDetails).toContain('Name of the medicine: “pills for my heart”');
    expect(medicines(settled).answer?.text).toContain('[needs detail: Name of the medicine (patient will bring or check it)]');
    expect(settled.completeness).toBe('partial');
  });
  it('a named reply keeps the description and attaches the exact RxNorm match', async () => {
    const f = await fixture(scripted({ 'I take some pills for my heart every morning.': 'pills for my heart', "It's metformin.": 'metformin' }));
    await f.say('I take some pills for my heart every morning.');
    const named = await f.say("It's metformin.");
    expect(nameDetail(named)).toMatchObject({ text: 'pills for my heart; metformin', specificity: { code: { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '6809', display: 'metformin', basis: 'exact' } } });
    expect(nameDetail(named).specificity?.needsDetail).toBeUndefined();
  });
  it('"I don\'t know" to the follow-up never overwrites the description or creates a conflict', async () => {
    const unknown: IntakeInterpreter = { interpret: vi.fn(async (context: AdaptiveContext) => {
      const id = firstMedicine(context);
      const proposal = context.source.text === 'I take some pills for my heart every morning.'
        ? { ...empty, items: [{ topic: 'Q08', list: 'medicines', existing: null, fields: [{ field: 'name', state: 'known', value: 'pills for my heart', quote: 'pills for my heart' }] }] }
        : { ...empty, items: [{ topic: 'Q08', list: 'medicines', existing: id, fields: [{ field: 'name', state: 'unknown', value: null, quote: "I don't know" }] }] };
      return { outcome: interpretIntakeResponse(proposal, context) };
    }) };
    const f = await fixture(unknown);
    await f.say('I take some pills for my heart every morning.');
    const view = await f.say("I don't know what it's called.");
    expect(nameDetail(view)).toMatchObject({ state: 'answered', text: 'pills for my heart', specificity: { needsDetail: "Name of the medicine (patient doesn't know)" } });
    expect(Object.values((await f.draft()).specificity!)[0]).toMatchObject({ terminal: 'unknown' });
  });
  it('offers a close spelling once as a question; "yes" confirms it without replacing the patient\'s words', async () => {
    const f = await fixture(scripted({ 'I take metfromin twice a day.': 'metfromin' }));
    const asked = await f.say('I take metfromin twice a day.');
    expect(asked.currentPrompt?.text).toBe('Did you mean “metformin”? If not, please spell the name as it appears on the label.');
    const confirmed = await f.say('Yes');
    expect(nameDetail(confirmed)).toMatchObject({ text: 'metfromin', specificity: { code: { code: '6809', display: 'metformin', basis: 'patient-confirmed' } } });
    expect(nameDetail(confirmed).specificity?.needsDetail).toBeUndefined();
    expect(confirmed.currentPrompt?.text ?? '').not.toContain('Did you mean');
  });
  it('stops asking after the per-field budget even when the answer stays vague', async () => {
    const f = await fixture(scripted({ 'I take some pills for my heart every morning.': 'pills for my heart', 'Just my heart pills.': 'heart pills', 'The small white pills.': 'small white pills' }));
    await f.say('I take some pills for my heart every morning.');
    const second = await f.say('Just my heart pills.');
    expect(second.currentPrompt?.text).toContain('You mentioned “pills for my heart; heart pills”');
    const third = await f.say('The small white pills.');
    expect(third.currentPrompt?.text ?? '').not.toContain('You mentioned');
    expect(Object.values((await f.draft()).specificity!)[0]).toMatchObject({ asked: 2 });
    expect(nameDetail(third).specificity?.needsDetail).toBe('Name of the medicine');
  });
});

/** Naming follow-ups lead their topic, so each is asked next through the native prompt guard. Detail follow-ups
 * (time, amount, frequency) wait for the topic's core questions; test/specificity.test.ts covers every contract. */
const cases: { topicId: string; list?: string; field: string; text: string; value: string; asks: string }[] = [
  { topicId: 'Q06', list: 'reportedConditions', field: 'term', text: 'I have some heart problems.', value: 'heart problems', asks: 'You mentioned “heart problems”. Do you know what the condition is called' },
  { topicId: 'Q10', list: 'familyHistory', field: 'condition', text: 'My mom had sugar issues.', value: 'sugar issues', asks: 'You mentioned “sugar issues”. Do you know what condition it was' },
  { topicId: 'Q07', list: 'events', field: 'event', text: 'I had a surgery a while ago.', value: 'a surgery', asks: 'You mentioned “a surgery”. Do you know what the procedure was called' },
  { topicId: 'Q09', list: 'reactions', field: 'substance', text: 'I react badly to some antibiotic.', value: 'some antibiotic', asks: 'You mentioned “some antibiotic”. Do you know the name of the medicine or substance' },
  { topicId: 'Q19', list: 'clinicians', field: 'owner', text: 'My doctor handles that.', value: 'My doctor', asks: 'You mentioned “My doctor”. What is their name' },
  { topicId: 'Q05', list: 'approaches', field: 'approach', text: 'I tried a diet.', value: 'a diet', asks: 'You mentioned “a diet”. Do you remember the name of the program' },
];
describe.each(cases)('specificity follow-up for $topicId $field', ({ topicId, list, field, text, value, asks }) => {
  it('is asked with authored wording through the native guard', async () => {
    const interpreter: IntakeInterpreter = { interpret: vi.fn(async (context: AdaptiveContext) => {
      const proposal = context.source.text === text ? list ? { ...empty, items: [{ topic: topicId, list, existing: null, fields: [{ field, state: 'known', value, quote: value }] }] } : { ...empty, facts: [{ topic: topicId, field, state: 'known', value, quote: value }] } : empty;
      return { outcome: interpretIntakeResponse(proposal, context) };
    }) };
    const f = await fixture(interpreter, topicId);
    const view = await f.say(text);
    expect(view.currentPrompt?.text).toContain(asks);
  });
});
