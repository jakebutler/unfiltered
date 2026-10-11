import { spawn } from 'node:child_process';
import { digest, type PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
import type { AuthorizedMedia } from '../../../packages/research-capture/src/gateway';
export const FFMPEG = '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = '/opt/homebrew/bin/ffprobe';
/** Qualification-only bounded pipe process; no network, capture, credentials or shell. */
export async function pipeProcess(executable: string, args: string[], input: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    const chunks: Buffer[] = []; let bytes = 0, settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(error); } else resolve(new Uint8Array(Buffer.concat(chunks))); };
    const timer = setTimeout(() => finish(new Error('Fixture process timed out')), 8_000);
    child.once('error', () => finish(new Error('Fixture executable unavailable')));
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => { if (settled) return; bytes += chunk.length; if (bytes > maxBytes) finish(new Error('Fixture process exceeded bytes')); else chunks.push(chunk); });
    child.once('close', code => finish(code === 0 ? undefined : new Error('Fixture process failed')));
    child.stdin.end(input);
  });
}
export async function syntheticVideo(): Promise<Uint8Array> {
  const width = 160, height = 90, rgb = new Uint8Array(width * height * 3 * 4);
  // At 250ms: red top/blue bottom. At 750ms: green left/yellow right. No person or device data.
  for (let frame = 0; frame < 4; frame++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = frame < 2 ? y < 45 ? [255, 0, 0] : [0, 0, 255] : x < 80 ? [0, 255, 0] : [255, 255, 0];
    rgb.set(color, ((frame * height + y) * width + x) * 3);
  }
  const ui = "drawbox=x=15:y=12:w=130:h=65:color=white:t=fill,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='Delivery $5':x=24:y=22:fontsize=14:fontcolor=black,drawbox=x=40:y=48:w=80:h=22:color=0x1249a8:t=fill,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='Continue':x=49:y=51:fontsize=14:fontcolor=white";
  return pipeProcess(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '160x90', '-r', '4', '-i', 'pipe:0', '-vf', ui, '-frames:v', '4', '-an', '-c:v', 'libvpx', '-threads', '1', '-deadline', 'best', '-cpu-used', '0', '-b:v', '100k', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-f', 'webm', 'pipe:1'], rgb, 100_000);
}
export async function sourceFixture(bytes: Uint8Array): Promise<{ media: AuthorizedMedia; store: PrivateObjectStore }> {
  const sha256 = await digest(bytes), descriptor = { modality: 'screen' as const, sequence: 0, startMs: 1000, endMs: 2000, bytes: bytes.length, sha256, mime: 'video/webm', questionId: 'synthetic', sourceId: null };
  const media = { id: 'synthetic-video', key: 'research/synthetic/frameproof', descriptor } as AuthorizedMedia;
  const store: PrivateObjectStore = { head: async () => ({ bytes: bytes.length, sha256, mime: descriptor.mime }), read: async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }), putIfAbsent: async () => { throw new Error('Synthetic source is immutable'); }, retire: async () => { throw new Error('Synthetic source is immutable'); } };
  return { media, store };
}
export function sample(rgb: Uint8Array, width: number, x: number, y: number): number[] { const offset = (y * width + x) * 3; return [...rgb.slice(offset, offset + 3)]; }
export async function decodedPixels(jpeg: Uint8Array): Promise<Uint8Array> {
  return pipeProcess(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], jpeg, 640 * 640 * 3);
}
