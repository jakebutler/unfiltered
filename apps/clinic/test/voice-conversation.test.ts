import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdaptiveTurnResult, PromptView, SourceTurn } from '../../../packages/clinic-contract/src/index';
import { conversationSpeech } from '../../../packages/clinic-contract/src/index';
import { VoiceConversation, endpointGrace, endpointGraceMs, fillerOnly, type ConversationVoiceContext } from '../src/voice-conversation';
import { promptAllowsFreeText } from '../src/prompt-input';
import { SourceInspector } from '../src/components';

const initial = { sessionId: 'patient-1', promptId: 'Q01', expectedRevision: 4, requestId: 'answer-1' };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock() {
  let time = 0, next = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    after(ms: number, fn: () => void) { const id = ++next; timers.set(id, { at: time + ms, fn }); return id; }, clear(id: unknown) { timers.delete(id as number); },
    advance(ms: number) { const target = time + ms; for (;;) { const task = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; if (!task || task[1].at > target) break; time = task[1].at; timers.delete(task[0]); task[1].fn(); } time = target; },
  };
}
function result(status = 'accepted', revision = 5): AdaptiveTurnResult {
  const operation = { id: 'op-1', requestId: 'answer-1', sourceId: 'source-1', status, acceptedAt: '2026-10-09T20:00:00Z', updatedAt: '2026-10-09T20:00:00Z' };
  return { operation, session: { id: 'patient-1', revision, phase: 'conversation', currentPrompt: { id: 'Q02', text: 'Next question', topicId: 'Q02', mode: 'adaptive' }, adaptive: { mode: 'adaptive', available: true, operation } } } as AdaptiveTurnResult;
}
function harness(speech = true) {
  const timer = clock(); let context: ConversationVoiceContext = { scope: initial, eligible: true, blocked: false, ...(speech ? { speech: { id: 'Q01', text: 'Question' } } : {}) };
  const ports = { context: () => context, startCapture: vi.fn(), finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak: vi.fn(), save: vi.fn(async () => result()), interpret: vi.fn(async () => result('applied', 7)), restoreDraft: vi.fn(), changed: vi.fn() };
  const controller = new VoiceConversation(ports, timer);
  const ready = () => controller.event({ type: 'ready', scope: context.scope! });
  const final = (text = 'I take five milligrams', speechFinal = true, start = 0) => controller.event({ type: 'recognition', scope: context.scope!, segment: { start, duration: 1, text, isFinal: true, speechFinal }, interim: '' });
  const completed = (clean = true, text = 'I take five milligrams', extra: { utterance?: string; prefix?: string } = {}) => controller.event({ type: 'completed', scope: context.scope!, text, clean, ...extra });
  return { timer, ports, controller, ready, final, completed, setContext(value: ConversationVoiceContext) { context = value; } };
}

