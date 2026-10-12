import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { listenDisabled, VoiceControls } from '../src/VoiceControls';

const idleCapture = { active: false, retained: false, status: 'idle', message: '', interim: '', slow: false, start() {}, finish() {}, stop() {}, pause() {}, retry() {}, discard() {} };
const conversation = { active: false, status: 'off', message: '', controller: { start() {}, stop() {}, confirmChoice() {}, retryChoice() {} } };
const playback = { status: 'idle', mode: 'buffered', message: '', slow: false, start() {}, stop() {}, playPrepared() {}, speakText() {}, replay() {} };

function render(capture: object) {
  return renderToStaticMarkup(createElement(VoiceControls, {
    available: true, conversation, conversationAllowed: false, captureAllowed: true, disabled: false, capture, playback,
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

describe('VoiceControls recovery of a kept recording', () => {
  const kept = { ...idleCapture, retained: true, status: 'retained', message: 'Transcription did not finish. Your recording is kept until you try again or discard it. Your typed words are unchanged.' };

  it('offers retry and discard even when the voice panel is closed', () => {
    const markup = render(kept);
    expect(markup).toContain('Try transcribing again');
    expect(markup).toContain('Discard recording');
    expect(markup).toContain('Your typed words are unchanged.');
  });
});
