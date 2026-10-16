import type { InvitationEmailConfig } from './email.js';

export interface ConfiguredInvitationEmail extends InvitationEmailConfig { recipients?: Record<string, string>; }
const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Server-only environment adapter. Unconfigured delivery always stays copy-link only. */
export function configuredInvitationEmail(environment: Record<string, string | undefined>): ConfiguredInvitationEmail | undefined {
  const { RESEND_API_KEY: apiKey, RESEND_FROM: from, CLINIC_INVITATION_ALLOWLIST_JSON: allowlistRaw, CLINIC_INVITATION_RECIPIENTS_JSON: recipientsRaw } = environment;
  if ([apiKey, from, allowlistRaw, recipientsRaw].every(value => value === undefined)) return undefined;
  try {
    if (apiKey !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(apiKey) || from !== undefined && (from.length > 254 || !email.test(from)) || (allowlistRaw?.length ?? 0) > 30_000 || (recipientsRaw?.length ?? 0) > 40_000) throw new Error();
    const allowlist: unknown = allowlistRaw === undefined ? [] : JSON.parse(allowlistRaw);
    const recipients: unknown = recipientsRaw === undefined ? {} : JSON.parse(recipientsRaw);
    if (!Array.isArray(allowlist) || allowlist.length > 100 || allowlist.some(value => typeof value !== 'string' || value.length > 254 || !email.test(value)) || !object(recipients) || Object.keys(recipients).length > 100 || Object.entries(recipients).some(([key, value]) => !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(key) || typeof value !== 'string' || value.length > 254 || !email.test(value))) throw new Error();
    return { ...(apiKey ? { apiKey } : {}), ...(from ? { from } : {}), allowlist: allowlist as string[], recipients: recipients as Record<string, string> };
  } catch { throw new Error('invitation-email-configuration-invalid'); }
}
