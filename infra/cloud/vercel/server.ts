import { join } from 'node:path';
import { hostedClinicConfig } from './hosted-config.js';
import { loadClinicAssets } from './static-assets.js';
import { createHostedClinicServer } from './application.js';
import { hostedInterpreterProviders } from '../../../apps/clinic-server/src/providers.js';
import { runtimeProvider } from '../../../packages/clinic-api/src/runtime.js';

/** Runtime-only configuration. The interpreter is opt-in by env and always budget-capped. Platform owns listening. */
export function createClinicApplication() {
  const config = hostedClinicConfig(process.env);
  const runtime = runtimeProvider(config, fetch);
  const app = createHostedClinicServer({ config, runtime, providers: hostedInterpreterProviders(runtime), assets: loadClinicAssets(join(__dirname, 'site-assets')) });
  process.once('SIGTERM', () => app.close());
  return app.server;
}
