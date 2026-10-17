import { execFile, spawn } from 'node:child_process';
import { createWriteStream, createReadStream, constants, existsSync, writeFileSync, lstatSync, realpathSync, readdirSync, mkdirSync, renameSync, chownSync, chmodSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { medplumProfile } from './profile.schema.ts';
import { privateFile, profileDigest, realDirectory, digest } from './render.mjs';

export async function command(executable, args, options = {}) {
  try { return (await promisify(execFile)(executable, args, { timeout: 60000, maxBuffer: 65536, ...options, encoding: 'utf8' })).stdout; }
  catch { throw new Error('native-command-failed-or-unknown'); }
}
export function loadRuntime(config, project, dockerHost) {
  realDirectory(config);
  const profile = medplumProfile(JSON.parse(privateFile(join(config, 'profile.json'))).clinic);
  if (!new RegExp(`^uf-aws-medplum-${profile.clinic.stackId}-[a-f0-9]{12}$`).test(project) || !/^unix:\/\/[A-Za-z0-9/._-]+\.sock$/.test(dockerHost)) throw new Error('explicit-owned-runtime-required');
  const composePath = join(config, 'compose.json'), compose = JSON.parse(privateFile(composePath, 32768));
  const rendered = JSON.parse(privateFile(join(config, 'rendered.json')));
  if (rendered.profileHash !== profileDigest(profile) || rendered.composeHash !== digest(JSON.stringify(compose)) || !['initialize', 'resume', 'restore'].includes(rendered.phase)) throw new Error('runtime-render-binding-invalid');
  const binds = compose.services?.postgres?.volumes;
  if (!Array.isArray(binds) || binds.length !== 2 || !binds[0].endsWith('/postgres:/var/lib/postgresql/data')) throw new Error('runtime-compose-invalid');
  const data = binds[0].slice(0, -'/postgres:/var/lib/postgresql/data'.length); realDirectory(data);
  const marker = JSON.parse(privateFile(join(data, '.authority.json')));
  if (marker.profileHash !== profileDigest(profile) || marker.stackId !== profile.clinic.stackId || marker.schema !== 1) throw new Error('runtime-authority-identity-invalid');
  const identity = JSON.parse(privateFile(join(config, 'recovery-identity.json')));
  if (identity.backendSecretRef !== profile.backendSecretRef || !/^[a-f0-9]{64}$/.test(identity.signingPublicKeyHash)) throw new Error('runtime-secret-identity-invalid');
  const env = { ...process.env, DOCKER_HOST: dockerHost, DOCKER_CONFIG: join(config, 'docker-empty') };
  if (!existsSync(env.DOCKER_CONFIG)) mkdirSync(env.DOCKER_CONFIG, { mode: 0o700 });
  if (lstatSync(env.DOCKER_CONFIG).mode & 0o077 || readdirSync(env.DOCKER_CONFIG).length || realpathSync(env.DOCKER_CONFIG) !== env.DOCKER_CONFIG) throw new Error('empty-private-docker-config-required');
  const composeArgs = ['compose', '--project-name', project, '--file', composePath];
  return { profile, data, config, project, marker, identity, compose, rendered, env, args: composeArgs,
    run: args => command('docker', [...composeArgs, ...args], { env }) };
}
export function updateMarker(runtime, state) {
  const path = join(runtime.data, '.authority.json'), temp = join(runtime.data, `.authority-${state}.pending`);
  writeFileSync(temp, JSON.stringify({ ...runtime.marker, state }), { mode: 0o600, flag: 'wx' }); renameSync(temp, path);
}
export async function copySafeTree(source, target, uid) {
  realDirectory(source); realDirectory(target);
  if (readdirSync(target).length) throw new Error('empty-tree-target-required');
  let files = 0, size = 0;
  function check(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error('tree-symlink-denied');
    if (info.isDirectory()) { for (const name of readdirSync(path)) { if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error('tree-name-invalid'); check(join(path, name)); } }
    else if (!info.isFile() || ++files > 4096 || (size += info.size) > 67108864) throw new Error('tree-bound-invalid');
  }
  check(source);
  // The caller deliberately creates and validates an empty target root. Copy its
  // children exclusively; copying the root itself rejects that valid existing dir.
  for (const name of readdirSync(source)) await cp(join(source, name), join(target, name), { recursive: true, force: false, errorOnExist: true });
  function ownership(path) {
    const info = lstatSync(path); chmodSync(path, info.isDirectory() ? 0o700 : 0o600);
    if (process.getuid?.() === 0) chownSync(path, uid, uid);
    if (info.isDirectory()) for (const name of readdirSync(path)) ownership(join(path, name));
  }
  ownership(target);
}
export async function dumpDatabase(runtime, destination) {
  const child = spawn('docker', [...runtime.args, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'medplum', '-Fc', 'medplum'], { env: runtime.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let count = 0; const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('database-dump-failed-or-unknown'))); });
  // Attach rejection handling immediately while stream completion is pending.
  exit.catch(() => {});
  try {
    async function* bounded() { for await (const bytes of child.stdout) { count += bytes.length; if (count > 67108864) { child.kill('SIGKILL'); throw new Error('database-dump-bound'); } yield bytes; } }
    await pipeline(bounded(), createWriteStream(destination, { flags: 'wx', mode: 0o600 })); await exit;
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); }
}
export async function restoreDatabase(runtime, source) {
  const info = lstatSync(source); if (!info.isFile() || info.isSymbolicLink() || info.size > 67108864) throw new Error('database-dump-invalid');
  const child = spawn('docker', [...runtime.args, 'exec', '-T', 'postgres', 'pg_restore', '-U', 'medplum', '--exit-on-error', '--single-transaction', '-d', 'medplum'], { env: runtime.env, stdio: ['pipe', 'ignore', 'ignore'] });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('database-restore-failed-or-unknown'))); }); exit.catch(() => {});
  try { await pipeline(createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, highWaterMark: 65536 }), child.stdin); await exit; }
  finally { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); }
}
export const argumentsFor = names => Object.fromEntries(names.map(name => { const i = process.argv.indexOf(`--${name}`); if (i < 0 || !process.argv[i + 1]) throw new Error('explicit-argument-required'); return [name, process.argv[i + 1]]; }));
export function reserveReceipt(path) {
  const parent = resolve(path, '..'); realDirectory(parent);
  if (lstatSync(parent).mode & 0o077 || existsSync(path)) throw new Error('new-private-receipt-required');
  writeFileSync(`${path}.intent`, JSON.stringify({ schema: 1, started: new Date().toISOString(), retry: 'forbidden-until-reconciled' }), { mode: 0o600, flag: 'wx' });
}