describe('natural voice endpoint and lifecycle', () => {
  it('does nothing without opt-in, then starts input before speaking', () => {
    const h = harness(); h.ready(); h.final(); h.timer.advance(1000); expect(h.ports.save).not.toHaveBeenCalled();
    h.controller.start(); expect(h.ports.startCapture).toHaveBeenCalledTimes(1); expect(h.ports.speak).not.toHaveBeenCalled();
    h.ready(); expect(h.ports.speak).toHaveBeenCalledOnce(); h.ready(); expect(h.ports.speak).toHaveBeenCalledOnce();
  });
  it('requires final speech plus the complete endpoint grace, then clean drain before one save', async () => {
    // Default final text "I take five milligrams" ends in a unit, so it gets the hold grace.
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(endpointGrace.hold - 1); expect(h.ports.finishCapture).not.toHaveBeenCalled();
    h.timer.advance(1); expect(h.ports.finishCapture).toHaveBeenCalledOnce(); expect(h.ports.save).not.toHaveBeenCalled();
    h.completed(); h.completed(); await tick(); expect(h.ports.save).toHaveBeenCalledTimes(1); expect(h.ports.save).toHaveBeenCalledWith('I take five milligrams', initial); expect(h.ports.interpret).toHaveBeenCalledOnce();
  });
  it('a duplicate final cannot reset or duplicate the grace timer', () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(1000); h.final(); h.timer.advance(endpointGrace.hold - 1000);
    expect(h.ports.finishCapture).toHaveBeenCalledOnce(); h.final(); h.timer.advance(1000); expect(h.ports.finishCapture).toHaveBeenCalledOnce();
  });
  it('waits for speechFinal even if a segment was already final, without re-adding its words', () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final('Five', false); h.timer.advance(1000); expect(h.ports.finishCapture).not.toHaveBeenCalled();
    h.final('Five', true); h.timer.advance(endpointGrace.hold); expect(h.ports.finishCapture).toHaveBeenCalledOnce();
  });
  it.each(['voice', 'interim', 'changed-final'])('%s cancels the grace; a later endpoint can finish', type => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(400);
    if (type === 'voice') h.controller.event({ type: 'voice', scope: initial });
    else if (type === 'interim') h.controller.event({ type: 'recognition', scope: initial, segment: { start: 1, duration: .2, text: 'not', isFinal: false, speechFinal: false }, interim: 'not' });
    else h.final('Actually ten', false);
    // The original deadline (hold after the first final) has passed; a cancelled grace must not fire.
    h.timer.advance(endpointGrace.hold); expect(h.ports.finishCapture).not.toHaveBeenCalled(); h.final('Actually ten, not five', true); h.timer.advance(endpointGrace.hold); expect(h.ports.finishCapture).toHaveBeenCalledOnce();
  });
  it.each([['unclean', false, 'Five'], ['empty', true, '']])('%s completion pauses without saving provisional words', (_name, clean, text) => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(endpointGrace.hold); h.completed(clean as boolean, text as string);
    expect(h.controller.state.status).toBe('paused'); expect(h.ports.save).not.toHaveBeenCalled();
  });
  it('stop during grace cancels submission and retains the draft through the capture stop port', () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(1000); h.controller.stop(); h.timer.advance(endpointGrace.hold); h.completed();
    expect(h.ports.finishCapture).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.stopCapture).toHaveBeenCalled();
  });
  it('capture interruption/limit pauses with no automatic replacement STT attempt', () => {
    const h = harness(false); h.controller.start(); h.ready(); h.controller.event({ type: 'interrupted', scope: initial, reason: 'Capture limit' }); h.controller.reconcile(); h.timer.advance(60000);
    expect(h.controller.state.status).toBe('paused'); expect(h.ports.startCapture).toHaveBeenCalledTimes(1); expect(h.ports.save).not.toHaveBeenCalled();
  });
  it('barge-in stops audio immediately and cancels the quiet timeout', () => {
    const h = harness(); h.controller.start(); h.ready(); h.controller.playback('playing'); h.controller.event({ type: 'voice', scope: initial });
    expect(h.ports.stopPlayback).toHaveBeenCalled(); expect(h.controller.state.status).toBe('listening'); h.timer.advance(15000); expect(h.controller.state.active).toBe(true);
  });
  it('silence pauses only 15 seconds after question playback finishes', () => {
    const h = harness(); h.controller.start(); h.ready(); h.controller.playback('playing'); h.timer.advance(20000); expect(h.controller.state.active).toBe(true);
    h.controller.playback('finished'); h.timer.advance(14999); expect(h.controller.state.active).toBe(true); h.timer.advance(1); expect(h.controller.state.status).toBe('paused');
  });
  it('autoplay block pauses capture while retaining the same audio for an explicit play gesture', () => {
    const h = harness(); h.controller.start(); h.ready(); h.ports.stopPlayback.mockClear(); h.controller.playback('blocked');
    expect(h.controller.state.status).toBe('paused'); expect(h.ports.stopPlayback).not.toHaveBeenCalled(); expect(h.ports.stopCapture).toHaveBeenLastCalledWith(expect.any(String), true); expect(h.ports.speak).toHaveBeenCalledOnce();
  });
  it('acceptance and interpretation must finish before another capture starts at the new revision', async () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(endpointGrace.hold); h.completed(); await tick();
    expect(h.ports.startCapture).toHaveBeenCalledTimes(1);
    h.setContext({ scope: { ...initial, promptId: 'Q02', expectedRevision: 7, requestId: 'answer-2' }, eligible: true, blocked: false }); h.controller.reconcile();
    expect(h.ports.startCapture).toHaveBeenCalledTimes(2); expect(h.controller.state.status).toBe('connecting');
  });
  it('stop during a submitted save prevents a late acknowledgement from dispatching interpretation', async () => {
    const h = harness(false); let resolve!: (value: AdaptiveTurnResult) => void; h.ports.save.mockImplementation(() => new Promise(done => { resolve = done; }));
    h.controller.start(); h.ready(); h.final(); h.timer.advance(endpointGrace.hold); h.completed(); h.controller.stop(); resolve(result()); await tick();
    expect(h.ports.interpret).not.toHaveBeenCalled(); expect(h.ports.startCapture).toHaveBeenCalledTimes(1); expect(h.controller.state.active).toBe(false);
  });
  it('uncertain save or interpretation pauses without retrying, and the same submitted answer ID cannot recapture', async () => {
    const h = harness(false); h.ports.save.mockResolvedValue(undefined as any); h.controller.start(); h.ready(); h.final(); h.timer.advance(endpointGrace.hold); h.completed(); await tick();
    h.controller.reconcile(); h.controller.start(); expect(h.ports.save).toHaveBeenCalledOnce(); expect(h.ports.interpret).not.toHaveBeenCalled(); expect(h.ports.startCapture).toHaveBeenCalledOnce(); expect(h.controller.state.status).toBe('paused');
    const second = harness(false); second.ports.interpret.mockResolvedValue(undefined as any); second.controller.start(); second.ready(); second.final(); second.timer.advance(endpointGrace.hold); second.completed(); await tick(); second.controller.reconcile(); expect(second.ports.interpret).toHaveBeenCalledOnce(); expect(second.ports.startCapture).toHaveBeenCalledOnce();
  });
  it('stale scope events and a mismatched next revision cannot advance the conversation', async () => {
    const h = harness(false); h.controller.start(); h.ready(); h.setContext({ scope: { ...initial, expectedRevision: 5 }, eligible: true, blocked: false });
    h.controller.event({ type: 'recognition', scope: initial, segment: { start: 0, duration: 1, text: 'stale', isFinal: true, speechFinal: true }, interim: '' }); h.timer.advance(endpointGrace.hold); expect(h.ports.finishCapture).not.toHaveBeenCalled(); h.controller.reconcile(); expect(h.controller.state.active).toBe(false);
  });
  it.each(['PHQ choices', 'review', 'identity loss'])('%s stops automatic capture and requires explicit resumption', name => {
    const h = harness(); h.controller.start(); h.ready(); h.setContext({ eligible: false, blocked: false, pauseReason: name }); h.controller.reconcile();
    expect(h.controller.state.status).toBe('paused'); expect(h.ports.stopCapture).toHaveBeenCalled(); h.controller.reconcile(); expect(h.ports.startCapture).toHaveBeenCalledOnce();
  });
});

