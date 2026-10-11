import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ffmpegFrames, jpegDimensions, retainedFrame } from '../src/frames';
import { FFMPEG, decodedPixels, sample, sourceFixture, syntheticVideo } from '../scripts/frame-fixture';
import { digest } from '../../../packages/research-capture/src/contracts';

describe('real synthetic WebM and pipe-only ffmpeg', () => {
  let video: Uint8Array;
  beforeAll(async () => { video = await syntheticVideo(); });
  it('decodes independently playable JPEG pixels from the exact selected temporal phase', async () => {
    const source = await sourceFixture(video), extractor = ffmpegFrames(FFMPEG), signal = new AbortController().signal;
    const early = await retainedFrame(source.store, source.media, 1250, extractor, signal), late = await retainedFrame(source.store, source.media, 1750, extractor, signal);
    expect(video.length).toBeLessThan(100_000); expect(early.bytes.length).toBeLessThanOrEqual(120_000);
    expect(jpegDimensions(early.bytes)).toEqual({ width: 640, height: 360 }); expect(jpegDimensions(late.bytes)).toEqual({ width: 640, height: 360 });
    const a = await decodedPixels(early.bytes), b = await decodedPixels(late.bytes);
    expect(a.length).toBe(640 * 360 * 3); expect(b.length).toBe(a.length);
    const top = sample(a, 640, 10, 10), bottom = sample(a, 640, 10, 350), left = sample(b, 640, 10, 10), right = sample(b, 640, 630, 10);
    expect(top[0]).toBeGreaterThan(220); expect(top[1]).toBeLessThan(30); expect(top[2]).toBeLessThan(30);
    expect(bottom[2]).toBeGreaterThan(220); expect(bottom[0]).toBeLessThan(30);
    expect(left[1]).toBeGreaterThan(220); expect(left[0]).toBeLessThan(30);
    expect(right[0]).toBeGreaterThan(220); expect(right[1]).toBeGreaterThan(220); expect(right[2]).toBeLessThan(30);
    expect(await digest(early.bytes)).not.toBe(await digest(late.bytes));
  });
  it('rejects malformed video, absent selected frame, excess bytes and invalid offsets', async () => {
    const extractor = ffmpegFrames(FFMPEG), signal = new AbortController().signal;
    await expect(extractor.extract(new Uint8Array([1, 2, 3]), 0, signal)).rejects.toThrow('frame unavailable');
    await expect(extractor.extract(video, 2000, signal)).rejects.toThrow('frame unavailable');
    for (const offset of [-1, NaN, 0.5, 90_001]) await expect(extractor.extract(video, offset, signal)).rejects.toThrow('extraction unavailable');
    await expect(extractor.extract(new Uint8Array(8_000_001), 0, signal)).rejects.toThrow('extraction unavailable');
    await expect(extractor.extract(video, 0, AbortSignal.abort())).rejects.toThrow('extraction unavailable');
    expect(() => jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow('geometry');
  });
  it('rejects a corrupted retained source before invoking the real decoder', async () => {
    const source = await sourceFixture(video), wrong = video.slice(); wrong[wrong.length - 1] ^= 1;
    source.store.read = async () => new ReadableStream({ start(c) { c.enqueue(wrong); c.close(); } });
    const extract = vi.fn(ffmpegFrames(FFMPEG).extract);
    await expect(retainedFrame(source.store, source.media, 1250, { extract }, new AbortController().signal)).rejects.toThrow('checksum differs'); expect(extract).not.toHaveBeenCalled();
    await expect(retainedFrame(source.store, source.media, NaN, { extract }, new AbortController().signal)).rejects.toThrow('source unavailable');
  });
  it('cancels a pending retained-source read on deadline interruption', async () => {
    const source = await sourceFixture(video), controller = new AbortController(), cancel = vi.fn();
    source.store.read = async () => new ReadableStream({ cancel });
    const extract = vi.fn(), promise = retainedFrame(source.store, source.media, 1250, { extract }, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await expect(promise).rejects.toThrow('interrupted'); expect(cancel).toHaveBeenCalledOnce(); expect(extract).not.toHaveBeenCalled();
  });
});
