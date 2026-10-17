import { join } from 'node:path';
import { awsClinicConfig } from './config.js';
import { createHostedClinicServer } from '../../cloud/vercel/application.js';
import { loadClinicAssets, type ClinicAssets } from '../../cloud/vercel/static-assets.js';

/** Reuses existing ingress/native authority; never injects provider credentials or adapters. */
export function createAwsClinicApplication(environment: Record<string, string | undefined>, assets: ClinicAssets) {
  const { config } = awsClinicConfig(environment);
  return createHostedClinicServer({ config, assets });
}

export function startAwsClinicApplication(environment: Record<string, string | undefined>) {
    const application = createAwsClinicApplication(environment, loadClinicAssets(join(__dirname, 'public')));
    process.once('SIGTERM', () => application.close());
    process.once('SIGINT', () => application.close());
    application.server.once('error', () => { console.error('AWS clinic listener failed'); application.close(); process.exitCode = 1; });
    // Private compute only. TLS/host routing belongs to the explicit edge profile; this is not a public HTTP deployment.
    application.server.listen(8080, '0.0.0.0');
    return application;
}
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  try { startAwsClinicApplication(process.env); }
  catch { console.error('AWS clinic startup failed'); process.exitCode = 1; }
}
