import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ state: {} as any, row: {} as any, doc: {} as any, result: {} as any, receipts: new Map<string, any>(), occupied: false, expireDuringStart: false, expireDuringPreview: false, now: 1000, saveReview: vi.fn(), publish: vi.fn(), close: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), unlink: vi.fn(async () => {}) }));
vi.mock('../src/config', () => ({ loadConfig: async () => ({ deployment: 'http://127.0.0.1:3210', bindOrigin: 'http://127.0.0.1:8789', publicOrigin: 'http://127.0.0.1:5174' }), privateJson: async (path: string) => path.endsWith('-resume.json') ? mock.state : { email: 'synthetic', password: 'offline' } }));
vi.mock('../src/listener', () => ({ requireFreeListener: async () => { if (mock.occupied) throw new Error('Gateway listener already occupied'); } }));
vi.mock('../src/server', () => ({ startResearchServer: async () => { if (mock.expireDuringStart) mock.now = 3000; return { close: mock.close }; } }));
vi.mock('../../../apps/research/src/PublicationPreview', () => ({ clientProjection: vi.fn() }));
vi.mock('convex/browser', () => ({ ConvexHttpClient: class {
  setAuth() {}
  async action() { return { tokens: { token: 'offline-operator' } }; }
  async query(_ref: unknown, args: any) {
    if ('reviewRevision' in args) { if (mock.expireDuringPreview) mock.now = 3000; return { previewHash: 'offline-preview' }; }
    if ('analysisId' in args) return mock.row;
    if ('token' in args) return { revision: 1 };
    return null;
  }
  async mutation(_ref: unknown, args: any) {
    if ('previewHash' in args) { mock.publish(args); throw new Error('Stop offline after observed publication attempt'); }
    if ('findings' in args) { mock.saveReview(args); return 3; }
    return null;
  }
} }));
vi.mock('../scripts/report-trace-boundary', async original => ({ ...await original<typeof import('../scripts/report-trace-boundary')>(), bounded: async (path: string) => Buffer.from(JSON.stringify(path.endsWith('review.json') ? mock.doc : mock.result)), exclusive: async (_id: string, phase: string, receipt: any) => { mock.receipts.set(phase, receipt); } }));
import { publishReviewed } from '../scripts/qualify-live-reports';
import { hashValue } from '../../../packages/research-core/src/analysis';
beforeEach(async () => {
  mock.receipts.clear(); mock.occupied = false; mock.expireDuringStart = false; mock.expireDuringPreview = false; mock.now = 1000; mock.saveReview.mockClear(); mock.publish.mockClear(); mock.close.mockReset().mockResolvedValue(undefined);
  vi.spyOn(Date, 'now').mockImplementation(() => mock.now);
  const evidence = [{ sessionId: 's', id: 'text', kind: 'self-report', start: 0, end: 4, text: 'test', hash: '1'.repeat(64), consentEpoch: 1, sharingEpoch: 1, retainApprovedExcerpts: false }];
  const findings = [{ id: 'f1', type: 'self-report', statement: 'Offline test', supports: ['self-report:text:0:4'], counterevidence: [], limitations: 'Offline fixture' }];
  mock.row = { analysisId: 'analysis', state: 'ready', revision: 2, findings, evidence };
  const analysisHash = await hashValue(mock.row);
  mock.state = { id: 'DO-R901', phase: 'awaiting-root-review', token: 'offline-participant', scope: { clientId: 'client', projectId: 'project' }, analysisId: 'analysis', analysisHash, revision: 2, reviewUntil: 2000, selections: [] };
  mock.result = { ...mock.state, state: 'awaiting-root-review', providerCalls: 1 };
  mock.doc = { id: 'DO-R901', analysisId: 'analysis', analysisRevision: 2, analysisHash, title: 'Offline reviewed fixture', findings, excerpts: [{ evidenceId: 'self-report:text:0:4', text: 'test' }], grants: [] };
});
afterEach(() => vi.restoreAllMocks());
const options = () => ({ id: 'DO-R901', configPath: '/offline/config.json', operatorPath: '/offline/operator.json', reviewPath: '/offline/review.json', expectedHash: mock.state.analysisHash, expectedRevision: 2 });
describe('independent live tracer phase integration, no services or network', () => {
  it('never claims an unowned occupied gateway was stopped', async () => {
    mock.occupied = true;
    await publishReviewed(options(), true);
    expect(mock.close).not.toHaveBeenCalled();
    expect(mock.receipts.get('CLEANUP').shutdown.ownedGatewayStopped).toBe(false);
  });
  it('does not save or publish after the review window expires during startup', async () => {
    mock.expireDuringStart = true;
    await publishReviewed(options());
    expect(mock.saveReview).not.toHaveBeenCalled();
    expect(mock.publish).not.toHaveBeenCalled();
  });
  it('does not publish after the review window expires while reading the preview', async () => {
    mock.expireDuringPreview = true;
    await publishReviewed(options());
    expect(mock.saveReview).toHaveBeenCalledOnce();
    expect(mock.publish).not.toHaveBeenCalled();
  });
});
