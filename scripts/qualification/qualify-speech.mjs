// One synthetic speech round trip. SP-Q1 is reserved in the shared usage ledger.
// A retained receipt prevents accidental replay; no automatic retries or paid extensions.
import { loadEnvFile } from 'node:process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const envPath = process.argv[process.argv.indexOf('--env') + 1];
if (!process.argv.includes('--env') || !envPath || !isAbsolute(envPath)) throw new Error('absolute-env-file-required');
if (statSync(envPath).mode & 0o077) throw new Error('private-env-file-required');
loadEnvFile(envPath);
const elevenKey = process.env.ELEVENLABS_API_KEY;
const deepgramKey = process.env.DEEPGRAM_API_KEY;
if (!elevenKey || !deepgramKey) throw new Error('speech-keys-required');
const phrase = 'This is a fictional patient for testing. My last measured weight was two hundred thirty pounds in August. I estimate two hundred thirty five now. I want my care team to review this before making any treatment decision.';
if (phrase.length > 250) throw new Error('character-budget-exceeded');
const dir = resolve('docs/implementation/evidence');
mkdirSync(dir, { recursive: true });
const receiptPath = resolve(dir, 'SP-Q1.json');
const receipt = { id: 'SP-Q1', startedAt: new Date().toISOString(), state: 'reserved', reservation: { elevenlabsCharacters: 250, deepgramCreditsUsd: 0.05, cashUsd: 0 }, syntheticText: phrase, noRetries: true, operations: [] };
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
async function bounded(response, limit) {
  if (!response.body) throw new Error('empty-response');
  const reader = response.body.getReader(); const parts = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new Error('response-too-large'); } parts.push(value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
async function metadata(url) {
  const r = await fetch(url, { headers: { 'xi-api-key': elevenKey }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`metadata-status-${r.status}`);
  return JSON.parse((await bounded(r, 1_000_000)).toString());
}
let active;
try {
  const subscription = await metadata('https://api.elevenlabs.io/v1/user/subscription');
  if (subscription.tier !== 'free' || subscription.can_extend_character_limit || subscription.character_limit - subscription.character_count < 250) throw new Error('free-character-coverage-not-established');
  receipt.elevenlabsBefore = { tier: subscription.tier, used: subscription.character_count, limit: subscription.character_limit, canExtend: subscription.can_extend_character_limit };
  const voices = await metadata('https://api.elevenlabs.io/v1/voices');
  const voice = voices.voices?.find(v => v.voice_id === 'JBFqnCBsd6RMkjVDRZzb' && v.category === 'premade');
  if (!voice) throw new Error('documented-premade-voice-unavailable');
  active = { provider: 'elevenlabs', operation: 'tts', model: 'eleven_flash_v2_5', voice: { id: voice.voice_id, name: voice.name }, characters: phrase.length, state: 'reserved', startedAt: new Date().toISOString() };
  receipt.operations.push(active); save();
  let start = performance.now();
  const generated = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voice_id}?output_format=mp3_22050_32`, { method: 'POST', headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: phrase, model_id: 'eleven_flash_v2_5' }), redirect: 'error', signal: AbortSignal.timeout(30000) });
  active.status = generated.status;
  active.providerRequestId = generated.headers.get('request-id') ?? generated.headers.get('x-request-id'); save();
  if (!generated.ok) throw new Error(`tts-status-${generated.status}`);
  const audio = await bounded(generated, 1_000_000);
  if (!generated.headers.get('content-type')?.startsWith('audio/') || !audio.length) throw new Error('invalid-audio-response');
  active.durationMs = Math.round(performance.now() - start); active.bytes = audio.length;
  active.sha256 = createHash('sha256').update(audio).digest('hex'); active.state = 'received'; save();
  // Local generated fixture only. No real microphone, patient, or biometric data.
  const audioDir = resolve('.qualification-build/speech'); mkdirSync(audioDir, { recursive: true });
  writeFileSync(resolve(audioDir, 'SP-Q1.mp3'), audio);
  active = { provider: 'deepgram', operation: 'stt', model: 'nova-3', state: 'reserved', startedAt: new Date().toISOString() };
  receipt.operations.push(active); save(); start = performance.now();
  const recognized = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true', { method: 'POST', headers: { Authorization: `Token ${deepgramKey}`, 'Content-Type': 'audio/mpeg' }, body: audio, redirect: 'error', signal: AbortSignal.timeout(30000) });
  active.status = recognized.status; save();
  if (!recognized.ok) throw new Error(`stt-status-${recognized.status}`);
  const result = JSON.parse((await bounded(recognized, 1_000_000)).toString());
  active.providerRequestId = result.metadata?.request_id; active.durationMs = Math.round(performance.now() - start);
  active.audioDurationSeconds = result.metadata?.duration;
  active.transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  active.confidence = result.results?.channels?.[0]?.alternatives?.[0]?.confidence;
  active.state = typeof active.transcript === 'string' && active.transcript.length ? 'received' : 'invalid-transcription'; save();
  const after = await metadata('https://api.elevenlabs.io/v1/user/subscription');
  receipt.elevenlabsAfter = { used: after.character_count, limit: after.character_limit, canExtend: after.can_extend_character_limit };
  receipt.state = active.state === 'received' ? 'round-trip-received-needs-human-review' : 'needs-review';
} catch (error) {
  if (active && active.state === 'reserved') active.state = 'failed-or-uncertain';
  receipt.state = 'needs-review';
  receipt.errorCode = /^([a-z]+-)+[a-z0-9]+$/.test(error.message) ? error.message : 'qualification-error';
}
receipt.finishedAt = new Date().toISOString(); save();
console.log(JSON.stringify(receipt, null, 2));
