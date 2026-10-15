import { describe, expect, it } from 'vitest';
import { createSpeechAccess } from '../src/speech-access.js';
import { cookies, type Claims } from '../src/cookies.js';
import { conversation } from '../src/conversation.js';
import { DRAFT_SYSTEM, document } from '../src/store.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import { exactSpokenChoice } from '../../clinic-contract/src/choice-voice.js';
import { promptAllowsFreeText } from '../../clinic-contract/src/prompt-input.js';
import type { PromptView } from '../../clinic-contract/src/index.js';

// Voice coverage for the six non-intake workflows (W02-W07). Mirrors the
// first-intake fixtures in speech-access.test.ts and choice-voice.test.ts.
const origin = 'http://127.0.0.1:5173';
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const scenarios = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'] as const;
type Scenario = typeof scenarios[number];
const config = { origin, cookieSecret: 'workflow-voice-secret'.repeat(4), mentalHealth: 'phq4', patients: Object.fromEntries(scenarios.map(id => [id, patient])) } as ClinicApiConfig;
const content = conversation(config);
const nonIntake: readonly Scenario[] = ['pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'];

function draftFor(scenario: Scenario): Draft {
  const at = new Date().toISOString();
  return { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario, revision: 3, savedAt: at, createdAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
}

async function fixture(scenario: Scenario, prepare: (d: Draft) => Draft = d => d) {
  let draft = prepare(draftFor(scenario));
  const resource = () => ({ ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft), id: 'draft', meta: { versionId: '1' } });
  const runtime = async () => ({ client: { request: async () => ({ body: { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: resource() }] } }) } } as unknown as Runtime);
  const access = createSpeechAccess(config, { enabled: true, runtime, adaptiveAvailable: true });
  const claims: Claims = { kind: 'patient', sessionId: draft.id, patient: draft.patient, scenario, identityConfirmed: true, expires: Date.now() + 100000 };
  const cookie = (await cookies(config.cookieSecret, false).issue('clinic_patient', claims)).split(';')[0];
  const request = new Request(`${origin}/api/clinic/speech/input`, { headers: { origin, cookie } });
  const scope = (promptId: string) => ({ sessionId: draft.id, expectedRevision: draft.revision, promptId, requestId: crypto.randomUUID() });
  const current = () => content.view(draft, true, true).currentPrompt!;
  return { access, request, draft: () => draft, set: (d: Draft) => { draft = d; }, scope, current };
}

/** Walks a slot of a non-intake workflow through the same select/view path the conversation uses. */
const select = (_scenario: Scenario, topicId: string, slot: string) => (d: Draft) => content.select(d, topicId, slot);
/** Non-visit reuses Q16 only once it is marked relevant, as the conversation does. */
const nonVisitPhq = (item: string) => (d: Draft) => content.select({ ...d, relevantTopicIds: ['Q16'] }, 'Q16', item);

describe('non-intake speakability (read-aloud for every workflow prompt)', () => {
  it.each(nonIntake)('%s opening prompt is read aloud through the speech output boundary', async scenario => {
    const f = await fixture(scenario), prompt = f.current();
    const spoken = await f.access.output(f.request, { requestId: crypto.randomUUID(), sessionId: f.draft().id, expectedRevision: f.draft().revision, sourceId: prompt.id });
    expect(spoken.text).toContain(prompt.text);
    expect(spoken.text.length).toBeGreaterThan(0);
  });

  it.each(nonIntake)('%s free-text prompts are startable for voice answer, choice prompts are not hands-free', async scenario => {
    const f = await fixture(scenario), prompt = f.current();
    const allowsText = promptAllowsFreeText(prompt, false);
    const opening = await f.access.token(f.request, f.scope(prompt.id)).then(() => 'minted', error => error.code);
    if (allowsText) expect(opening).toBe('minted');
    else expect(opening).toBe('speech-buttons-only');
  });
});

