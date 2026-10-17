import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFile, profileDigest } from './render.mjs';
import { encryptArchive } from './archive.mjs';
import { loadRuntime, copySafeTree, dumpDatabase, argumentsFor, reserveReceipt } from './runtime.mjs';

/** Native commands are dependency-injected only for focused offline sequencing tests. */
export async function backup(runtime, { work, archive, key, writersSealed }, dependencies = {}) {
  if (writersSealed !== runtime.profile.clinic.stackId || runtime.marker.state !== 'initialized') throw new Error('initialized-source-and-sealed-writers-required');
  const run = dependencies.run ?? runtime.run, dump = dependencies.dump ?? dumpDatabase,
    copy = dependencies.copy ?? copySafeTree, encrypt = dependencies.encrypt ?? encryptArchive;
  // No automatic restart or reopen on success or error.
  await run(['stop', '--timeout', '30', 'server']);
  const roles = (await run(['exec', '-T', 'postgres', 'psql', '-U', 'medplum', '-d', 'medplum', '-At', '-c', "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg_%' ORDER BY rolname"])).trim().split('\n');
  if (roles.length !== 1 || roles[0] !== 'medplum') throw new Error('unsupported-database-role-inventory');
  const redis = await run(['exec', '-T', 'redis', 'sh', '-c', 'export REDISCLI_AUTH="$(sed -n \'s/^requirepass //p\' /run/secrets/redis.conf)"; exec redis-cli SAVE']);
  if (redis.trim() !== 'OK') throw new Error('redis-save-failed-or-unknown');
  await run(['stop', '--timeout', '30', 'redis']);
  mkdirSync(work, { mode: 0o700 });
  for (const name of ['binary', 'redis']) mkdirSync(join(work, name), { mode: 0o700 });
  const checkpoint = new Date().toISOString();
  await dump(runtime, join(work, 'database.dump'));
  await copy(join(runtime.data, 'binary'), join(work, 'binary'), 1000);
  await copy(join(runtime.data, 'redis'), join(work, 'redis'), 999);
  const images = Object.fromEntries(Object.entries(runtime.compose.services).map(([name, service]) => [name, service.image]));
  const result = await encrypt(work, archive, key, { profileHash: profileDigest(runtime.profile), stackId: runtime.profile.clinic.stackId,
    checkpoint, images, recoveryIdentity: runtime.identity, databaseOwner: 'medplum', postgresMajor: 16, workers: 'disabled', archiveLimitBytes: 67108864 });
  return { schema: 1, state: 'backed-up-sealed-unqualified', archiveHash: result.archiveHash, checkpoint,
    profileHash: profileDigest(runtime.profile), fileCount: result.manifest.files.length, postCheckpointAuthority: 'reconciliation-required', nativeRestoreQualified: false };
}

if (process.argv.includes('--backup')) {
  let receipt;
  try {
    const args = argumentsFor(['config', 'project', 'docker-host', 'work', 'archive', 'key-file', 'writers-sealed', 'receipt']);
    reserveReceipt(args.receipt); receipt = args.receipt;
    const result = await backup(loadRuntime(args.config, args.project, args['docker-host']), { work: args.work, archive: args.archive,
      key: privateFile(args['key-file'], 32), writersSealed: args['writers-sealed'] });
    writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ state: result.state, receipt }));
  } catch {
    if (receipt) writeFileSync(receipt, JSON.stringify({ schema: 1, state: 'failed-or-unknown', traffic: 'sealed', automaticRetry: false }), { flag: 'wx', mode: 0o600 });
    console.error('medplum-backup-failed-or-unknown'); process.exitCode = 1;
  }
}
