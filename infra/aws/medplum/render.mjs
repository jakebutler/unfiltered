import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, existsSync, chownSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey } from 'node:crypto';
import { medplumProfile, parseBackendSecret, serverConfig } from './profile.schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function profileDigest(profile) { return digest(JSON.stringify(profile)); }

export function privateFile(path, limit = 16384) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > limit || realpathSync(path) !== resolve(path)) throw new Error('private-file-invalid');
  return readFileSync(path);
}
export function realDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error('directory-invalid');
  return resolve(path);
}
export function validateData(profile, path, phase) {
  realDirectory(path);
  const marker = JSON.parse(privateFile(join(path, '.authority.json')));
  if (marker.schema !== 1 || marker.profileHash !== profileDigest(profile) || marker.stackId !== profile.clinic.stackId) throw new Error('authority-identity-invalid');
  if (phase === 'initialize' && (marker.state !== 'empty' || existsSync(join(path, 'postgres/PG_VERSION')))) throw new Error('initialization-over-existing-data-denied');
  const freshRestore = phase === 'restore' && marker.state === 'empty';
  if (phase !== 'initialize' && !freshRestore && (!['initialized', 'restored-sealed'].includes(marker.state) || readFileSync(join(path, 'postgres/PG_VERSION'), 'utf8').trim() !== '16')) throw new Error('existing-authority-data-required');
  if (marker.state === 'restored-sealed' && phase !== 'restore') throw new Error('restored-authority-is-sealed');
  for (const name of ['postgres', 'binary', 'redis']) realDirectory(join(path, name));
  if ((phase === 'initialize' || freshRestore) && ['postgres', 'binary', 'redis'].some(name => readdirSync(join(path, name)).length)) throw new Error('initialization-requires-empty-data');
  return marker;
}

export function renderRuntime({ clinic, secret: input, phase, data, config, listen = '127.0.0.1:8103', composeSource }) {
  const profile = medplumProfile(clinic), secret = parseBackendSecret(input, profile);
  validateData(profile, data, phase);
  realDirectory(dirname(config));
  if (existsSync(config) || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(data) || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(config) || !/^(?:127\.0\.0\.1:(?:8103|82[0-9]{2})|0\.0\.0\.0:8103)$/.test(listen)) throw new Error('runtime-path-or-listener-invalid');
  const server = serverConfig(profile, secret, phase);
  const compose = JSON.parse(JSON.stringify(composeSource).replaceAll('@DATA@', data).replaceAll('@CONFIG@', config).replaceAll('@LISTEN@', listen));
  if (phase === 'restore') delete compose.services.server.ports;
  mkdirSync(config, { mode: 0o700 });
  const files = { 'medplum-server.json': JSON.stringify(server), 'postgres-password': secret.databasePassword,
    'redis.conf': `bind 0.0.0.0\nprotected-mode yes\nrequirepass ${secret.redisPassword}\ndir /data\nappendonly yes\nappendfsync always\nsave 60 1\nmaxmemory 192mb\nmaxmemory-policy noeviction\n` };
  for (const [name, body] of Object.entries(files)) {
    const path = join(config, name); writeFileSync(path, body, { mode: 0o400, flag: 'wx' });
    if (process.getuid?.() === 0) chownSync(path, name === 'medplum-server.json' ? 1000 : name === 'redis.conf' ? 999 : 0, name === 'medplum-server.json' ? 1000 : name === 'redis.conf' ? 999 : 0);
  }
  writeFileSync(join(config, 'compose.json'), JSON.stringify(compose, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(join(config, 'profile.json'), JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(config, 'rendered.json'), JSON.stringify({ schema: 1, phase, profileHash: profileDigest(profile), composeHash: digest(JSON.stringify(compose)) }), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(config, 'recovery-identity.json'), JSON.stringify({ backendSecretRef: profile.backendSecretRef,
    signingKeyId: secret.signingKeyId, signingPublicKeyHash: digest(createPublicKey(secret.signingKey).export({ type: 'spki', format: 'der' })) }), { mode: 0o600, flag: 'wx' });
  return { profileHash: profileDigest(profile), secretOutput: 'runtime-files-only', phase, traffic: phase === 'restore' ? 'sealed' : 'private-clinic-server-only' };
}

if (process.argv.includes('--backend-secret')) {
  try {
    const arg = name => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error('argument-required'); return process.argv[i + 1]; };
    const clinic = JSON.parse(readFileSync(join(here, 'clinic.json'), 'utf8'));
    const result = renderRuntime({ clinic, secret: JSON.parse(privateFile(arg('--backend-secret'))), phase: arg('--phase'),
      data: arg('--data'), config: arg('--output'), listen: arg('--listen'), composeSource: JSON.parse(readFileSync(join(here, 'compose.yml'), 'utf8')) });
    console.log(JSON.stringify({ state: 'rendered-unqualified', ...result }));
  } catch { console.error('medplum-runtime-render-failed'); process.exitCode = 1; }
}