describe('W05 billing and W06 scheduling choice slots by voice', () => {
  const choiceSlots: Array<[Scenario, string, string]> = [
    ['billing', 'W05', 'issueType'], ['billing', 'W05', 'requestedResolution'],
    ['scheduling', 'W06', 'intent'], ['scheduling', 'W06', 'visitCategory'], ['scheduling', 'W06', 'preferredDay'], ['scheduling', 'W06', 'preferredWindow'], ['scheduling', 'W06', 'timezone'],
  ];
  it.each(choiceSlots)('%s %s.%s presents exact spoken labels that map only to their own values', async (scenario, topic, slot) => {
    const f = await fixture(scenario, d => select(scenario, topic, slot)(d));
    const prompt = content.view(f.draft(), true, true).currentPrompt!;
    expect(prompt.topicId).toBe(topic);
    expect(prompt.choices?.length).toBeGreaterThan(1);
    for (const choice of prompt.choices!) {
      expect(exactSpokenChoice(prompt, choice.label)?.value).toBe(choice.value);
      expect(exactSpokenChoice(prompt, `${choice.label}.`)?.value).toBe(choice.value);
    }
  });

  it.each([
    ['billing', 'W05', 'issueType', 'bill', 'a bill'],
    ['billing', 'W05', 'requestedResolution', 'explain', 'review'],
    ['scheduling', 'W06', 'preferredDay', 'Tues', 'Monday or Tuesday'],
    ['scheduling', 'W06', 'preferredWindow', 'morning-ish', 'Morning and evening'],
    ['scheduling', 'W06', 'timezone', 'pacific', 'Eastern or Pacific'],
  ] as const)('%s %s.%s does not select a value for ambiguous or partial speech %j', async (scenario, topic, slot, partial) => {
    const f = await fixture(scenario, d => select(scenario, topic, slot)(d));
    const prompt = content.view(f.draft(), true, true).currentPrompt!;
    expect(exactSpokenChoice(prompt, partial)).toBeUndefined();
  });

  it('does not treat a raw stored value as a spoken label', async () => {
    const f = await fixture('billing', d => select('billing', 'W05', 'issueType')(d));
    const prompt = content.view(f.draft(), true, true).currentPrompt!;
    expect(exactSpokenChoice(prompt, 'bill-question')).toBeUndefined();
    expect(exactSpokenChoice(prompt, 'America/Los_Angeles')).toBeUndefined();
  });

  // BUG: a confirmed-transcript answer whose text is the raw stored value ("bill-question") is accepted and saved as a known choice with no explicit confirmation; PHQ items throw explicit-choice-confirmation-required for the same channel.
  it.fails('a spoken answer without an explicit confirmation does not store a choice value on W05 issueType', async () => {
    const f = await fixture('billing', d => select('billing', 'W05', 'issueType')(d));
    const prompt = content.view(f.draft(), true, true).currentPrompt!;
    const input = { requestId: crypto.randomUUID(), expectedRevision: f.draft().revision, promptId: prompt.id, action: 'answer' as const, text: 'bill-question', channel: 'confirmed-transcript' as const };
    expect(() => content.turn(f.draft(), input)).toThrow('explicit-choice-confirmation-required');
  });
});

describe('PHQ-4 items remain buttons-only in every scenario that reaches them', () => {
  it('Q16 is only reachable in non-visit and first-intake, never in other short workflows', () => {
    for (const scenario of nonIntake.filter(id => id !== 'non-visit')) {
      expect(() => content.select(draftFor(scenario), 'Q16', 'MH01')).toThrow();
    }
  });

  it('non-visit PHQ item rejects hands-free mint and free-text speech without an explicit choice', async () => {
    const f = await fixture('non-visit', nonVisitPhq('MH01'));
    const prompt = f.current();
    expect(prompt.id).toBe('Q16:MH01');
    await expect(f.access.token(f.request, f.scope(prompt.id))).rejects.toMatchObject({ code: 'speech-buttons-only' });
    expect(() => content.turn(f.draft(), { requestId: crypto.randomUUID(), expectedRevision: f.draft().revision, promptId: prompt.id, action: 'answer', text: '2', channel: 'confirmed-transcript' })).toThrow('explicit-screening-choice-required');
    expect(() => content.turn(f.draft(), { requestId: crypto.randomUUID(), expectedRevision: f.draft().revision, promptId: prompt.id, action: 'answer', text: '2', channel: 'unreviewed-transcript' })).toThrow('explicit-screening-choice-required');
  });

  it('non-visit PHQ item keeps the frozen MH stem and every option read-aloud', async () => {
    const f = await fixture('non-visit', nonVisitPhq('MH02'));
    const spoken = await f.access.output(f.request, { requestId: crypto.randomUUID(), sessionId: f.draft().id, expectedRevision: f.draft().revision, sourceId: 'Q16:MH02' });
    for (const option of ['Not at all', 'Several days', 'More than half the days', 'Nearly every day']) expect(spoken.text).toContain(option);
  });

  it('PHQ speech never selects a value from a spoken label without a separate confirmation', () => {
    const d = nonVisitPhq('MH01')(draftFor('non-visit'));
    const prompt: PromptView = content.view(d, true, true).currentPrompt!;
    expect(exactSpokenChoice(prompt, 'Several days')?.value).toBe('1');
    expect(() => content.turn(d, { requestId: crypto.randomUUID(), expectedRevision: d.revision, promptId: prompt.id, action: 'answer', text: '1', channel: 'confirmed-transcript' })).toThrow('explicit-screening-choice-required');
  });
});
