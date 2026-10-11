import { expect, test, vi } from 'vitest';
import { SpeechAudioStream } from '../../../packages/speech/src/browser-audio';
test('continuous buffered question is playable only after complete response; disposal cannot replay provider work', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const playable = vi.fn(), revoked = vi.fn(), abort = new AbortController(), audio = { src: '' };
  const stream = new SpeechAudioStream({ audio, signal: abort.signal, isCurrent: () => !abort.signal.aborted, onPlayable: playable, onFailure: vi.fn(), environment: { createObjectURL: () => 'blob:prepared-question', revokeObjectURL: revoked } });
  const consumed = stream.consume(body); source.enqueue(new Uint8Array([1, 2]));
  await Promise.resolve(); await Promise.resolve(); expect(playable).not.toHaveBeenCalled(); expect(audio.src).toBe('');
  source.enqueue(new Uint8Array([3, 4])); source.close(); await consumed;
  expect(playable).toHaveBeenCalledOnce(); expect(audio.src).toBe('blob:prepared-question');
  abort.abort(); expect(revoked).toHaveBeenCalledOnce(); await expect(stream.consume(body)).rejects.toThrow('audio-response-already-used');
});
