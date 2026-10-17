import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: control.spawn }));
import { ffmpegFrames } from '../src/frames';
afterEach(() => { vi.useRealTimers(); control.spawn.mockReset(); });
function child() { const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() }); control.spawn.mockReturnValue(c); return c; }
describe('bounded decoder child', () => {
  it('kills a stalled decoder at eight seconds and admits a subsequent operation', async () => {
    vi.useFakeTimers(); const c = child(), extractor = ffmpegFrames('/fixture/ffmpeg');
    const first = extractor.extract(new Uint8Array([1]), 250, new AbortController().signal), denied = expect(first).rejects.toThrow('timed out');
    await expect(extractor.extract(new Uint8Array([1]), 250, new AbortController().signal)).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(8000); await denied; expect(c.kill).toHaveBeenCalledWith('SIGKILL');
    const next = child(), second = extractor.extract(new Uint8Array([1]), 250, new AbortController().signal), failed = expect(second).rejects.toThrow('frame unavailable'); next.emit('close', 1); await failed;
    const [executable, args, options] = control.spawn.mock.calls[0]; expect(executable).toBe('/fixture/ffmpeg'); expect(args).toContain('pipe'); expect(args).toContain('0.250'); expect(options.shell).toBeUndefined(); expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
  });
  it('kills over-cap output and aborts an active decode without keeping bytes', async () => {
    let c = child(); const extractor = ffmpegFrames('/fixture/ffmpeg'), signal = new AbortController();
    let promise = extractor.extract(new Uint8Array([1]), 0, signal.signal), denied = expect(promise).rejects.toThrow('exceeds admission'); c.stdout.write(Buffer.alloc(120_001)); await denied; expect(c.kill).toHaveBeenCalledWith('SIGKILL');
    c = child(); promise = extractor.extract(new Uint8Array([1]), 0, signal.signal); denied = expect(promise).rejects.toThrow('interrupted'); signal.abort(); await denied; expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
