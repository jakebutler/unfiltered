import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFile, profileDigest } from './render.mjs';
import { decryptArchive } from './archive.mjs';
import { loadRuntime, copySafeTree, restoreDatabase, updateMarker, argumentsFor, reserveReceipt } from './runtime.mjs';

export async function restore(runtime, { archive, work, key }, dependencies = {}) {
  if (runtime.marker.state !== 'empty' || ['postgres', 'binary', 'redis'].some(name => readdirSync(join(runtime.data, name)).length) || runtime.compose.services.server.ports) throw new Error('empty-sealed-restore-target-required');
  const decrypt = dependencies.decrypt ?? decryptArchive, run = dependencies.run ?? runtime.run,
    restoreDb = dependencies.restoreDb ?? restoreDatabase, copy = dependencies.copy ?? copySafeTree, marker = dependencies.marker ?? updateMarker;
  const images = Object.fromEntries(Object.entries(runtime.compose.services).map(([name, service]) => [name, service.image]));
  // This completes GCM authentication, manifest identity and every file checksum
  // before starting PostgreSQL or touching any destination clinical directory.
  const decoded = await decrypt(archive, work, key, { profileHash: profileDigest(runtime.profile), stackId: runtime.profile.clinic.stackId,
    images, recoveryIdentity: runtime.identity, databaseOwner: 'medplum', postgresMajor: 16, workers: 'disabled', archiveLimitBytes: 67108864 });
  marker(runtime, 'restore-in-progress');
  try {
    await run(['up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '120', 'postgres']);
    await restoreDb(runtime, join(work, 'database.dump'));
    await copy(join(work, 'binary'), join(runtime.data, 'binary'), 1000);
    await copy(join(work, 'redis'), join(runtime.data, 'redis'), 999);
    marker(runtime, 'restored-sealed');
    return { schema: 1, state: 'restored-sealed-unqualified', archiveHash: decoded.archiveHash,
      checkpoint: decoded.manifest.checkpoint, profileHash: profileDigest(runtime.profile), currentAuthorityReconciled: false,
      workersEnabled: false, trafficOpened: false, nativeRestoreQualified: false };
  } finally {
    await run(['stop', '--timeout', '30', 'postgres']);
  }
}

if (process.argv.includes('--restore')) {
  let receipt;
  try {
    const args = argumentsFor(['config', 'project', 'docker-host', 'work', 'archive', 'key-file', 'receipt']);
    reserveReceipt(args.receipt); receipt = args.receipt;
    const result = await restore(loadRuntime(args.config, args.project, args['docker-host']), { archive: args.archive, work: args.work, key: privateFile(args['key-file'], 32) });
    writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); console.log(JSON.stringify({ state: result.state, receipt }));
  } catch {
    if (receipt) writeFileSync(receipt, JSON.stringify({ schema: 1, state: 'failed-or-unknown', traffic: 'sealed', automaticRetry: false }), { flag: 'wx', mode: 0o600 });
    console.error('medplum-restore-failed-or-unknown'); process.exitCode = 1;
  }
}
