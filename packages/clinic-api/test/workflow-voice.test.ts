import { describe, expect, it } from 'vitest';
import { createSpeechAccess } from '../src/speech-access.js';
import { cookies, type Claims } from '../src/cookies.js';
import { conversation } from '../src/conversation.js';
import { DRAFT_SYSTEM, document } from '../src/store.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import { exactChoiceConfirmation, exactSpokenChoice } from '../../clinic-contract/src/choice-voice.js';
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

  const spokenCases = [
    ['billing', 'W05', 'issueType', 'A bill question', 'bill-question'],
    ['scheduling', 'W06', 'preferredDay', 'Tuesday', 'Tuesday'],
  ] as const;

  it.each(spokenCases)('%s %s.%s records only the explicitly confirmed choice and its original speech sources', async (scenario, topic, slot, spoken, value) => {
    const f = await fixture(scenario, select(scenario, topic, slot));
    const before = f.draft(), prompt = f.current();
    expect(exactSpokenChoice(prompt, spoken)?.value).toBe(value);
    expect(exactChoiceConfirmation('Yes.')).toBe('confirm');
    const next = content.turn(before, {
      requestId: crypto.randomUUID(), expectedRevision: before.revision, promptId: prompt.id,
      action: 'answer', text: value, channel: 'confirmed-transcript',
      choiceConfirmation: { optionTranscript: spoken, confirmationTranscript: 'Yes.', confirmationMethod: 'voice' },
    });
    const answer = next.topics[topic].answers[slot];
    expect(answer).toMatchObject({ state: 'known', value });
    expect(answer.sourceIds).toHaveLength(2);
    expect(answer.sourceIds.map(id => next.turns.find(turn => turn.id === id))).toEqual([
      expect.objectContaining({ role: 'patient', text: spoken, channel: 'confirmed-transcript', displayedPromptId: prompt.id }),
      expect.objectContaining({ role: 'patient', text: 'Yes.', channel: 'confirmed-transcript', displayedPromptId: prompt.id }),
    ]);
    expect(content.view(next).topics.find(view => view.id === topic)?.details?.find(detail => detail.id === slot)).toMatchObject({ state: 'answered', text: value });
    expect(before.topics[topic].answers[slot]).toBeUndefined();
  });

  it.each(spokenCases)('%s %s.%s retains an unreviewed choice attempt without satisfying or advancing the slot', async (scenario, topic, slot, spoken) => {
    const f = await fixture(scenario, select(scenario, topic, slot)), before = f.draft(), prompt = f.current();
    const next = content.turn(before, {
      requestId: crypto.randomUUID(), expectedRevision: before.revision, promptId: prompt.id,
      action: 'answer', text: spoken, channel: 'unreviewed-transcript', choiceTranscriptOnly: true,
    });
    expect(next.turns.at(-1)).toMatchObject({ role: 'patient', text: spoken, channel: 'unreviewed-transcript', displayedPromptId: prompt.id });
    expect(next.topics[topic].answers[slot]).toBeUndefined();
    expect(content.view(next).currentPrompt?.id).toBe(prompt.id);
    expect(content.view(next).topics.find(view => view.id === topic)?.details?.find(detail => detail.id === slot)?.state).toBe('not-asked');
  });

  it.each(spokenCases)('%s %s.%s cannot satisfy a choice using a raw unreviewed stored value', async (scenario, topic, slot, _spoken, value) => {
    const f = await fixture(scenario, select(scenario, topic, slot)), before = f.draft(), prompt = f.current();
    const next = content.turn(before, {
      requestId: crypto.randomUUID(), expectedRevision: before.revision, promptId: prompt.id,
      action: 'answer', text: value, channel: 'unreviewed-transcript',
    });
    expect(next.topics[topic].answers[slot]).toBeUndefined();
    expect(content.view(next).topics.find(view => view.id === topic)?.details?.find(detail => detail.id === slot)?.state).toBe('not-asked');
    expect(content.view(next).topics.find(view => view.id === topic)?.status).not.toBe('ready-for-review');
    expect(next.turns.at(-1)).toMatchObject({ channel: 'unreviewed-transcript', displayedPromptId: prompt.id });
  });

  it.each(spokenCases)('%s %s.%s rejects a confirmation attached to an unreviewed source', async (scenario, topic, slot, spoken, value) => {
    const f = await fixture(scenario, select(scenario, topic, slot)), before = f.draft(), prompt = f.current();
    expect(() => content.turn(before, {
      requestId: crypto.randomUUID(), expectedRevision: before.revision, promptId: prompt.id,
      action: 'answer', text: value, channel: 'unreviewed-transcript',
      choiceConfirmation: { optionTranscript: spoken, confirmationTranscript: 'Yes.', confirmationMethod: 'voice' },
    })).toThrow('explicit-choice-confirmation-required');
    expect(before.topics[topic].answers[slot]).toBeUndefined();
    expect(before.turns).toEqual([]);
  });

  it.fails('a spoken answer without an explicit confirmation does not store a choice value on W06 preferredDay', async () => {
    // BUG: the missing-confirmation guard applies only to PHQ items, so scheduling also accepts an unconfirmed raw choice value.
    const f = await fixture('scheduling', select('scheduling', 'W06', 'preferredDay')), prompt = f.current();
    expect(() => content.turn(f.draft(), {
      requestId: crypto.randomUUID(), expectedRevision: f.draft().revision, promptId: prompt.id,
      action: 'answer', text: 'Tuesday', channel: 'confirmed-transcript',
    })).toThrow('explicit-choice-confirmation-required');
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

  it.each(['MH01', 'MH02', 'MH03', 'MH04'])('non-visit %s never records a spoken PHQ label as an answer', async item => {
    const f = await fixture('non-visit', nonVisitPhq(item)), before = f.draft(), prompt = f.current();
    for (const channel of ['confirmed-transcript', 'unreviewed-transcript'] as const) {
      expect(() => content.turn(before, {
        requestId: crypto.randomUUID(), expectedRevision: before.revision, promptId: prompt.id,
        action: 'answer', text: 'Several days', channel,
      })).toThrow('explicit-screening-choice-required');
      expect(before.topics.Q16.answers[item]).toBeUndefined();
      expect(before.turns).toEqual([]);
      expect(content.view(before).topics.find(topic => topic.id === 'Q16')?.screening).toMatchObject({ status: 'incomplete', scores: null });
    }
  });

  it.fails.each(['MH01', 'MH02', 'MH03', 'MH04'])('non-visit %s rejects a spoken PHQ label even with a separate voice confirmation', async item => {
    // BUG: choiceConfirmation bypasses the PHQ speech guard, so a spoken label plus Yes records a numeric screening answer despite buttons-only policy.
    const f = await fixture('non-visit', nonVisitPhq(item)), before = f.draft(), prompt = f.current();
    expect(() => content.turn(before, {
      requestId: crypto.randomUUID(), expectedRevision: before.revision, promptId: prompt.id,
      action: 'answer', text: '1', channel: 'confirmed-transcript',
      choiceConfirmation: { optionTranscript: 'Several days', confirmationTranscript: 'Yes.', confirmationMethod: 'voice' },
    })).toThrow('explicit-screening-choice-required');
    expect(before.topics.Q16.answers[item]).toBeUndefined();
  });

  it.fails.each(['MH01', 'MH02', 'MH03', 'MH04'])('non-visit %s rejects a spoken PHQ label confirmed through a control', async item => {
    // BUG: control confirmation also bypasses the PHQ speech guard; confirming speech must not satisfy a buttons-only screening item.
    const f = await fixture('non-visit', nonVisitPhq(item)), before = f.draft(), prompt = f.current();
    expect(() => content.turn(before, {
      requestId: crypto.randomUUID(), expectedRevision: before.revision, promptId: prompt.id,
      action: 'answer', text: '1', channel: 'confirmed-transcript',
      choiceConfirmation: { optionTranscript: 'Several days', confirmationTranscript: '', confirmationMethod: 'control' },
    })).toThrow('explicit-screening-choice-required');
    expect(before.topics.Q16.answers[item]).toBeUndefined();
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
