import { readFile, writeFile, stat } from 'node:fs/promises';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

export const configurationPath = new URL('./.env.local', import.meta.url);
export async function localConfig() {
  if ((await stat(configurationPath)).mode & 0o077) throw new Error('Local configuration must be mode 0600');
  const env = Object.fromEntries((await readFile(configurationPath, 'utf8')).trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (env.CONVEX_SELF_HOSTED_URL !== 'http://127.0.0.1:3210' || !env.CONVEX_SELF_HOSTED_ADMIN_KEY || env.CONVEX_DEPLOY_KEY || env.CONVEX_DEPLOYMENT) throw new Error('Only the isolated local backend is supported');
  return env;
}
export async function setup() {
  const env = await localConfig();
  const path = new URL('./operator.private.json', import.meta.url);
  let secrets;
  try { secrets = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    secrets = { email: 'operator@corvo.example', name: 'Corvo Research Operator', password: randomBytes(32).toString('base64url'), privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trimEnd().replace(/\n/g, ' '), jwks: JSON.stringify({ keys: [{ use: 'sig', ...keys.publicKey.export({ format: 'jwk' }) }] }) };
    await writeFile(path, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
  }
  if ((await stat(path)).mode & 0o077) throw new Error('Local operator configuration must be mode 0600');
  const response = await fetch(`${env.CONVEX_SELF_HOSTED_URL}/api/update_environment_variables`, { method: 'POST', headers: { Authorization: `Convex ${env.CONVEX_SELF_HOSTED_ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: [ { name: 'JWT_PRIVATE_KEY', value: secrets.privateKey }, { name: 'JWKS', value: secrets.jwks }, { name: 'SITE_URL', value: 'http://127.0.0.1:5174' } ] }) });
  if (!response.ok) throw new Error(`Local auth setup failed: HTTP ${response.status}`);
  const admin = new ConvexHttpClient(env.CONVEX_SELF_HOSTED_URL, { logger: false }); admin.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  if (!await admin.query(makeFunctionReference('bootstrap:existing'), {})) {
    await admin.action(makeFunctionReference('bootstrap:operator'), { email: secrets.email, password: secrets.password, name: secrets.name });
  }
  return { url: env.CONVEX_SELF_HOSTED_URL, secrets };
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await setup(); console.log('Local operator and JWT issuer configured; credentials remain in mode-0600 local files.');
}
