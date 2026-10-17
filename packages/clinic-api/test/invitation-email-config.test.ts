import { describe, expect, it } from 'vitest';
import { configuredInvitationEmail } from '../src/invitation-email-config.js';
describe('server-only invitation email configuration', () => {
  it('defaults to no email and an explicitly supplied key still has an empty allowlist', () => {
    expect(configuredInvitationEmail({})).toBeUndefined();
    expect(configuredInvitationEmail({ RESEND_API_KEY: 'synthetic-key' })).toEqual({ apiKey: 'synthetic-key', allowlist: [], recipients: {} });
  });
  it('loads only bounded explicit server recipient mappings', () => {
    expect(configuredInvitationEmail({ RESEND_API_KEY: 'synthetic-key', RESEND_FROM: 'demo@example.invalid', CLINIC_INVITATION_ALLOWLIST_JSON: '["synthetic@example.invalid"]', CLINIC_INVITATION_RECIPIENTS_JSON: '{"Patient/synthetic":"synthetic@example.invalid"}' })).toEqual({ apiKey: 'synthetic-key', from: 'demo@example.invalid', allowlist: ['synthetic@example.invalid'], recipients: { 'Patient/synthetic': 'synthetic@example.invalid' } });
  });
  it.each([
    { RESEND_API_KEY: 'secret\r\ninjected' }, { RESEND_FROM: 'Demo <demo@example.invalid>' },
    { CLINIC_INVITATION_ALLOWLIST_JSON: '{"secret":"wrong-type"}' }, { CLINIC_INVITATION_ALLOWLIST_JSON: '["bad-address"]' },
    { CLINIC_INVITATION_RECIPIENTS_JSON: '{"not-a-patient":"synthetic@example.invalid"}' },
    { CLINIC_INVITATION_RECIPIENTS_JSON: '{"Patient/synthetic":"bad-address"}' },
  ])('rejects invalid configuration without echoing secret text', environment => {
    expect(() => configuredInvitationEmail(environment)).toThrow(/^invitation-email-configuration-invalid$/);
  });
});