describe('endpoint cues and spoken pause commands', () => {
  const { base, hold } = endpointGrace;
  it.each([
    // base: no cue, no amount, no continuation
    ['I take metformin', base], ['summer', base], ['so the dose', base], ['twice a day', base], ['I take lisinopril', base], ['seventy', base],
    // hold: filler or continuation cue, trailing comma or ellipsis
    ['I take um', hold], ['metformin 500 no wait', hold], ['I mean', hold], ['and,', hold], ['the dose is…', hold], ['let me think.', hold],
    // hold: amount or unit at the end
    ['metformin 500', hold], ['ten milligrams.', hold], ['Five', hold], ['sorry about that, it\'s 5 mg', hold],
  ])('endpointGraceMs(%j) is %i', (text, ms) => { expect(endpointGraceMs(text)).toBe(ms); });
  it('a final ending in a filler keeps the endpoint open for the hold grace, not the base grace', () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final('I take um'); h.timer.advance(base); expect(h.ports.finishCapture).not.toHaveBeenCalled();
    h.timer.advance(hold - base - 1); expect(h.ports.finishCapture).not.toHaveBeenCalled(); h.timer.advance(1); expect(h.ports.finishCapture).toHaveBeenCalledOnce();
  });
  it.each(['Stop.', 'wait please', 'Hold on, please.', 'pause', 'Wait a second'])('spoken pause command %j pauses without saving', async text => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(hold); h.completed(true, text); await tick();
    expect(h.controller.state.status).toBe('paused'); expect(h.controller.state.message).toBe("Voice paused. Resume when you’re ready, or keep typing.");
    expect(h.ports.stopCapture).toHaveBeenLastCalledWith("Voice paused. Resume when you’re ready, or keep typing.", false); expect(h.ports.save).not.toHaveBeenCalled();
  });
  it('a sentence that merely starts with stop is saved normally', async () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(hold); h.completed(true, 'stop taking aspirin last week'); await tick();
    expect(h.ports.save).toHaveBeenCalledWith('stop taking aspirin last week', initial); expect(h.controller.state.status).toBe('thinking');
  });
  it('a spoken pause after typed words pauses, keeps the typed draft, and never saves the command', async () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(hold);
    h.completed(true, 'Earlier typed words. Pause.', { utterance: 'Pause.', prefix: 'Earlier typed words.' }); await tick();
    expect(h.controller.state.status).toBe('paused'); expect(h.controller.state.message).toBe("Voice paused. Resume when you’re ready, or keep typing.");
    expect(h.ports.restoreDraft).toHaveBeenCalledExactlyOnceWith('Earlier typed words.'); expect(h.ports.save).not.toHaveBeenCalled();
  });
  it('a sentence saved from a recording with an empty prefix is not treated as a command or restored', async () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.timer.advance(hold);
    h.completed(true, 'stop taking aspirin', { utterance: 'stop taking aspirin', prefix: '' }); await tick();
    expect(h.ports.save).toHaveBeenCalledWith('stop taking aspirin', initial); expect(h.ports.restoreDraft).not.toHaveBeenCalled();
  });
});

