import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserCapture, CaptureBufferBudget, CaptureUploadQueue, QueuedCaptureCancelled, captureMime, type BrowserCaptureDevices, type CapturePort, type CaptureSnapshot } from '../src/capture-browser';
function fixture(budget?: CaptureBufferBudget) {
  let now = 1000;
  const stop = vi.fn();
  const track = { stop, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const recorders: FakeRecorder[] = [];
  class FakeRecorder {
    state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['complete-container']) }); this.onstop?.(); }
  }
  const devices: BrowserCaptureDevices = { stream: vi.fn(async () => stream), supports: () => true, recorder: () => { const recorder = new FakeRecorder(); recorders.push(recorder); return recorder as unknown as MediaRecorder; } };
  const states: CaptureSnapshot[] = [];
  const port: CapturePort = { reserve: vi.fn(async () => ({ id: 'segment1', state: 'reserved' })), transfer: vi.fn(async (_id, _body, onDispatch) => { onDispatch?.(); return { state: 'available' }; }), gap: vi.fn(async () => undefined), changed: snapshot => states.push(snapshot) };
  const capture = new BrowserCapture(port, devices, () => now, budget);
  const start = (mode: 'microphone' | 'camera' | 'screen' = 'microphone') => capture.start({ mode, startedAt: 1000, deadline: 120000, sequence: 0, lastEnd: 0, questionId: 'q1' });
  return { capture, start, devices, port, states, stop, recorders, advance: (time: number) => { now = time; } };
}
afterEach(() => vi.useRealTimers());
describe('browser capture authority and container lifecycle', () => {
  it('selects only backend-supported complete container MIME types', () => {
    expect(captureMime('microphone', mime => mime === 'audio/mp4')).toBe('audio/mp4');
    expect(captureMime('screen', () => false)).toBeNull();
  });
  it('stops devices synchronously then saves a whole final container', async () => {
    const f = fixture(); await f.start(); f.advance(3000);
    const finishing = f.capture.stop();
    expect(f.stop).toHaveBeenCalledOnce();
    await finishing;
    expect(f.port.reserve).toHaveBeenCalledOnce();
    expect(f.port.transfer).toHaveBeenCalledOnce();
    const item = vi.mocked(f.port.reserve).mock.calls[0][0];
    expect(await item.body.text()).toBe('complete-container');
    expect(item.descriptor).toMatchObject({ sequence: 0, startMs: 0, endMs: 2000, questionId: 'q1', bytes: item.body.size });
    expect(item.descriptor.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('stops a late permission stream after pause, without creating a recorder', async () => {
    const f = fixture(); let permit!: (value: MediaStream) => void;
    const stream = { getTracks: () => [{ stop: f.stop }] } as unknown as MediaStream;
    f.devices.stream = () => new Promise(resolve => { permit = resolve; });
    const starting = f.start(); await f.capture.stop(false); permit(stream); await starting;
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.recorders).toHaveLength(0); expect(f.port.reserve).not.toHaveBeenCalled();
  });
  it('permission denial records the gap and leaves text available', async () => {
    const f = fixture(); f.devices.stream = async () => { throw new Error('denied'); }; await f.start();
    expect(f.port.gap).toHaveBeenCalledWith('microphone', 'permission-denied', 0);
    expect(f.states.at(-1)?.phase).toBe('idle'); expect(f.port.reserve).not.toHaveBeenCalled();
  });
  it('does not repeat an ambiguous PUT until explicit reconciliation authorizes it', async () => {
    const f = fixture(); vi.mocked(f.port.transfer).mockRejectedValueOnce(new Error('receipt lost'));
    await f.start(); f.advance(3000); await f.capture.stop();
    expect(f.states.at(-1)?.phase).toBe('unconfirmed'); expect(f.port.transfer).toHaveBeenCalledOnce();
    vi.mocked(f.port.transfer).mockResolvedValueOnce({ state: 'available' }); await f.capture.recover();
    expect(vi.mocked(f.port.transfer).mock.calls[1][1]).toBeNull(); expect(f.port.transfer).toHaveBeenCalledTimes(2);
    expect(f.port.reserve).toHaveBeenCalledOnce(); expect(f.states.at(-1)?.pending).toBe(0);
  });
  it('withdrawal stops and discards unsent bytes before a reservation', async () => {
    const f = fixture(); await f.start(); f.advance(3000); await f.capture.stop(false);
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.port.reserve).not.toHaveBeenCalled(); expect(f.port.transfer).not.toHaveBeenCalled();
  });
  it('after a gateway-fenced reserved receipt, recovery reuses the same logical source', async () => {
    const f = fixture(); vi.mocked(f.port.transfer).mockRejectedValueOnce(new Error('request lost'));
    await f.start(); f.advance(3000); await f.capture.stop();
    vi.mocked(f.port.transfer).mockResolvedValueOnce({ state: 'reserved', attempt: 1 }).mockResolvedValueOnce({ state: 'available' });
    await f.capture.recover(); expect(f.port.reserve).toHaveBeenCalledOnce();
    expect(vi.mocked(f.port.transfer).mock.calls.map(([id, body]) => [id, body === null])).toEqual([['segment1', false], ['segment1', true], ['segment1', false]]);
  });
  it('runs microphone, camera and screen concurrently with separate complete source identities', async () => {
    const budget = new CaptureBufferBudget();
    const microphone = fixture(budget), camera = fixture(budget), screen = fixture(budget);
    await Promise.all([microphone.start('microphone'), camera.start('camera'), screen.start('screen')]);
    expect(budget.retainedSources).toBe(3);
    expect([microphone, camera, screen].map(f => f.recorders[0].state)).toEqual(['recording', 'recording', 'recording']);
    [microphone, camera, screen].forEach(f => f.advance(3000));
    await Promise.all([microphone.capture.stop(), camera.capture.stop(), screen.capture.stop()]);
    expect([microphone, camera, screen].map(f => vi.mocked(f.port.reserve).mock.calls[0][0].descriptor.modality)).toEqual(['microphone', 'camera', 'screen']);
    expect([microphone, camera, screen].map(f => vi.mocked(f.port.reserve).mock.calls[0][0].descriptor.startMs)).toEqual([0, 0, 0]);
    expect(budget.retainedSources).toBe(0);
  });
  it('selective camera withdrawal leaves microphone and screen recording until global stop', async () => {
    const budget = new CaptureBufferBudget();
    const microphone = fixture(budget), camera = fixture(budget), screen = fixture(budget);
    await Promise.all([microphone.start('microphone'), camera.start('camera'), screen.start('screen')]);
    [microphone, camera, screen].forEach(f => f.advance(3000));
    await camera.capture.stop(false);
    expect(camera.stop).toHaveBeenCalledOnce(); expect(camera.port.reserve).not.toHaveBeenCalled();
    expect(microphone.stop).not.toHaveBeenCalled(); expect(screen.stop).not.toHaveBeenCalled();
    expect(microphone.recorders[0].state).toBe('recording'); expect(screen.recorders[0].state).toBe('recording');
    await Promise.all([microphone.capture.stop(), screen.capture.stop()]);
    expect(microphone.stop).toHaveBeenCalledOnce(); expect(screen.stop).toHaveBeenCalledOnce(); expect(budget.retainedSources).toBe(0);
  });
  it('bounds aggregate live and pending containers at six slots and records backpressure', async () => {
    const budget = new CaptureBufferBudget();
    const releases = Array.from({ length: 6 }, () => budget.acquire()!);
    expect(budget.maximumBytes).toBe(48_000_000); expect(budget.acquire()).toBeNull();
    const f = fixture(budget); await f.start('screen');
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.recorders).toHaveLength(0);
    expect(f.port.gap).toHaveBeenCalledWith('screen', 'capacity', 0);
    releases.forEach(release => release()); expect(budget.retainedSources).toBe(0);
  });

  it('serializes simultaneous complete-source uploads and cancels a withdrawn waiting source before dispatch', async () => {
    const uploads = new CaptureUploadQueue();
    const budget = new CaptureBufferBudget();
    const microphone = fixture(budget), camera = fixture(budget), screen = fixture(budget);
    const admissions = [new AbortController(), new AbortController(), new AbortController()];
    const dispatched: string[] = []; let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstDispatched!: () => void; const admitted = new Promise<void>(resolve => { firstDispatched = resolve; });
    [camera, screen].forEach(f => { f.port.reserve = vi.fn(async () => { await admitted; return { id: 'segment1', state: 'reserved' }; }); });
    [microphone, camera, screen].forEach((f, index) => {
      f.port.transfer = async (_id, body, onDispatch) => {
        if (!body) return { state: 'available' };
        return uploads.send(admissions[index].signal, () => !admissions[index].signal.aborted, async () => {
          onDispatch?.(); dispatched.push(['microphone', 'camera', 'screen'][index]);
          if (index === 0) { firstDispatched(); await first; }
          return { state: 'available' };
        });
      };
    });
    await Promise.all([microphone.start('microphone'), camera.start('camera'), screen.start('screen')]);
    [microphone, camera, screen].forEach(f => f.advance(3000));
    const stopping = [microphone.capture.stop(), camera.capture.stop(), screen.capture.stop()];
    // Observe completed digest/reservation entry without any service or device.
    await vi.waitFor(() => { expect(microphone.port.reserve).toHaveBeenCalledOnce(); expect(camera.port.reserve).toHaveBeenCalledOnce(); expect(screen.port.reserve).toHaveBeenCalledOnce(); expect(dispatched).toEqual(['microphone']); });
    admissions[1].abort(); await camera.capture.stop(false);
    expect(dispatched).toEqual(['microphone']); expect(budget.retainedSources).toBe(2);
    releaseFirst(); await Promise.all(stopping);
    expect(dispatched).toEqual(['microphone', 'screen']); expect(budget.retainedSources).toBe(0);
  });
  it('checks admission again at actual upload dispatch and does not silently rerun a failed active job', async () => {
    const uploads = new CaptureUploadQueue(); const admission = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = uploads.send(admission.signal, () => true, async () => { await gate; throw new Error('receipt unknown'); });
    const rejected = first.catch(error => error);
    let permitted = true; const dispatch = vi.fn(async () => 'sent');
    const waiting = uploads.send(admission.signal, () => permitted, dispatch); const cancellation = waiting.catch(error => error);
    permitted = false; release();
    expect(await rejected).toBeInstanceOf(Error); expect(await cancellation).toBeInstanceOf(QueuedCaptureCancelled); expect(dispatch).not.toHaveBeenCalled();
  });

});
