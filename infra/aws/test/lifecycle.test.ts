import { once } from 'node:events';
import { expect, it } from 'vitest';
import { awsClinicConfig } from '../clinic/config.js';
import { createHostedClinicServer } from '../../cloud/vercel/application.js';
import { example, clinicFixture } from './fixtures.js';

it('uses the existing void close API and waits for the asynchronous native close event', async () => {
  const manifest = example('clinic-a');
  const { config } = awsClinicConfig({ AWS_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(manifest), CLINIC_CONFIG_JSON: JSON.stringify(clinicFixture(manifest)) });
  const application = createHostedClinicServer({ config, assets: new Map(), runtime: async () => { throw new Error('Offline test must not contact Medplum'); } });
  try {
    application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
    const closed = once(application.server, 'close');
    expect(application.close()).toBeUndefined();
    await closed;
    expect(application.server.listening).toBe(false); expect(application.server.address()).toBeNull();
  } finally {
    if (application.server.listening) { const closed = once(application.server, 'close'); application.server.closeAllConnections(); application.close(); await closed; }
  }
});
