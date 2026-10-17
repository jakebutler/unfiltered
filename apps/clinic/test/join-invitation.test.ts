import { describe, expect, it, vi } from 'vitest';
import { redeemJoinInvitation, takeInvitationToken } from '../src/join-invitation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JoinApp } from '../src/JoinApp';
const token = 'a'.repeat(64);
const location = () => ({ pathname: '/join', search: '', hash: `#token=${token}` });
describe('one-time invitation fragment', () => {
  it('requires a visible synthetic acknowledgment and keeps the capability out of markup', () => {
    const markup = renderToStaticMarkup(createElement(JoinApp, { initialToken: token }));
    expect(markup).toContain('fictional information only'); expect(markup).toContain('type="checkbox"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Open check-in<\/button>/);
    expect(markup).not.toContain(token);
  });
  it('clears the history fragment synchronously before invoking asynchronous redemption', async () => {
    const events: string[] = [], history = { state: { safe: true }, replaceState: vi.fn(() => { events.push('cleared'); }) };
    let finish!: (value: string) => void;
    const redeem = vi.fn((value: string) => { events.push('redeem'); expect(value).toBe(token); return new Promise<string>(resolve => { finish = resolve; }); });
    const pending = redeemJoinInvitation(location(), history, redeem);
    expect(events).toEqual(['cleared', 'redeem']); expect(history.replaceState).toHaveBeenCalledWith(history.state, '', '/join');
    finish('accepted'); expect(await pending).toBe('accepted');
  });
  it.each(['', '#token=bad', `#token=${token}&token=${token}`, `#token=${token}&other=secret`, `#other=${token}`])('clears malformed fragments and refuses redemption: %s', async hash => {
    const history = { state: null, replaceState: vi.fn() }, redeem = vi.fn();
    await expect(redeemJoinInvitation({ ...location(), hash }, history, redeem)).rejects.toThrow('invitation-invalid');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/join'); expect(redeem).not.toHaveBeenCalled();
  });
  it('removes query text and refuses tokens transported in a query', () => {
    const history = { state: null, replaceState: vi.fn() };
    expect(takeInvitationToken({ ...location(), search: '?token=secret' }, history)).toBeUndefined(); expect(history.replaceState).toHaveBeenCalledWith(null, '', '/join');
  });
  it('captures query rejection before replaceState mutates a live Location object', () => {
    let current = new URL(`https://clinic.example/join?token=secret#token=${token}`);
    const liveLocation = { get pathname() { return current.pathname; }, get search() { return current.search; }, get hash() { return current.hash; } };
    const history = { state: null, replaceState: vi.fn((_data: unknown, _unused: string, path?: string | URL | null) => { current = new URL(String(path), current); }) };
    expect(takeInvitationToken(liveLocation, history)).toBeUndefined();
    expect(current.href).toBe('https://clinic.example/join');
  });
  it('does not retry an uncertain redemption or retain token material in history', async () => {
    const history = { state: null, replaceState: vi.fn() }, redeem = vi.fn(async () => { throw new Error('unconfirmed'); });
    await expect(redeemJoinInvitation(location(), history, redeem)).rejects.toThrow('unconfirmed');
    expect(redeem).toHaveBeenCalledTimes(1); expect(JSON.stringify(history.replaceState.mock.calls)).not.toContain(token);
  });
});
