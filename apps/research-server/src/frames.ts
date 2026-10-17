import { spawn } from 'node:child_process';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
import { digest } from '../../../packages/research-capture/src/contracts';
import type { AuthorizedMedia } from '../../../packages/research-capture/src/gateway';
import { ANALYSIS_LIMITS as L } from '../../../packages/research-core/src/analysis';
export type Frame = { bytes: Uint8Array; mime: 'image/jpeg' };
export interface FrameExtractor { extract(media: Uint8Array, offsetMs: number, signal: AbortSignal): Promise<Frame>; }
/** Inspect the decoder's JPEG envelope and SOF geometry; native qualification separately decodes its pixels. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('Invalid extracted JPEG');
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      const height = bytes[offset + 3] * 256 + bytes[offset + 4], width = bytes[offset + 5] * 256 + bytes[offset + 6];
      if (width < 1 || height < 1 || width > 640 || height > 640) break;
      return { width, height };
    }
    offset += length;
  }
  throw new Error('Invalid extracted JPEG geometry');
}
/** Local Node qualification boundary. No shell, files, network protocols or Worker transcoding. */
export function ffmpegFrames(executable: string): FrameExtractor {
  if (!executable.startsWith('/') || executable.includes('\u0000')) throw new Error('An explicit local ffmpeg executable is required');
  let busy = false;
  return { async extract(media, offsetMs, signal) {
    if (busy || signal.aborted || media.byteLength < 1 || media.byteLength > 8_000_000 || !Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs > 90_000) throw new Error('Frame extraction unavailable');
    busy = true;
    try {
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        const child = spawn(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '16000000', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-ss', (offsetMs / 1000).toFixed(3), '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2', '-q:v', '8', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
        let length = 0, settled = false; const chunks: Uint8Array[] = [];
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) { child.kill('SIGKILL'); reject(error); } else { const output = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; } resolve(output); } };
        const abort = () => finish(new Error('Frame extraction interrupted')), timer = setTimeout(() => finish(new Error('Frame extraction timed out')), 8_000);
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', () => finish(new Error('Frame extractor unavailable')));
        child.stdin.on('error', () => { /* child exit determines the bounded result */ });
        child.stdout.on('data', (chunk: Buffer) => { if (settled) return; length += chunk.length; if (length > L.frameBytes) finish(new Error('Selected frame exceeds admission')); else chunks.push(new Uint8Array(chunk)); });
        child.once('close', code => finish(code === 0 && length > 4 ? undefined : new Error('Selected frame unavailable')));
        child.stdin.end(media);
      });
      jpegDimensions(bytes);
      return { bytes, mime: 'image/jpeg' };
    } finally { busy = false; }
  } };
}
export async function retainedFrame(store: PrivateObjectStore, media: AuthorizedMedia, atMs: number, extractor: FrameExtractor, signal: AbortSignal): Promise<Frame> {
  if (signal.aborted || !Number.isSafeInteger(atMs)) throw new Error('Retained frame source unavailable');
  const expected = media.descriptor, head = await store.head(media.key);
  if (!head || head.bytes < 1 || head.bytes > 8_000_000 || head.bytes !== expected.bytes || head.sha256 !== expected.sha256 || head.mime !== expected.mime || expected.modality === 'microphone' || atMs < expected.startMs || atMs >= expected.endMs) throw new Error('Retained frame source unavailable');
  const stream = await store.read(media.key, { start: 0, end: head.bytes - 1 }), reader = stream.getReader(), bytes = new Uint8Array(head.bytes); let offset = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try { for (;;) { if (signal.aborted) throw new Error('Frame read interrupted'); const next = await reader.read(); if (signal.aborted) throw new Error('Frame read interrupted'); if (next.done) break; if (offset + next.value.length > bytes.length) throw new Error('Retained media changed'); bytes.set(next.value, offset); offset += next.value.length; } }
  finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); }
  if (offset !== bytes.length || await digest(bytes) !== head.sha256) throw new Error('Retained media checksum differs');
  const frame = await extractor.extract(bytes, atMs - expected.startMs, signal);
  if (!frame.bytes.length || frame.bytes.length > L.frameBytes) throw new Error('Frame exceeds admission'); return frame;
}
