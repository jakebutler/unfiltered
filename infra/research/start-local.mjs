import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setup, localConfig, configurationPath } from './setup-local.mjs';
const exec = promisify(execFile);
const cwd = fileURLToPath(new URL('../../', import.meta.url));
const docker = ['--context', 'colima-unfiltered-s0', 'compose', '-f', 'infra/research/compose.yml'];
await exec('docker', [...docker, 'up', '-d'], { cwd, timeout: 60_000 });
for (let attempt = 0; ; attempt++) {
  try { if ((await fetch('http://127.0.0.1:3210/version', { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
  if (attempt === 30) throw new Error('Local backend did not become ready');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
try { await stat(configurationPath); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const { stdout } = await exec('docker', [...docker, 'exec', '-T', 'backend', './generate_admin_key.sh'], { cwd, timeout: 10_000 });
  const key = stdout.trim(); if (!key || key.includes('\n')) throw new Error('Unexpected key format; output withheld');
  await writeFile(configurationPath, `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=${key}\n`, { mode: 0o600, flag: 'wx' });
}
await localConfig();
await exec(process.execPath, ['node_modules/convex/bin/main.js', 'dev', '--once', '--env-file', 'infra/research/.env.local'], { cwd, timeout: 60_000 });
await setup();
console.log('Research backend ready locally at http://127.0.0.1:3210; operator credentials remain in infra/research/operator.private.json.');
