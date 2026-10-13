import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { listenDisabled, VoiceControls } from '../src/VoiceControls';

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const idleCapture = { active: false, retained: false, status: 'idle', message: '', interim: '', slow: false, start() {}, finish() {}, stop() {}, pause() {}, retry() {}, discard() {} };
const conversation = { active: false, status: 'off', message: '', controller: { start() {}, stop() {}, confirmChoice() {}, retryChoice() {}, done() {} } };
const playback = { status: 'idle', mode: 'buffered', message: '', slow: false, start() {}, stop() {}, playPrepared() {}, speakText() {}, replay() {} };

function render(capture: object, conversationState: object = conversation) {
  return renderToStaticMarkup(createElement(VoiceControls, {
    available: true, conversation: conversationState, conversationAllowed: false, captureAllowed: true, disabled: false, capture, playback,
    onListen: () => undefined, questionTooLong: false, replyTooLong: false,
  } as never));
}
/** Opening tag of the first button whose label matches; enough to read its disabled attribute. */
function buttonOpening(markup: string, label: string) {
  const part = markup.split('<button').find(piece => piece.includes(label));
  return part ? part.slice(0, part.indexOf('>')) : undefined;
}

describe('VoiceControls listen gating', () => {
  it('keeps Listen to question available when no microphone work is pending', () => {
    expect(buttonOpening(render(idleCapture), 'Listen to question')).not.toMatch(/disabled/);
  });

  it('disables Listen to question while recording or transcribing', () => {
    expect(buttonOpening(render({ ...idleCapture, active: true, status: 'listening' }), 'Listen to question')).toMatch(/disabled/);
    expect(buttonOpening(render({ ...idleCapture, active: true, status: 'finishing' }), 'Listen to question')).toMatch(/disabled/);
  });

  it('helper keeps every listen button off while the capture is active', () => {
    expect(listenDisabled({ active: false }, false, false)).toBe(false);
    expect(listenDisabled({ active: true }, false, false)).toBe(true);
    expect(listenDisabled({ active: false }, true, false)).toBe(true);
    expect(listenDisabled({ active: false }, false, true)).toBe(true);
  });
});

/** Calls the component once with a stub dispatcher (it only uses useId and useState) and returns the element tree, so handlers can be reached without a DOM. */
function elementTree(capture: object, conversationState: object) {
  const previous = internals.H;
  internals.H = { useId: () => 'voice', useState: (init: unknown) => [init, () => undefined] };
  try {
    return VoiceControls({ available: true, conversation: conversationState, conversationAllowed: false, captureAllowed: true, disabled: false, capture, playback, onListen: () => undefined, questionTooLong: false, replyTooLong: false } as never);
  } finally { internals.H = previous; }
}
/** First element whose children include the exact label (a Button with an icon and text), in tree order. */
function findButton(node: unknown, label: string): { props: { onClick?: () => void } } | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = findButton(child, label); if (found) return found; } return undefined; }
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const props = (node as { props: { children?: unknown; onClick?: () => void } }).props;
  if (props.onClick && [props.children].flat().includes(label)) return node as { props: { onClick?: () => void } };
  return findButton(props.children, label);
}

describe('VoiceControls Done speaking', () => {
  it.each([
    [true, 'listening', true], [true, 'speaking', true],
    [true, 'thinking', false], [true, 'finishing', false], [true, 'saving', false], [true, 'connecting', false],
    [false, 'listening', false], [false, 'off', false], [false, 'paused', false],
  ])('shown only when active and listening or speaking: active=%s status=%s -> %s', (active, status, shown) => {
    const markup = render(idleCapture, { ...conversation, active, status });
    expect(markup.includes('Done speaking')).toBe(shown);
  });

  it('clicking Done speaking calls controller.done', () => {
    const done = vi.fn();
    const state = { ...conversation, active: true, status: 'listening', controller: { ...conversation.controller, done } };
    const button = findButton(elementTree(idleCapture, state), 'Done speaking');
    expect(button).toBeDefined(); button!.props.onClick!();
    expect(done).toHaveBeenCalledOnce();
  });
});

describe('VoiceControls recovery of a kept recording', () => {
  const kept = { ...idleCapture, retained: true, status: 'retained', message: 'Transcription did not finish. Your recording is kept until you try again or discard it. Your typed words are unchanged.' };

  it('offers retry and discard even when the voice panel is closed', () => {
    const markup = render(kept);
    expect(markup).toContain('Try transcribing again');
    expect(markup).toContain('Discard recording');
    expect(markup).toContain('Your typed words are unchanged.');
  });
});
