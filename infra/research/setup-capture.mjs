/** Explicit local-only credential alignment; never run by the gateway or builder. */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { localConfig } from './setup-local.mjs';

async function main() {
  if (!process.argv.includes('--allow-local-config-write')) throw new Error('Explicit local configuration write flag required');
  const env = await localConfig();
  const admin = new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false, fetch: (input, init) => {
    if (new URL(String(input)).origin !== env.CONVEX_SELF_HOSTED_URL) throw new Error('Local environment target changed');
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } });
  admin.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  // The installed CLI uses this exact system query for bounded single-variable readback.
  const current = await admin.query(makeFunctionReference('_system/cli/queryEnvironmentVariables:get'), { name: 'RESEARCH_MEDIA_GATEWAY_SECRET' });
  const directory = new URL('../../apps/research-server/runtime/', import.meta.url), path = new URL('capture.private.json', directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Error('Private runtime directory required');
  let config;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 65_536) throw new Error('Private gateway configuration required');
    config = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { deployment: env.CONVEX_SELF_HOSTED_URL, publicOrigin: 'http://127.0.0.1:5174', gatewaySecret: current?.value ?? randomBytes(32).toString('hex'), maxSegmentBytes: 8_000_000, cleanupIntervalMs: 2000 };
    // Persist first. An unknown environment-write outcome never creates a different secret.
    await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  if (config.deployment !== env.CONVEX_SELF_HOSTED_URL || config.publicOrigin !== 'http://127.0.0.1:5174' || !/^[a-f0-9]{64,128}$/.test(config.gatewaySecret)) throw new Error('Invalid local gateway target');
  if (current && current.value !== config.gatewaySecret) throw new Error('Existing local gateway credential differs; explicit reconciliation required');
  if (!current) {
    const response = await fetch(`${env.CONVEX_SELF_HOSTED_URL}/api/update_environment_variables`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Convex ${env.CONVEX_SELF_HOSTED_ADMIN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [{ name: 'RESEARCH_MEDIA_GATEWAY_SECRET', value: config.gatewaySecret }] }),
    });
    if (!response.ok) throw new Error('Local gateway environment alignment failed');
  }
  // Bounded readback verifies alignment; neither the response nor secret is logged.
  const readback = await admin.query(makeFunctionReference('_system/cli/queryEnvironmentVariables:get'), { name: 'RESEARCH_MEDIA_GATEWAY_SECRET' });
  if (readback?.value !== config.gatewaySecret) throw new Error('Local gateway environment alignment unconfirmed');
  console.log(`Local capture credential aligned; private configuration: ${fileURLToPath(path)}`);
}
void main().catch(() => { console.error('Local capture setup failed or is unconfirmed; private configuration retained. No automatic retry.'); process.exitCode = 1; });
