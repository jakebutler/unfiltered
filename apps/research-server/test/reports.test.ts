import { describe, expect, it, vi } from 'vitest';
import { researchReportsGateway } from '../src/reports';
import { hashPassword, verifyPassword } from '../src/passwords';
import type { ReportAuthority } from '../src/report-authority';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
const origin = 'http://127.0.0.1:5174', config = { publicOrigin: origin, deployment: 'http://127.0.0.1:3210', gatewaySecret: 'a'.repeat(64) };
function delayedBody(path: string) {
  let release!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }; } });
  return { request: new Request(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer synthetic' }, body, duplex: 'half' } as RequestInit), release };
}
describe('password and report request boundary', () => {
  it('uses salted async native KDF and constant-time comparison', async () => {
    const credentials = await hashPassword('synthetic report password'); expect(credentials.passwordSalt).toHaveLength(64); expect(credentials.passwordHash).toHaveLength(64);
    expect(await verifyPassword('synthetic report password', credentials.passwordSalt, credentials.passwordHash)).toBe(true);
    expect(await verifyPassword('another wrong password', credentials.passwordSalt, credentials.passwordHash)).toBe(false);
    expect(await verifyPassword('short', credentials.passwordSalt, credentials.passwordHash)).toBe(false);
  });
  it.each(['/api/research/analysis', '/api/research/shares', '/api/research/portal/unlock'])('locks %s admission before awaiting the body', async path => {
    const authority = { operator: vi.fn().mockResolvedValue({}) } as unknown as ReportAuthority, handle = researchReportsGateway({} as PrivateObjectStore, config, undefined, () => authority), first = delayedBody(path), second = delayedBody(path);
    const pending = handle(first.request); await new Promise(resolve => setTimeout(resolve, 0));
    const rejected = await handle(second.request); expect(rejected.status).toBe(429);
    first.release(); expect((await pending).status).toBe(409);
    second.release();
  });
  it('denies mutation origin mismatch before parsing or authority calls', async () => {
    const operator = vi.fn(), handle = researchReportsGateway({} as PrivateObjectStore, config, undefined, () => ({ operator } as unknown as ReportAuthority));
    const response = await handle(new Request(`${origin}/api/research/shares`, { method: 'POST', headers: { Origin: 'https://wrong.example', 'Content-Type': 'application/json' }, body: '{}' })); expect(response.status).toBe(403); expect(operator).not.toHaveBeenCalled();
  });
});
