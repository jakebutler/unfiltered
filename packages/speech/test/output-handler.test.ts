import { describe, expect, it, vi } from 'vitest';
import { createSpeechOutputHandler } from '../../../apps/clinic-server/src/speech-output.js';
import { speechOutputPath, speechInputPath } from '../../../packages/clinic-api/src/speech-access.js';

const origin = 'https://clinic.example';
const sessionId = '6f1f3d3e-2d4b-4c1e-9a53-3c1b2a4d5e6f';
const requestId = '0b8f6a4e-7c2d-4e91-8f3a-1d2c3b4a5e6f';
const input = { requestId, sessionId, expectedRevision: 3, sourceId: 'prompt-a' };
function setup() {
  const authenticate = vi.fn(async () => ({ sessionId }));
  const reserve = vi.fn(async () => ({ settle: vi.fn() }));
  const fetcher = vi.fn();
  const handler = createSpeechOutputHandler({ access: { authenticate, output: vi.fn() } as never, admission: { reserve }, elevenlabsApiKey: 'synthetic-key', fetcher });
  return { handler, authenticate, reserve, fetcher };
}
const speak = (search = '', init: { method?: string; type?: string } = {}) => new Request(`${origin}${speechOutputPath}${search}`, {
  method: init.method ?? 'POST', headers: { origin, 'content-type': init.type ?? 'application/json' }, body: JSON.stringify(input),
});

describe('plain-HTTP read-aloud output handler', () => {
  it('leaves other speech paths and clinic routes to the caller', async () => {
    const { handler, authenticate, reserve, fetcher } = setup();
    expect(await handler.handle(new Request(`${origin}${speechInputPath}`, { method: 'POST' }))).toBeUndefined();
    expect(await handler.handle(new Request(`${origin}/api/clinic/config`))).toBeUndefined();
    expect(authenticate).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('answers GET on the output path with a JSON 405 before authentication', async () => {
    const { handler, authenticate } = setup();
    const response = await handler.handle(new Request(`${origin}${speechOutputPath}`, { method: 'GET', headers: { origin } }));
    expect(response?.status).toBe(405); expect(response?.headers.get('content-type')).toContain('json');
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('refuses a query string with 405 before authentication', async () => {
    const { handler, authenticate } = setup();
    expect((await handler.handle(speak('?x=1')))?.status).toBe(405);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('requires JSON content before any provider work', async () => {
    const { handler, reserve, fetcher } = setup();
    expect((await handler.handle(speak('', { type: 'text/plain' })))?.status).toBe(415);
    expect(reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
