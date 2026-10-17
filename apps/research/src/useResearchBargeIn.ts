import { useCallback, useEffect, useRef } from 'react';
import { CaptureResources, LocalVoiceActivity, StreamingPcm16, captureWorkletUrl } from '../../../packages/speech/src/browser-pcm';
export type TimedPcm = { at: number; bytes: Uint8Array };
/** Local-only voice detection while question audio plays. No provider connection. */
export function useResearchBargeIn(onVoice: () => void, onLost: () => void) {
  const latest = useRef({ onVoice, onLost }); latest.current = { onVoice, onLost };
  const owner = useRef<CaptureResources | null>(null), generation = useRef(0), frames = useRef<TimedPcm[]>([]);
  const stop = useCallback(() => { generation.current++; owner.current?.close(); owner.current = null; frames.current = []; }, []);
  const take = useCallback(() => { const current = frames.current.filter(frame => performance.now() - frame.at <= 1000); frames.current = []; return current; }, []);
  const start = useCallback(async (stream: MediaStream) => {
    stop(); const current = generation.current, resources = new CaptureResources(); owner.current = resources;
    const context = new AudioContext(); resources.own(() => { void context.close().catch(() => {}); });
    try {
      await context.resume(); await context.audioWorklet.addModule(captureWorkletUrl);
      if (current !== generation.current) return;
      const source = context.createMediaStreamSource(stream), processor = new AudioWorkletNode(context, 'research-capture'), silent = context.createGain(); silent.gain.value = 0;
      const vad = new LocalVoiceActivity(), encoder = new StreamingPcm16(context.sampleRate); let fired = false;
      resources.own(() => { processor.port.onmessage = null; processor.port.postMessage('stop'); processor.port.close(); source.disconnect(); processor.disconnect(); silent.disconnect(); });
      processor.port.onmessage = event => {
        if (current !== generation.current || !(event.data instanceof Float32Array) || event.data.length > 8192) return;
        if (!stream.getAudioTracks().some(track => track.readyState === 'live')) { stop(); latest.current.onLost(); return; }
        const at = performance.now(); frames.current.push({ at, bytes: encoder.encode(event.data) });
        frames.current = frames.current.filter(frame => at - frame.at <= 1000);
        while (frames.current.reduce((sum, frame) => sum + frame.bytes.length, 0) > 64000) frames.current.shift();
        if (!fired && vad.feed(event.data, context.sampleRate)) { fired = true; latest.current.onVoice(); }
      };
      source.connect(processor); processor.connect(silent); silent.connect(context.destination);
    } catch { if (current === generation.current) { stop(); latest.current.onLost(); } }
  }, [stop]);
  useEffect(() => stop, [stop]);
  return { start, stop, take };
}
