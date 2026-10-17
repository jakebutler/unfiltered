import { afterEach, describe, expect, it, vi } from 'vitest';
import { invitationEmail } from '../src/email.js';
const config = { apiKey: 'server-only-test-key', from: 'demo@example.invalid', allowlist: ['synthetic@example.invalid'] };
const input = { to: 'synthetic@example.invalid', link: `https://clinic.example/join#token=${'a'.repeat(64)}`, workflowTitle: 'Private clinical title must not appear' };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('synthetic invitation email', () => {
  it('defaults to an empty allowlist and makes no fetch on misses', async () => {
    const fetcher = vi.fn();
    expect(await invitationEmail({}, fetcher).sendInvitationEmail(input)).toBe('failed');
    expect(await invitationEmail(config, fetcher).sendInvitationEmail({ ...input, to: 'other@example.invalid' })).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends one plain synthetic message without clinical context or logging the key', async () => {
    const log = vi.spyOn(console, 'log');
    const fetcher = vi.fn(async () => Response.json({ id: 'synthetic-email' }));
    expect(await invitationEmail(config, fetcher).sendInvitationEmail(input)).toBe('sent');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails'); expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body));
    expect(body.text).toContain('synthetic clinic demo'); expect(body.text).toContain(input.link); expect(body.html).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(input.workflowTitle); expect(log).not.toHaveBeenCalled();
  });
  it('has a hard five-second deadline even when the transport ignores abort and makes no retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const pending = invitationEmail(config, fetcher).sendInvitationEmail(input);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe('failed'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].signal?.aborted).toBe(true);
  });
  it.each([429, 500])('does not retry HTTP %s or expose provider response text', async status => {
    const fetcher = vi.fn(async () => new Response('provider secret text', { status }));
    expect(await invitationEmail(config, fetcher).sendInvitationEmail(input)).toBe('failed'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['https://clinic.example/join?token=secret', 'https://clinic.example/join#token=bad', 'https://clinic.example/other#token=' + 'a'.repeat(64), 'http://public.example/join#token=' + 'a'.repeat(64)])('rejects an unsafe link without sending', async link => {
    const fetcher = vi.fn(); expect(await invitationEmail(config, fetcher).sendInvitationEmail({ ...input, link })).toBe('failed'); expect(fetcher).not.toHaveBeenCalled();
  });
});
