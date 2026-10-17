import { describe, expect, it } from 'vitest';
import { conversation } from '../src/conversation.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
import { chooseOptionInstruction, editGuidedChoiceDraft, typedGuidedChoice } from '../../clinic-contract/src/guided-choice.js';

const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://localhost:5173', cookieSecret: 'guided-choice'.repeat(8), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'billing', 'scheduling'].map(id => [id, patient])) } as ClinicApiConfig;
const content = conversation(config);
function fixture(scenario: Draft['scenario'], topic: string, slot: string) {
  const at = new Date().toISOString();
  return content.select({ schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario, revision: 3, savedAt: at, createdAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 }, topic, slot);
}
const answer = (draft: Draft, text: string) => ({ requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: content.view(draft).currentPrompt!.id, action: 'answer' as const, text, channel: 'text' as const });

describe('guided typed choices', () => {
  it.each(['Tuesday', 'A different day maybe', 'Monday\nConfirmation attempt: Actually Tuesday'])('recovers retained speech %j through typed confirmation without crediting it as typed evidence', original => {
    const d = fixture('scheduling', 'W06', 'preferredDay'), prompt = content.view(d).currentPrompt!;
    const edited = editGuidedChoiceDraft(original, 'unreviewed-transcript');
    const candidate = typedGuidedChoice(prompt, 'Tuesday')!;
    expect(d.turns).toEqual([]); expect(d.topics.W06.answers.preferredDay).toBeUndefined();
    const next = content.turn(d, { ...answer(d, candidate.value), channel: edited.channel, priorChoiceTranscript: edited.retainedSpeech, choiceConfirmation: { optionTranscript: candidate.optionTranscript, confirmationTranscript: '', confirmationMethod: 'control' } });
    const raw = next.turns.find(turn => turn.channel === 'unreviewed-transcript')!;
    expect(raw).toMatchObject({ text: original, displayedPromptId: prompt.id, displayedPromptText: prompt.text });
    expect(next.topics.W06.answers.preferredDay).toMatchObject({ state: 'known', value: 'Tuesday' });
    expect(next.topics.W06.answers.preferredDay.sourceIds).not.toContain(raw.id);
    expect(next.topics.W06.answers.preferredDay.sourceIds.map(id => next.turns.find(turn => turn.id === id)?.channel)).toEqual(['text', 'text']);
  });
  it.each([
    ['billing', 'W05', 'issueType', 'A bill question.', 'bill-question'],
    ['scheduling', 'W06', 'preferredDay', 'Tuesday', 'Tuesday'],
    ['first-intake', 'Q06', 'conditions.diabetes', 'Yes', 'true'],
  ] as const)('confirms exact typed labels at %s %s.%s with separate typed provenance', (scenario, topic, slot, text, value) => {
    const before = fixture(scenario, topic, slot), prompt = content.view(before).currentPrompt!;
    const candidate = typedGuidedChoice(prompt, text)!;
    expect(candidate.value).toBe(value);
    expect(before.topics[topic].answers[slot]).toBeUndefined(); expect(before.turns).toEqual([]);
    const next = content.turn(before, { ...answer(before, candidate.value), choiceConfirmation: { optionTranscript: text, confirmationTranscript: '', confirmationMethod: 'control' } });
    const recorded = next.topics[topic].answers[slot];
    expect(recorded.state).toBe('known'); expect(recorded.sourceIds).toHaveLength(2);
    expect(recorded.sourceIds.map(id => next.turns.find(turn => turn.id === id))).toEqual([
      expect.objectContaining({ role: 'patient', text, channel: 'text', displayedPromptId: prompt.id }),
      expect.objectContaining({ role: 'patient', text: 'Confirmed the displayed choice using Confirm choice.', channel: 'text', displayedPromptId: prompt.id }),
    ]);
  });

  it('keeps a direct button answer direct, including labels identical to stored values', () => {
    const d = fixture('scheduling', 'W06', 'preferredDay'), next = content.turn(d, answer(d, 'Tuesday'));
    expect(next.topics.W06.answers.preferredDay).toMatchObject({ state: 'known', value: 'Tuesday' });
    expect(next.topics.W06.answers.preferredDay.sourceIds).toHaveLength(1);
  });

  it('shows the instruction once while keeping buttons and retaining unmatched words without duplicate assistant prompts', () => {
    let draft = fixture('first-intake', 'Q06', 'conditions.diabetes');
    const prompt = content.view(draft).currentPrompt!;
    for (const text of ['I am not sure what you mean', 'Sometimes, maybe']) {
      expect(typedGuidedChoice(prompt, text)).toBeUndefined();
      draft = content.turn(draft, answer(draft, text));
      expect(content.view(draft).currentPrompt).toEqual(prompt);
      expect(content.view(draft).notice).toMatchObject({ text: chooseOptionInstruction });
      expect(draft.topics.Q06.answers['conditions.diabetes']).toBeUndefined();
      expect(draft.turns.at(-1)).toMatchObject({ role: 'patient', text, channel: 'text' });
      expect(draft.turns.filter(turn => turn.role === 'assistant')).toEqual([]);
    }
    const next = content.turn(draft, answer(draft, '__negative'));
    expect(content.view(next).notice?.text).not.toBe(chooseOptionInstruction);
  });

  it.each(['MH01', 'MH02', 'MH03', 'MH04'])('re-shows %s buttons for typed labels and never scores them', item => {
    const d = fixture('first-intake', 'Q16', item), prompt = content.view(d).currentPrompt!;
    expect(typedGuidedChoice(prompt, 'Several days')).toBeUndefined();
    const next = content.turn(d, answer(d, 'Several days'));
    expect(content.view(next).currentPrompt).toEqual(prompt);
    expect(next.topics.Q16.answers[item]).toBeUndefined();
    expect(content.view(next).topics.find(topic => topic.id === 'Q16')?.screening).toMatchObject({ status: 'incomplete', scores: null });
    expect(next.turns.filter(turn => turn.role === 'assistant')).toEqual([]);
    expect(() => content.turn(d, { ...answer(d, '1'), choiceConfirmation: { optionTranscript: 'Several days', confirmationTranscript: '', confirmationMethod: 'control' } })).toThrow('explicit-screening-choice-required');
  });

  it('screens unmatched choice text for safety and retains exact patient words', () => {
    const d = fixture('billing', 'W05', 'issueType'), text = 'I may hurt myself tonight.';
    const next = content.turn(d, answer(d, text));
    expect(next.safety).toMatchObject({ rule: 'E04', paused: true });
    expect(next.topics.W05.answers.issueType).toBeUndefined();
    expect(content.view(next).currentPrompt).toBeUndefined();
    expect(next.turns.at(-1)).toMatchObject({ role: 'patient', text });
  });
});
