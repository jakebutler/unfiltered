import { describe, expect, it, vi } from 'vitest';
import { VoiceConversation, type ConversationVoiceContext } from '../src/voice-conversation';
import { exactSpokenChoice } from '../src/choice-voice';
import { conversation } from '../../../packages/clinic-api/src/conversation';
import type { ClinicApiConfig, Draft } from '../../../packages/clinic-api/src/types';
import type { ClinicSessionView, PromptView } from '../../../packages/clinic-contract/src/index';

// Choice-by-voice for the W05 billing and W06 scheduling choice slots, using the
// same VoiceConversation harness as choice-voice.test.ts and real prompt views.
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://127.0.0.1:5173', cookieSecret: 'workflow-choice-voice'.repeat(4), mentalHealth: 'phq4', patients: Object.fromEntries(['billing', 'scheduling'].map(id => [id, patient])) } as unknown as ClinicApiConfig;
const content = conversation(config);

function promptFor(scenario: 'billing' | 'scheduling', topic: string, slot: string): PromptView {
  const at = new Date().toISOString();
  const draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario, revision: 3, savedAt: at, createdAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
  const prompt = content.view(content.select(draft, topic, slot), true, true).currentPrompt;
  if (!prompt?.choices?.length) throw new Error(`no choice prompt for ${topic}.${slot}`);
  return prompt;
}

function harness(prompt: PromptView) {
  let context: ConversationVoiceContext = { eligible: true, blocked: false, scope: { sessionId: 'session', expectedRevision: 3, promptId: prompt.id, requestId: 'option' }, choicePrompt: prompt, speech: { id: prompt.id, text: prompt.text } };
  let next = 0; const timers = new Map<number, () => void>();
  const clock = { after: (_ms: number, fn: () => void) => { timers.set(++next, fn); return next; }, clear: (id: unknown) => { timers.delete(id as number); } };
  const ports = { context: () => context, startCapture: vi.fn(), finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak: vi.fn(), speakChoiceConfirmation: vi.fn(), changed: vi.fn(), abandonCapture: vi.fn(), restoreChoiceDraft: vi.fn(), prepareChoiceCapture: vi.fn(() => { context = { ...context, scope: { ...context.scope!, requestId: `capture-${++next}` } }; }), save: vi.fn(), interpret: vi.fn(), saveChoice: vi.fn(async () => ({ id: 'session', revision: 4, currentPrompt: prompt } as ClinicSessionView)), saveChoiceAttempt: vi.fn(async () => ({ id: 'session', revision: 4 } as ClinicSessionView)) };
  const controller = new VoiceConversation(ports, clock);
  function utterance(text: string) {
    const scope = context.scope!; controller.event({ type: 'ready', scope });
    controller.event({ type: 'recognition', scope, segment: { text, start: 0, duration: 1, isFinal: true, speechFinal: true }, interim: '' });
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    controller.event({ type: 'completed', scope, clean: true, text });
  }
  return { controller, ports, utterance };
}

const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

const slots: Array<[string, 'billing' | 'scheduling', string, string]> = [
  ['W05 issueType', 'billing', 'W05', 'issueType'],
  ['W05 requestedResolution', 'billing', 'W05', 'requestedResolution'],
  ['W06 intent', 'scheduling', 'W06', 'intent'],
  ['W06 visitCategory', 'scheduling', 'W06', 'visitCategory'],
  ['W06 preferredDay', 'scheduling', 'W06', 'preferredDay'],
  ['W06 preferredWindow', 'scheduling', 'W06', 'preferredWindow'],
  ['W06 timezone', 'scheduling', 'W06', 'timezone'],
];

describe('W05 and W06 choice slots by voice: exact label to value', () => {
  it.each([
    ['W05 issueType', 'billing', 'W05', 'issueType', 'A bill question', 'bill-question'],
    ['W05 requestedResolution', 'billing', 'W05', 'requestedResolution', 'Review a possible error', 'review-possible-error'],
    ['W06 intent', 'scheduling', 'W06', 'intent', 'cancel', 'cancel'],
    ['W06 visitCategory', 'scheduling', 'W06', 'visitCategory', 'First visit', 'first-visit'],
    ['W06 preferredDay', 'scheduling', 'W06', 'preferredDay', 'Wednesday', 'Wednesday'],
    ['W06 preferredDay Tuesday', 'scheduling', 'W06', 'preferredDay', 'Tuesday', 'Tuesday'],
    ['W06 preferredWindow', 'scheduling', 'W06', 'preferredWindow', 'Flexible', 'Flexible'],
    ['W06 timezone', 'scheduling', 'W06', 'timezone', 'Pacific time', 'America/Los_Angeles'],
  ] as const)('%s: spoken "%s" then Yes saves value %s only after confirmation', async (_name, scenario, topic, slot, spoken, value) => {
    const prompt = promptFor(scenario, topic, slot), h = harness(prompt);
    h.controller.start(); h.utterance(spoken);
    expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.controller.state.choice?.value).toBe(value);
    h.controller.reconcile();
    h.utterance('Yes.'); await flush();
    expect(h.ports.speakChoiceConfirmation).toHaveBeenCalledExactlyOnceWith(value);
    expect(h.ports.saveChoice).toHaveBeenCalledExactlyOnceWith({ value, label: spoken, optionTranscript: spoken }, expect.objectContaining({ promptId: prompt.id }), { method: 'voice', transcript: 'Yes.' });
    expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.interpret).not.toHaveBeenCalled();
  });

  it.each(slots)('%s: every presented label maps to exactly its own value', (_name, scenario, topic, slot) => {
    const prompt = promptFor(scenario, topic, slot);
    for (const choice of prompt.choices!) expect(exactSpokenChoice(prompt, choice.label)?.value).toBe(choice.value);
  });

  it.each(slots)('%s: a raw stored value and an unmatched utterance select nothing', (_name, scenario, topic, slot) => {
    const prompt = promptFor(scenario, topic, slot);
    for (const choice of prompt.choices!) {
      if (choice.value !== choice.label) expect(exactSpokenChoice(prompt, choice.value)).toBeUndefined();
    }
    expect(exactSpokenChoice(prompt, 'something else entirely')).toBeUndefined();
  });

  it.each([
    ['W05 issueType', 'bill', 'billing', 'W05', 'issueType'],
    ['W05 requestedResolution', 'explain it', 'billing', 'W05', 'requestedResolution'],
    ['W06 preferredDay', 'Monday or Tuesday', 'scheduling', 'W06', 'preferredDay'],
    ['W06 preferredWindow', 'early morning', 'scheduling', 'W06', 'preferredWindow'],
    ['W06 timezone', 'Pacific', 'scheduling', 'W06', 'timezone'],
  ] as const)('%s: ambiguous or partial utterance %j does not select, saves only as an unscored attempt', async (_name, spoken, scenario, topic, slot) => {
    const h = harness(promptFor(scenario, topic, slot));
    h.controller.start(); h.utterance(spoken); await flush();
    expect(h.controller.state.choice).toBeUndefined();
    expect(h.ports.saveChoice).not.toHaveBeenCalled();
    h.controller.reconcile(); h.utterance('Yes.'); await flush();
    expect(h.ports.saveChoice).not.toHaveBeenCalled();
  });

  it('a spoken yes with no selected label cannot save a W06 timezone choice', async () => {
    const h = harness(promptFor('scheduling', 'W06', 'timezone'));
    h.controller.start(); h.utterance('Yes.'); await flush();
    expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.ports.saveChoiceAttempt).toHaveBeenCalled();
  });
});