describe('backchannels and fillers never end a turn', () => {
  it.each([['uh', true], ['Mm-hmm.', true], ['um, uh', true], ['uh-huh', true], ['', false], ['okay', false], ['uh, ten milligrams', false], ['no', false]])('fillerOnly(%j) is %s', (text, expected) => {
    expect(fillerOnly(text)).toBe(expected);
  });
  it('a filler-only endpoint keeps listening; a later answer finishes on its own grace and saves with the filler', async () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final('Mm-hmm.', true, 0);
    h.timer.advance(endpointGrace.hold + endpointGrace.base);
    expect(h.ports.finishCapture).not.toHaveBeenCalled(); expect(h.controller.state.status).toBe('listening');
    h.final('I take metformin', true, 1); h.timer.advance(endpointGrace.base);
    expect(h.ports.finishCapture).toHaveBeenCalledOnce(); h.completed(true, 'Mm-hmm. I take metformin.'); await tick();
    expect(h.ports.save).toHaveBeenCalledWith(expect.stringContaining('I take metformin'), initial);
  });
  it('a filler-only endpoint re-arms the quiet timeout, so a silent backchannel still pauses', () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final('uh', true, 0);
    h.timer.advance(endpointGrace.hold); expect(h.controller.state.status).toBe('listening');
    h.timer.advance(15000); expect(h.controller.state.status).toBe('paused'); expect(h.ports.finishCapture).not.toHaveBeenCalled();
  });
  it('done() after only a backchannel is a no-op, and done() works once an answer follows', () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final('uh', true, 0); h.controller.done();
    expect(h.controller.state.status).toBe('listening'); expect(h.ports.finishCapture).not.toHaveBeenCalled(); expect(h.ports.stopPlayback).not.toHaveBeenCalled();
    h.final('I take metformin', false, 1); h.controller.done();
    expect(h.ports.finishCapture).toHaveBeenCalledOnce();
  });
});

describe('Done speaking', () => {
  it('done() takes the turn at once without a timer, and a clean drain saves exactly once', async () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final();
    h.controller.done();
    expect(h.ports.finishCapture).toHaveBeenCalledOnce(); expect(h.controller.state.status).toBe('finishing'); expect(h.ports.stopPlayback).toHaveBeenCalled();
    h.controller.done(); h.timer.advance(endpointGrace.hold * 2); expect(h.ports.finishCapture).toHaveBeenCalledOnce();
    h.completed(); h.completed(); await tick();
    expect(h.ports.save).toHaveBeenCalledTimes(1); expect(h.ports.save).toHaveBeenCalledWith('I take five milligrams', initial);
  });
  it('done() before any voice is heard is a no-op', () => {
    const h = harness(false); h.controller.start(); h.ready(); h.controller.done();
    expect(h.controller.state.status).toBe('listening'); expect(h.ports.finishCapture).not.toHaveBeenCalled(); expect(h.ports.stopPlayback).not.toHaveBeenCalled();
  });
  it('done() while thinking is a no-op', async () => {
    const h = harness(false); h.controller.start(); h.ready(); h.final(); h.controller.done(); h.completed(); await tick();
    expect(h.controller.state.status).toBe('thinking');
    h.ports.finishCapture.mockClear(); h.controller.done();
    expect(h.controller.state.status).toBe('thinking'); expect(h.ports.finishCapture).not.toHaveBeenCalled(); expect(h.ports.save).toHaveBeenCalledOnce();
  });
});

