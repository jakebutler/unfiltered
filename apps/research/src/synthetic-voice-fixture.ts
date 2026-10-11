import { captureDevices, type BrowserCaptureDevices } from './capture-browser';

export interface ResearchMediaFixture {
  devices: BrowserCaptureDevices;
  speechSource(): Promise<{ stream: MediaStream; owned: boolean }>;
}
/** Explicit DEV route only. Real microphone/camera/screen APIs are never called.
 * Recording and speech use actual browser MediaStreams with synthetic PCM. */
export function createSyntheticVoiceFixture(): ResearchMediaFixture {
  async function stream() {
    const context = new AudioContext(), destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.frequency.value = 440; gain.gain.value = 0.05;
    oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
    const media = destination.stream;
    for (const track of media.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => { stop(); oscillator.stop(); void context.close(); };
    }
    return media;
  }
  return {
    devices: { ...captureDevices, stream: mode => mode === 'microphone' ? stream() : Promise.reject(new Error('Synthetic voice fixture supports only microphone recording')) },
    speechSource: async () => ({ stream: await stream(), owned: true }),
  };
}
