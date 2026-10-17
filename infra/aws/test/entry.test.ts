import { expect, it, vi } from 'vitest';
import { example, clinicFixture } from './fixtures.js';
const compose = vi.hoisted(() => vi.fn(() => ({ server: {}, close: vi.fn() })));
vi.mock('../../cloud/vercel/application.js', () => ({ createHostedClinicServer: compose }));
import { createAwsClinicApplication } from '../clinic/entry.js';
it('composes only matched configuration and public assets, without provider injection or listener startup', () => {
  const manifest = example('clinic-a'), config = clinicFixture(manifest), assets = new Map();
  createAwsClinicApplication({ AWS_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(manifest), CLINIC_CONFIG_JSON: JSON.stringify(config), DIGITALOCEAN_API_KEY: 'ignored-fixture', DEEPGRAM_API_KEY: 'ignored-fixture', RESEND_API_KEY: 'ignored-email-key', RESEND_FROM: 'demo@example.invalid', CLINIC_INVITATION_ALLOWLIST_JSON: '["synthetic@example.invalid"]', CLINIC_INVITATION_RECIPIENTS_JSON: '{"Patient/primary":"synthetic@example.invalid"}' }, assets);
  expect(compose).toHaveBeenCalledOnce(); expect(compose.mock.calls[0][0]).toEqual({ config, assets });
});