describe('restoreDraft port', () => {
  it('is optional: a spoken pause without it still pauses and saves nothing', async () => {
    const h = harness(false);
    const { restoreDraft: _unused, ...ports } = h.ports;
    const controller = new VoiceConversation(ports, h.timer);
    controller.start(); controller.event({ type: 'ready', scope: initial });
    controller.event({ type: 'recognition', scope: initial, segment: { start: 0, duration: 1, text: 'Earlier typed words. Pause.', isFinal: true, speechFinal: true }, interim: '' });
    h.timer.advance(endpointGrace.hold);
    controller.event({ type: 'completed', scope: initial, text: 'Earlier typed words. Pause.', clean: true, utterance: 'Pause.', prefix: 'Earlier typed words.' }); await tick();
    expect(controller.state.status).toBe('paused'); expect(h.ports.save).not.toHaveBeenCalled();
  });
});

describe('guided alternatives and speech source presentation', () => {
  it('reads the approved reply and resumed question as one interruptible utterance', () => {
    const h = harness();
    const speech = conversationSpeech({ currentPrompt: { id: 'Q04', topicId: 'Q04', text: 'When was your last measured weight?' }, adaptive: { mode: 'adaptive', available: true, reply: { id: 'COPY-05', text: 'Ask your prescriber about changes to your dose.' } } });
    expect(speech?.text).toBe('Ask your prescriber about changes to your dose.\n\nWhen was your last measured weight?');
    h.setContext({ scope: initial, eligible: true, blocked: false, speech });
    h.controller.start(); h.ready(); expect(h.ports.speak).toHaveBeenCalledExactlyOnceWith('conversation-current');
    h.controller.event({ type: 'voice', scope: initial }); h.controller.playback('idle');
    expect(h.ports.stopPlayback).toHaveBeenCalledOnce(); expect(h.ports.speak).toHaveBeenCalledOnce();
  });
  it('does not silently omit an oversized spoken reply and question', () => {
    const h = harness(); h.setContext({ scope: initial, eligible: true, blocked: false, speech: { id: 'conversation-current', text: 'a'.repeat(1201) } });
    h.controller.start(); h.ready(); expect(h.ports.speak).not.toHaveBeenCalled(); expect(h.controller.state.status).toBe('paused'); expect(h.ports.stopCapture).toHaveBeenCalledOnce();
  });
  const prompt = (choices?: PromptView['choices']): PromptView => ({ id: 'Q02:symptoms', topicId: 'Q02', text: 'What symptoms are you having?', choices });
  it('symptoms and other lists with only None/no alternatives retain a positive free-text path', () => {
    expect(promptAllowsFreeText(prompt([{ value: '__negative', label: 'None / no' }]))).toBe(true);
    expect(promptAllowsFreeText(prompt([{ value: '__not-applicable', label: 'Not applicable' }]))).toBe(true);
    expect(promptAllowsFreeText(prompt())).toBe(true);
  });
  it('fixed enums, Add/Done decisions, PHQ choices and structured fields keep their explicit controls', () => {
    expect(promptAllowsFreeText(prompt([{ value: '__add', label: 'Add an item' }, { value: '__negative', label: 'None / no' }]))).toBe(false);
    expect(promptAllowsFreeText(prompt([{ value: '0', label: 'Not at all' }, { value: '1', label: 'Several days' }]))).toBe(false);
    expect(promptAllowsFreeText({ ...prompt(), fields: [{ id: 'value', label: 'Amount', kind: 'number' }] })).toBe(false);
  });
  it('labels unreviewed speech explicitly without falsely marking it reviewed', () => {
    const source: SourceTurn = { id: 'raw', role: 'patient', at: '2026-10-09T20:00:00Z', text: 'not 50 mg', channel: 'unreviewed-transcript' };
    const html = renderToStaticMarkup(createElement(SourceInspector, { title: 'Medicine', ids: ['raw'], sources: [source], onClose() {} }));
    expect(html).toContain('Unreviewed recognized speech'); expect(html).not.toContain('Reviewed transcript'); expect(html).toContain('not 50 mg');
  });
});
