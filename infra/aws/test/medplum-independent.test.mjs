import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { medplumProfile } from '../medplum/profile.schema.ts';
import { profileDigest } from '../medplum/render.mjs';
import { encryptArchive } from '../medplum/archive.mjs';
import { restore } from '../medplum/restore.mjs';

test('independent counterexample: valid empty Binary backup must restore without native services', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uf-medplum-independent-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), data = join(root, 'target');
  for (const path of [source, data, join(source, 'binary'), join(source, 'redis'), ...['postgres', 'binary', 'redis'].map(name => join(data, name))]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(source, 'database.dump'), 'synthetic database', { mode: 0o600 });
  writeFileSync(join(source, 'redis/dump.rdb'), 'synthetic redis', { mode: 0o600 });
  const clinic = JSON.parse(readFileSync(new URL('../examples/clinic-a.json', import.meta.url)));
  const profile = medplumProfile(clinic), images = { postgres: 'p', redis: 'r', server: 's' }, identity = { synthetic: true };
  const runtime = { data, profile, identity, marker: { state: 'empty' }, compose: { services: Object.fromEntries(Object.entries(images).map(([name, image]) => [name, { image }])) } };
  const key = randomBytes(32), archive = join(root, 'backup.enc'), calls = [];
  await encryptArchive(source, archive, key, { profileHash: profileDigest(profile), stackId: profile.clinic.stackId, images, recoveryIdentity: identity,
    databaseOwner: 'medplum', postgresMajor: 16, workers: 'disabled', archiveLimitBytes: 67108864, checkpoint: 'synthetic' });
  const result = await restore(runtime, { archive, work: join(root, 'work'), key }, {
    run: async args => calls.push(args.join(' ')), restoreDb: async () => calls.push('restore-db'), marker: (_, state) => calls.push(state),
  });
  assert.equal(result.state, 'restored-sealed-unqualified');
  assert.deepEqual(readdirSync(join(data, 'binary')), []);
  assert.equal(readFileSync(join(data, 'redis/dump.rdb'), 'utf8'), 'synthetic redis');
  assert.equal(calls.at(-1), 'stop --timeout 30 postgres');
});
