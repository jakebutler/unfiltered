import { describe, expect, it, vi } from 'vitest';
import { staffAuthentication } from '../src/auth.js';
import { cookies } from '../src/cookies.js';
import { staffSessionCookies, type PortableStaffSession } from '../src/staff-session.js';
import type { ClinicApiConfig } from '../src/types.js';
const config = { origin: 'https://clinic.example', medplumBaseUrl: 'https://api.medplum.com/', projectId: 'project-1', clientId: 'client-1', clientSecret: 'test-runtime-secret', cookieSecret: 'test-cookie-key-at-least-32-characters-long', patients: {}, mentalHealth: 'phq4', staff: [{ membershipId: 'member-1', profile: 'Practitioner/staff-1', policy: 'AccessPolicy/clinical-1', name: 'Synthetic medical reviewer', role: 'physician', patients: ['Patient/patient-1'], careTeams: [] }] } as ClinicApiConfig;
function fixture() {
  const state = { revoked: false, project: 'project-1', membership: 'member-1', policy: 'clinical-1', logoutFails: false };
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path === '/auth/login') return Response.json({ code: 'one-time-code' });
    if (path === '/oauth2/token') return Response.json({ access_token: 'opaque-secret-staff-token', expires_in: 3600 });
    if (path === '/oauth2/logout') { if (state.logoutFails) throw new Error('offline'); state.revoked = true; return Response.json({ success: true }); }
    if (path === '/auth/me') return state.revoked ? Response.json({}, { status: 401 }) : Response.json({ project: { id: state.project }, profile: { resourceType: 'Practitioner', id: 'staff-1' }, membership: { id: state.membership }, accessPolicy: { id: state.policy } });
    throw new Error('unexpected-test-request');
  });
  const instance = (overrides: Partial<ClinicApiConfig> = {}) => { const c = { ...config, ...overrides }; return staffAuthentication(c, fetcher, cookies(c.cookieSecret, true)); };
  return { state, calls, fetcher, instance };
}
const request = (cookie: string) => new Request('https://clinic.example/api/staff/me', { headers: { cookie: cookie.split(';')[0] } });
describe('portable staff authentication', () => {
  it('survives another instance and keeps the OAuth token opaque to the browser', async () => {
    const f = fixture(); const login = await f.instance().login('synthetic@example.invalid', 'test');
    expect(login.cookie).toContain('; HttpOnly; SameSite=Strict; Path=/api;');
    expect(login.cookie).toContain('; Secure');
    expect(login.cookie).not.toContain('opaque-secret');
    const other = await f.instance().read(request(login.cookie));
    expect(other.assignment.role).toBe('physician');
    expect(other.client.config.accessToken).toBe('opaque-secret-staff-token');
    expect(f.calls.filter(path => path === '/auth/me')).toHaveLength(3);
  });
  it.each(['project', 'membership', 'policy'] as const)('rejects live %s change on another instance', async key => {
    const f = fixture(); const login = await f.instance().login('synthetic@example.invalid', 'test');
    f.state[key] = 'changed';
    await expect(f.instance().read(request(login.cookie))).rejects.toMatchObject({ code: 'staff-access-revoked' });
  });
  it('uses current server role assignments and refuses removed assignments', async () => {
    const f = fixture(); const login = await f.instance().login('synthetic@example.invalid', 'test');
    await expect(f.instance({ staff: [] }).read(request(login.cookie))).rejects.toMatchObject({ code: 'staff-session-required' });
  });
  it('native logout invalidates a copied cookie on every instance', async () => {
    const f = fixture(); const login = await f.instance().login('synthetic@example.invalid', 'test');
    expect(await f.instance().logout(request(login.cookie))).toContain('Max-Age=0');
    await expect(f.instance().read(request(login.cookie))).rejects.toMatchObject({ code: 'staff-access-revoked' });
  });
  it('does not claim native logout succeeded when its outcome is unknown', async () => {
    const f = fixture(); const login = await f.instance().login('synthetic@example.invalid', 'test');
    f.state.logoutFails = true;
    await expect(f.instance().logout(request(login.cookie))).rejects.toMatchObject({ code: 'staff-logout-unconfirmed', status: 503 });
  });
  it('rejects tampering, cross-project and cross-origin cookie replay before network', async () => {
    const f = fixture(); const login = await f.instance().login('synthetic@example.invalid', 'test');
    const value = login.cookie.split(';')[0];
    const tampered = `${value.slice(0, -5)}abcde`;
    const before = f.calls.length;
    await expect(f.instance().read(request(tampered))).rejects.toMatchObject({ code: 'staff-session-required' });
    await expect(f.instance({ projectId: 'other' }).read(request(login.cookie))).rejects.toMatchObject({ code: 'staff-session-required' });
    await expect(f.instance({ origin: 'https://other.example' }).read(request(login.cookie))).rejects.toMatchObject({ code: 'staff-session-required' });
    expect(f.calls.length).toBe(before);
  });
});
describe('encrypted staff cookie bounds', () => {
  const claims = (): PortableStaffSession => ({ schema: 1, sessionId: crypto.randomUUID(), token: 'test-token', profile: 'Practitioner/staff-1', membershipId: 'member-1', issuedAt: Date.now(), expires: Date.now() + 1000 });
  it('expires and rejects duplicate cookie names', async () => {
    const jar = staffSessionCookies(config.cookieSecret, 'test-audience', true);
    const cookie = await jar.issue(claims());
    const value = cookie.split(';')[0];
    await expect(jar.read(new Request('https://example.com', { headers: { cookie: `${value}; ${value}` } }))).rejects.toMatchObject({ code: 'staff-session-required' });
    vi.useFakeTimers(); vi.advanceTimersByTime(1001);
    try { await expect(jar.read(request(cookie))).rejects.toMatchObject({ code: 'staff-session-required' }); } finally { vi.useRealTimers(); }
  });
  it('does not accept an overlong lifetime or token', async () => {
    const jar = staffSessionCookies(config.cookieSecret, 'test-audience', true);
    await expect(jar.issue({ ...claims(), token: 'x'.repeat(2501) })).rejects.toThrow();
    const c = claims(); await expect(jar.issue({ ...c, expires: c.issuedAt + 1800001 })).rejects.toThrow();
  });
});
