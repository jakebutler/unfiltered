import { resolve } from 'node:path';
import { loadConfig } from './config';
import { startResearchServer } from './server';

async function main() {
  const i = process.argv.indexOf('--config');
  if (i < 0 || !process.argv[i + 1]) throw new Error('An explicit private configuration path is required');
  const config = await loadConfig(resolve(process.argv[i + 1]));
  const runtime = await startResearchServer(config);
  console.log('Research capture gateway ready on http://127.0.0.1:8789; private storage and serial cleanup enabled.');
  const stop = () => { void runtime.close().then(() => { process.exitCode = 0; }, () => { console.error('Research gateway shutdown did not finish cleanly.'); process.exitCode = 1; }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
void main().catch(() => { console.error('Research gateway startup failed; inspect local configuration and listener availability.'); process.exitCode = 1; });
