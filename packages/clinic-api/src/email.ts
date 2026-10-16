import type { Fetch } from '../../clinical-core/src/transport.js';

export interface InvitationEmailConfig { apiKey?: string; from?: string; allowlist?: readonly string[]; }
export interface InvitationEmail { to: string; link: string; workflowTitle: string; }
const address = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

/** Empty configuration is deliberately copy-link only. Never retries or logs provider data. */
export function invitationEmail(config: InvitationEmailConfig = {}, fetcher: Fetch = fetch) {
  return {
    async sendInvitationEmail({ to, link }: InvitationEmail): Promise<'sent' | 'failed'> {
      if (!address.test(to) || !config.allowlist?.some(allowed => address.test(allowed) && allowed.toLowerCase() === to.toLowerCase()) || !config.apiKey || /[\r\n]/.test(config.apiKey) || !config.from || !address.test(config.from)) return 'failed';
      try {
        const url = new URL(link);
        if (url.username || url.password || url.search || url.pathname !== '/join' || !/^#token=[a-f0-9]{64}$/.test(url.hash) || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return 'failed';
      } catch { return 'failed'; }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The hard deadline also bounds a noncooperative injected transport.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('email-timeout')); }, 5000);
      });
      try {
        const response = await Promise.race([fetcher('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: config.from, to: [to], subject: 'Your synthetic clinic demo link', text: `You have been invited to try a synthetic clinic demo. This demo is for fictional information only.\n\nOpen your one-time link within 72 hours:\n${link}\n\nIf you did not expect this invitation, you can ignore this email.` }),
        }), deadline]);
        // Provider error text and identifiers are deliberately never read or surfaced.
        void response.body?.cancel().catch(() => undefined);
        return response.ok ? 'sent' : 'failed';
      } catch { return 'failed'; }
      finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}
