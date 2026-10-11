import { expect, it, vi } from 'vitest';
import { analysisReadiness, runAnalysis, type AnalysisRuntime } from '../src/analysis';
import { researchReportsGateway } from '../src/reports';
import type { ReportAuthority } from '../src/report-authority';
import { assembleAnalysisRuntime, parseAnalysisConfig } from '../src/analysis-config';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';

const { readPrepared } = vi.hoisted(() => ({ readPrepared: vi.fn() }));
vi.mock('../src/readiness-authority', () => ({ readinessAuthority: () => ({ readPreparedAnalysis: readPrepared }) }));

const origin = 'https://research.example.test';
const reservation = { id: 'static-reservation', model: 'qwen3.8-max' as const, maxInputBytes: 64000, maxOutputTokens: 128, expiresAt: Date.now() + 60_000, live: true };
function fixture(preparedOnly: boolean) {
  const provider = { classification: 'live' as const, model: reservation.model, prepare: vi.fn(), generate: vi.fn() };
  const runtime: AnalysisRuntime = { preparedOnly, reservations: [reservation], provider, visionQualified: true };
  const authority = { operator: vi.fn().mockResolvedValue({}), admit: vi.fn().mockResolvedValue({ analysisId: 'existing-analysis', state: 'ready' }), availableReservations: vi.fn().mockResolvedValue([reservation.id]) };
  const handle = researchReportsGateway({} as PrivateObjectStore, { publicOrigin: origin, deployment: 'https://example.convex.cloud', gatewaySecret: 'a'.repeat(64) }, runtime, () => authority as unknown as ReportAuthority);
  const request = () => new Request(origin + '/api/research/analysis', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'client', projectId: 'project', requestId: 'request-static', reservationId: reservation.id, selections: [{ sessionId: 'session', kind: 'self-report', id: 'source', start: 0, end: 4 }] }) });
  return { runtime, authority, provider, handle, request };
}

it('rejects a valid unexpired static reservation before admission or provider work in prepared-only mode', async () => {
  const f = fixture(true);
  expect((await f.handle(f.request())).status).toBe(409);
  expect(f.authority.operator).toHaveBeenCalledOnce();
  expect(f.authority.admit).not.toHaveBeenCalled();
  expect(f.provider.prepare).not.toHaveBeenCalled();
  expect(f.provider.generate).not.toHaveBeenCalled();
});

it('does not advertise the legacy reservation when saved-study preparation is required', async () => {
  const f = fixture(true);
  expect(await analysisReadiness(f.runtime, f.authority)).toMatchObject({ state: 'disabled', reservations: [], message: 'Use the saved study controls to prepare an analysis within its allowance.' });
  expect(f.authority.availableReservations).not.toHaveBeenCalled();
});

it('retains explicitly assembled local static-reservation readback without redispatch', async () => {
  const f = fixture(false);
  expect((await f.handle(f.request())).status).toBe(200);
  expect(f.authority.admit).toHaveBeenCalledOnce();
  expect(f.provider.generate).not.toHaveBeenCalled();
});

it('accepts only the native prepared child and never falls back after a rejected lookup', async () => {
  const f = fixture(true);
  const body = { scope: { clientId: 'client', projectId: 'project', studyId: 'study', studyVersion: 1 }, requestId: 'request-prepared', selections: [{ sessionId: 'session', kind: 'self-report', id: 'source', start: 0, end: 4 }] };
  const request = () => new Request(origin + '/api/research/analysis', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const child = { ...reservation, id: 'native-child-reservation' };
  readPrepared.mockResolvedValueOnce(child);
  expect((await f.handle(request())).status).toBe(200);
  expect(f.authority.admit.mock.calls[0][0].reservation).toEqual(child);
  readPrepared.mockRejectedValueOnce(new Error('Study disabled'));
  expect((await f.handle(request())).status).toBe(409);
  expect(f.authority.admit).toHaveBeenCalledOnce();
  expect(f.provider.generate).not.toHaveBeenCalled();
});

const preparedBody = { scope: { clientId: 'client', projectId: 'project', studyId: 'study', studyVersion: 1 }, requestId: 'request-prepared', selections: [{ sessionId: 'session', kind: 'self-report', id: 'source', start: 0, end: 4 }] };
const preparedRequest = (body: unknown) => new Request(origin + '/api/research/analysis', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
it('denies every non-text selection before prepared-child lookup, admission or provider preparation', async () => {
  const f = fixture(true); f.runtime.textOnly = true; readPrepared.mockClear();
  for (const kind of ['dom-event','screen-observation','camera-observation','audio','capture-gap']) {
    const result = await f.handle(preparedRequest({ ...preparedBody, selections: [{ ...preparedBody.selections[0], kind }] }));
    expect(result.status).toBe(409);
  }
  expect(readPrepared).not.toHaveBeenCalled(); expect(f.authority.admit).not.toHaveBeenCalled();
  expect(f.provider.prepare).not.toHaveBeenCalled(); expect(f.provider.generate).not.toHaveBeenCalled();
  expect(await analysisReadiness(f.runtime, f.authority)).toMatchObject({ textOnly: true, reservations: [] });
});
it('guards direct analysis invocation before admission or material/media access', async () => {
  const f = fixture(false); f.runtime.textOnly = true;
  const material = vi.fn(), read = vi.fn();
  await expect(runAnalysis({ ...f.authority, material } as unknown as ReportAuthority, { read } as unknown as PrivateObjectStore, f.runtime, { clientId: 'client', projectId: 'project', requestId: 'direct', selections: [{ ...preparedBody.selections[0], kind: 'camera-observation' }], reservation } as any, new AbortController().signal)).rejects.toThrow('participant text only');
  expect(f.authority.admit).not.toHaveBeenCalled(); expect(material).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it('configured live text-only adapter stays dormant when native prepared authority is disabled, without static fallback', async () => {
  const fetcher = vi.fn();
  const runtime = { ...assembleAnalysisRuntime(parseAnalysisConfig({ enabled: true, textOnly: true, provider: 'digitalocean', model: 'qwen3.8-max', qualificationId: 'DO-V1', ffmpegExecutable: '/bin/ffmpeg', reservations: [{ id: reservation.id, maxInputBytes: 64000, maxOutputTokens: 512, expiresAt: reservation.expiresAt }] }), () => 'synthetic-key', fetcher), preparedOnly: true };
  const f = fixture(true); readPrepared.mockClear(); readPrepared.mockRejectedValueOnce(new Error('Study disabled'));
  const handle = researchReportsGateway({} as PrivateObjectStore, { publicOrigin: origin, deployment: 'https://example.convex.cloud', gatewaySecret: 'a'.repeat(64) }, runtime, () => f.authority as unknown as ReportAuthority);
  expect((await handle(preparedRequest(preparedBody))).status).toBe(409);
  expect(readPrepared).toHaveBeenCalledOnce(); expect(f.authority.admit).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  expect((await handle(f.request())).status).toBe(409); expect(readPrepared).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
});
