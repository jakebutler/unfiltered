import { captureWorkletUrl, CaptureResources, PcmTransport } from '../voice-capture';

// This isolated Vite development page is not imported by the clinic application or its build entry.
if (!import.meta.env.DEV) throw new Error('Development fixture unavailable');
const start = document.querySelector<HTMLButtonElement>('#start')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const output = document.querySelector<HTMLElement>('#result')!;
let active: CaptureResources | undefined;
let generation = 0;
function halt(message = 'Stopped. No microphone or clinic/provider request was used.') {
  generation++; active?.close(); active = undefined; start.disabled = false; stop.disabled = true; output.textContent = message;
}
start.addEventListener('click', () => { void run(); });
stop.addEventListener('click', () => halt());
document.addEventListener('visibilitychange', () => { if (document.hidden) halt(); });
window.addEventListener('pagehide', () => halt());
async function run() {
  halt(); const token = generation, resources = new CaptureResources(); active = resources;
  start.disabled = true; stop.disabled = false; output.textContent = 'Running synthetic capture…';
  try {
    const context = new AudioContext(); resources.own(() => { void context.close(); }); await context.resume();
    if (token !== generation) return;
    await context.audioWorklet.addModule(captureWorkletUrl);
    if (token !== generation) return;
    const oscillator = context.createOscillator(), level = context.createGain(), silent = context.createGain();
    const processor = new AudioWorkletNode(context, 'clinic-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    oscillator.frequency.value = 440; level.gain.value = .05; silent.gain.value = 0;
    let samples = 0, bytes = 0, frames = 0, maximum = 0;
    const socket = { readyState: 1, bufferedAmount: 0, send(value: string | Uint8Array) { if (typeof value !== 'string') { bytes += value.length; frames++; maximum = Math.max(maximum, value.length); } } };
    const transport = new PcmTransport(socket, context.sampleRate); transport.ready({ sampleRate: 16000, channels: 1, maxCaptureMs: 2000 });
    resources.own(() => { processor.port.onmessage = null; processor.port.close(); processor.disconnect(); oscillator.stop(); oscillator.disconnect(); level.disconnect(); silent.disconnect(); transport.interrupt(); });
    processor.port.onmessage = event => {
      if (token !== generation) return;
      if (event.data instanceof Float32Array) { samples += event.data.length; transport.audio(event.data); }
      else if (event.data?.type === 'flushed') {
        transport.finish();
        const expected = Math.floor(samples * 16000 / context.sampleRate) * 2;
        halt(JSON.stringify({ fixture: 'offline-synthetic-audio-graph', inputSampleRate: context.sampleRate, inputSamples: samples, outputPcmBytes: bytes, expectedPcmBytes: expected, frames, maximumFrameBytes: maximum, partialFrameFlushed: true, passed: bytes === expected && bytes > 0 && maximum <= 16384, microphoneAccess: false, clinicOrProviderRequests: 0 }, null, 2));
      }
    };
    oscillator.connect(level); level.connect(processor); processor.connect(silent); silent.connect(context.destination); oscillator.start();
    const finish = window.setTimeout(() => processor.port.postMessage('finish'), 1000), deadline = window.setTimeout(() => halt('Fixture timed out; no microphone or clinic/provider request was used.'), 2000);
    resources.own(() => { window.clearTimeout(finish); window.clearTimeout(deadline); });
  } catch { if (token === generation) halt('This browser could not run the offline audio graph. No microphone or clinic/provider request was used.'); }
}
