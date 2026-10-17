import { describe, expect, it } from 'vitest';
import { conversation } from '../src/conversation.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
import type { TurnInput } from '../../clinic-contract/src/index.js';
import { conversationSpeech } from '../../clinic-contract/src/index.js';
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://127.0.0.1:5173', cookieSecret: 'test'.repeat(32), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
const c = conversation(config);
function fixture(item = 'MH01') {
  const draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 3, savedAt: new Date().toISOString(), createdAt: new Date().toISOString(), phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
  return c.select(draft, 'Q16', item);
}
function billingFixture() { return c.select({ ...fixture(), scenario: 'billing', topics: {} }, 'W05', 'issueType'); }
function input(d: Draft): TurnInput { const prompt = c.view(d).currentPrompt!; const choice = prompt.choices![1]; return { requestId: crypto.randomUUID(), expectedRevision: d.revision, promptId: prompt.id, action: 'answer', text: choice.value, channel: 'confirmed-transcript', choiceConfirmation: { optionTranscript: choice.label + '.', confirmationTranscript: 'Yes.', confirmationMethod: 'voice' } }; }
describe('source-linked exact choices and PHQ button boundary', () => {
  it.each(['MH01', 'MH02', 'MH03', 'MH04'])('rejects confirmed speech for first-intake %s while retaining exact read-aloud options', item => {
    const d = fixture(item), request = input(d);
    for (const method of ['voice', 'control'] as const) {
      expect(() => c.turn(d, { ...request, choiceConfirmation: { ...request.choiceConfirmation!, confirmationMethod: method, confirmationTranscript: method === 'voice' ? 'Yes.' : '' } })).toThrow('explicit-screening-choice-required');
    }
    expect(d.turns).toEqual([]); expect(d.topics.Q16.answers[item]).toBeUndefined();
    expect(c.view(d).topics.find(t => t.id === 'Q16')!.screening!.scores).toBeNull();
    const spoken = conversationSpeech({ currentPrompt: c.view(d).currentPrompt });
    expect(spoken?.text).toContain(c.view(d).currentPrompt!.text);
    for (const option of ['Not at all', 'Several days', 'More than half the days', 'Nearly every day']) expect(spoken?.text).toContain(option);
  });
  it('exposes opaque direct scope only after identity and revokes it for direct edits or safety', () => {
    const d = billingFixture(), scope = c.view(d).speechScopeDigest;
    expect(scope).toMatch(/^[a-f0-9]{64}$/); expect(c.view(d, false).speechScopeDigest).toBeUndefined();
    expect(c.view({ ...d, revision: 99, savedAt: 'later' }).speechScopeDigest).toBe(scope);
    const edited = c.turn(d, input(d)); expect(c.view(edited).speechScopeDigest).not.toBe(scope);
    expect(c.view({ ...d, safety: { rule: 'E04', text: 'Safety pause', paused: true } }).speechScopeDigest).not.toBe(scope);
  });
  it('retains separate exact option and explicit confirmation sources for only the presented item', () => {
    const d = billingFixture(), next = c.turn(d, input(d)), answer = next.topics.W05.answers.issueType;
    expect(answer).toMatchObject({ state: 'known', value: 'coverage-question' }); expect(answer.sourceIds).toHaveLength(2);
    expect(answer.sourceIds.map(id => next.turns.find(turn => turn.id === id)?.text)).toEqual(['A coverage question.', 'Yes.']);
    expect(next.topics.W05.answers.requestedResolution).toBeUndefined(); expect(c.view(next).topics.find(t => t.id === 'W05')?.screening).toBeUndefined();
    const spoken = conversationSpeech({ currentPrompt: c.view(d).currentPrompt });
    expect(spoken?.text).toContain(c.view(d).currentPrompt!.text);
    for (const label of c.view(d).currentPrompt!.choices!.map(choice => choice.label)) expect(spoken?.text).toContain(label);
  });
  it.each(['Fine', 'sometimes', 'all zeros', '0', 'Several days or nearly every day'])('rejects ambiguous or score-only %s without modifying the draft', text => {
    const d = billingFixture(), request = input(d); request.choiceConfirmation!.optionTranscript = text;
    expect(() => c.turn(d, request)).toThrow('explicit-choice-confirmation-required'); expect(d.turns).toHaveLength(0); expect(d.topics.W05.answers.issueType).toBeUndefined();
  });
  it.each(['maybe', 'yes but no', 'I think so', 'Retry', 'I may hurt myself tonight.'])('cannot save using %s as confirmation', text => { const d = billingFixture(), request = input(d); request.choiceConfirmation!.confirmationTranscript = text; expect(() => c.turn(d, request)).toThrow('explicit-choice-confirmation-required'); });
  it('rejects absent confirmation, stale revision and cross-prompt replay', () => {
    const d = billingFixture(), request = input(d);
    expect(() => c.turn(d, { ...request, choiceConfirmation: undefined })).toThrow('explicit-choice-confirmation-required');
    expect(() => c.turn({ ...d, revision: 4 }, request)).toThrow('stale-session');
    expect(() => c.turn(c.select(d, 'W05', 'requestedResolution'), request)).toThrow('stale-prompt');
  });
  it('retains vague original words without a score or advancing and preserves skipped-item missingness', () => {
    const d = fixture(), next = c.turn(d, { ...input(d), choiceConfirmation: undefined, choiceTranscriptOnly: true, text: 'I am fine', channel: 'unreviewed-transcript' });
    expect(next.turns.at(-1)).toMatchObject({ text: 'I am fine', channel: 'unreviewed-transcript', displayedPromptId: 'Q16:MH01' }); expect(next.topics.Q16.answers.MH01).toBeUndefined(); expect(c.view(next).currentPrompt?.id).toBe('Q16:MH01');
    const skipped = c.turn(next, { ...input(next), choiceConfirmation: undefined, action: 'unknown', text: undefined, channel: 'text' });
    expect(skipped.topics.Q16.answers.MH01.state).toBe('unknown'); expect(c.view(skipped).topics.find(t => t.id === 'Q16')!.screening!.scores).toBeNull();
    const declined = c.turn(d, { ...input(d), choiceConfirmation: undefined, action: 'decline', text: undefined, channel: 'text' }); expect(declined.topics.Q16.answers.MH01.state).toBe('declined'); expect(c.view(declined).topics.find(t => t.id === 'Q16')!.screening!.scores).toBeNull();
  });
  it('applies existing crisis pause to unscored option or confirmation words and retains both sources', () => {
    const d = fixture(), next = c.turn(d, { ...input(d), text: 'I may hurt myself tonight.', choiceConfirmation: undefined, choiceTranscriptOnly: true, priorChoiceTranscript: 'Several days.', channel: 'unreviewed-transcript' });
    expect(next.safety?.rule).toBe('E04'); expect(next.topics.Q16.answers.MH01).toBeUndefined(); expect(c.view(next).currentPrompt).toBeUndefined(); expect(next.turns.filter(t => t.role === 'patient').map(t => t.text)).toEqual(['I may hurt myself tonight.', 'Several days.']);
    expect(() => c.turn(next, input(d))).toThrow('stale-prompt');
  });
});
