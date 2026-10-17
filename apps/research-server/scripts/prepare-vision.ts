import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analysisMessages, digitalOceanAnalysis, type AnalysisReservation } from '../src/analysis';
import { ffmpegFrames, jpegDimensions, retainedFrame } from '../src/frames';
import { FFMPEG, FFPROBE, decodedPixels, pipeProcess, sample, sourceFixture, syntheticVideo } from './frame-fixture';
import { DO_ENDPOINT, prepareDigitalOceanRequest, type DigitalOceanConfig, type InferenceMessage } from '../../../packages/clinical-core/src/digitalocean';
import { digest } from '../../../packages/research-capture/src/contracts';
import { evidenceId, validateFindings, type Evidence, type Finding } from '../../../packages/research-core/src/analysis';

export const candidate = Object.freeze({ model: 'qwen3.8-max' as const, maxInputBytes: 64_000, maxOutputTokens: 1024, timeoutMs: 15_000, frameCount: 1, frameBytes: 120_000 });
export function visionEnvelope(mediaHash: string, frame: Uint8Array) {
  const e: Evidence = { sessionId: 'synthetic-vision-session', kind: 'screen-observation', id: 'synthetic-video', start: 1250, end: 1251, hash: mediaHash, consentEpoch: 0, sharingEpoch: 0, retainApprovedExcerpts: false, text: null };
  const images: InferenceMessage[] = [{ role: 'user', content: [{ type: 'text', text: `Selected frame ${evidenceId(e)} at 1250 ms; ${e.kind}; derive no DOM event or emotional truth.` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(frame).toString('base64')}` } }] }];
  return { evidence: [e], messages: analysisMessages('Synthetic qualification goal: describe only the selected visible interface. Return exactly one tentative-screen finding. Quote readable interface text exactly and include the supplied timestamp in its statement. Describe static appearance only; do not infer user actions, thoughts, emotions or diagnosis. State single sampled frame limitations.', [e], images) };
}
export function validateVisionResult(value: unknown, evidence: Evidence[]): Finding[] {
  const findings = validateFindings(value, evidence);
  if (findings.length !== 1 || findings[0].type !== 'tentative-screen' || findings[0].supports.length !== 1 || findings[0].supports[0] !== evidenceId(evidence[0]) || findings[0].counterevidence.length || !findings[0].limitations.trim()) throw new Error('Vision probe is not source-bound');
  const statement = findings[0].statement;
  if (!statement.includes('1250') || !statement.includes('Delivery $5') || /\b(?:confus\w*|emotion\w*|diagnos\w*|anxious|depress\w*|pain|intent\w*|honest|dishonest|personality|clicked|selected|hesitat\w*)\b/i.test(statement)) throw new Error('Vision probe does not match visible sampled UI');
  return findings;
}
/** This script has no fetch/generate/admission path. Root must regenerate after prospective ledger reservation. */
export async function prepareVision(outputDirectory: string) {
  const video = await syntheticVideo(), source = await sourceFixture(video), atMs = 1250;
  const frame = await retainedFrame(source.store, source.media, atMs, ffmpegFrames(FFMPEG), new AbortController().signal), geometry = jpegDimensions(frame.bytes), pixels = await decodedPixels(frame.bytes);
  const earlyTop = sample(pixels, geometry.width, 10, 10), earlyBottom = sample(pixels, geometry.width, 10, geometry.height - 10);
  if (earlyTop[0] < 220 || earlyTop[1] > 30 || earlyBottom[2] < 220 || pixels.length !== geometry.width * geometry.height * 3) throw new Error('Synthetic frame time/pixel proof failed');
  const late = await retainedFrame(source.store, source.media, 1750, ffmpegFrames(FFMPEG), new AbortController().signal), latePixels = await decodedPixels(late.bytes), lateLeft = sample(latePixels, geometry.width, 10, 10), lateRight = sample(latePixels, geometry.width, geometry.width - 10, 10);
  if (lateLeft[1] < 220 || lateLeft[0] > 30 || lateRight[0] < 220 || lateRight[1] < 220 || lateRight[2] > 30 || await digest(late.bytes) === await digest(frame.bytes)) throw new Error('Temporal control differs from its selected phase');
  const probe = JSON.parse(new TextDecoder().decode(await pipeProcess(FFPROBE, ['-v', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'stream=codec_name,width,height,r_frame_rate:frame=best_effort_timestamp_time', '-of', 'json'], video, 10_000)));
  const frameTimesMs = (probe.frames as { best_effort_timestamp_time: string }[]).map(f => Number(f.best_effort_timestamp_time) * 1000);
  if (JSON.stringify(frameTimesMs) !== JSON.stringify([0, 250, 500, 750])) throw new Error('Synthetic source timestamps differ');
  const executableVersion = new TextDecoder().decode(await pipeProcess(FFMPEG, ['-version'], new Uint8Array(), 16_000)).split('\n')[0];
  const { evidence, messages } = visionEnvelope(source.media.descriptor.sha256, frame.bytes), e = evidence[0];
  const config: DigitalOceanConfig = { endpoint: DO_ENDPOINT, apiKey: 'offline-preparation-not-a-credential', model: candidate.model, timeoutMs: candidate.timeoutMs, maxOutputTokens: candidate.maxOutputTokens, maxRequestBytes: candidate.maxInputBytes, responseFormat: 'json' };
  // Zero expiry and unreserved identifier are explicit preparation placeholders, never valid admission.
  const reservation: AnalysisReservation = { id: 'UNRESERVED-DO-V1-CANDIDATE', model: candidate.model, maxInputBytes: candidate.maxInputBytes, maxOutputTokens: candidate.maxOutputTokens, expiresAt: 0, live: true };
  const adapter = await digitalOceanAnalysis(config).prepare(messages, reservation), wire = await prepareDigitalOceanRequest(config, messages), inputHash = await digest(new TextEncoder().encode(wire.body));
  if (adapter.inputHash !== inputHash || adapter.requestBytes !== wire.requestBytes || adapter.maxOutputTokens !== candidate.maxOutputTokens || wire.requestBytes > candidate.maxInputBytes || JSON.parse(wire.body).max_tokens !== candidate.maxOutputTokens) throw new Error('Exact candidate wire differs from adapter cap');
  const expected: Finding[] = [{ id: 'f1', type: 'tentative-screen', statement: 'At 1250 ms the sampled interface displays "Delivery $5" and a "Continue" button.', supports: [evidenceId(e)], counterevidence: [], limitations: 'One synthetic sampled screen frame; no interaction, audio, person or unsampled time evidence.' }];
  validateVisionResult(expected, [e]);
  const receipt = { id: 'DO-V1-PREFLIGHT', preparedAt: new Date().toISOString(), state: 'unreserved-candidate', dispatched: false, providerCalls: 0, reservation, limits: candidate, endpoint: `${DO_ENDPOINT}/v1/chat/completions`, method: 'POST', requestBytes: wire.requestBytes, inputHash, sources: [{ evidenceId: evidenceId(e), mediaHash: e.hash, bytes: video.length, mime: source.media.descriptor.mime, segmentStartMs: 1000, segmentEndMs: 2000, atMs, offsetMs: 250, imageHash: await digest(frame.bytes), imageBytes: frame.bytes.length, geometry }], nativeDecode: { executableVersion, stream: probe.streams?.[0], frameTimesMs, decodedPixelBytes: pixels.length, earlyTop, earlyBottom, temporalControl: { atMs: 1750, offsetMs: 750, imageHash: await digest(late.bytes), imageBytes: late.bytes.length, geometry: jpegDimensions(late.bytes), left: lateLeft, right: lateRight, suppliedToProvider: false } }, expected, primarySources: ['https://docs.digitalocean.com/products/inference/details/models/', 'https://docs.digitalocean.com/products/inference/how-to/use-multimodal-inference/'], stopConditions: ['Root must reserve credit and regenerate/finalize exact input hash and expiry before dispatch.', 'One exact model and one request only; no retry, fallback or repair.', 'Timeout/ambiguous response remains unknown and consumes admission until root review.', 'Exact response model, finish_reason stop, bounded JSON, source/timestamp/visible-quote checks required.', 'This native proof and candidate do not qualify provider vision, production ingress or real participant consent.'] };
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, bytes] of [['DO-V1-SYNTHETIC.webm', video], ['DO-V1-FRAME.jpg', frame.bytes], ['DO-V1-REQUEST.json', wire.body], ['DO-V1-PREFLIGHT.json', JSON.stringify(receipt, null, 2) + '\n']] as const) await writeFile(resolve(outputDirectory, name), bytes);
  return receipt;
}
if (process.argv.includes('--prepare-synthetic-vision')) {
  const output = process.argv[process.argv.indexOf('--prepare-synthetic-vision') + 1]; if (!output || !output.startsWith('/')) throw new Error('Explicit absolute artifact directory required');
  console.log(JSON.stringify(await prepareVision(resolve(output)), null, 2));
}
