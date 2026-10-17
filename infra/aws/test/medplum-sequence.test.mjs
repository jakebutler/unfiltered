import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { medplumProfile } from '../medplum/profile.schema.ts';
import { backup } from '../medplum/backup.mjs';
import { restore } from '../medplum/restore.mjs';

const clinic = JSON.parse(readFileSync(new URL('../examples/clinic-a.json', import.meta.url)));
function fixture(t, state = 'empty') {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'uf-medplum-order-'))); t.after(() => rmSync(data, { recursive: true, force: true }));
  for (const name of ['postgres', 'binary', 'redis']) mkdirSync(join(data, name), { mode: 0o700 });
  return { data, profile: medplumProfile(clinic), marker: { state }, identity: { synthetic: true }, compose: { services: { postgres: { image: 'p' }, redis: { image: 'r' }, server: { image: 's' } } } };
}
test('backup stops writers/Redis before dump and never automatically restarts', async t => {
  const runtime = fixture(t, 'initialized'), calls = [];
  const result = await backup(runtime, { work: join(runtime.data, 'work'), archive: 'mock', key: Buffer.alloc(32), writersSealed: 'clinic-a' }, {
    run: async args => { calls.push(args); return args.includes('psql') ? 'medplum\n' : args.includes('sh') ? 'OK\n' : ''; },
    dump: async () => calls.push(['dump']), copy: async () => calls.push(['copy']),
    encrypt: async () => { calls.push(['encrypt']); return { archiveHash: 'a'.repeat(64), manifest: { files: [] } }; },
  });
  assert.deepEqual(calls[0], ['stop', '--timeout', '30', 'server']); assert.deepEqual(calls[3], ['stop', '--timeout', '30', 'redis']);
  assert.deepEqual(calls.slice(4).map(args => args[0]), ['dump', 'copy', 'copy', 'encrypt']);
  assert.ok(!calls.some(args => args.includes('up'))); assert.equal(result.nativeRestoreQualified, false);
});
test('unexpected roles and unknown Redis SAVE stop backup without replay', async t => {
  for (const kind of ['roles', 'unknown']) {
    const runtime = fixture(t, 'initialized'), calls = [];
    await assert.rejects(backup(runtime, { work: join(runtime.data, kind), writersSealed: 'clinic-a' }, {
      run: async args => { calls.push(args); if (args.includes('psql')) return kind === 'roles' ? 'medplum\nother\n' : 'medplum\n'; if (args.includes('sh')) throw new Error('unknown'); return ''; },
    }));
    assert.ok(!calls.some(args => args.includes('up'))); assert.ok(!calls.some(args => args[0] === 'stop' && args.includes('redis')));
  }
});
test('failed archive authentication precedes any target database command or marker mutation', async t => {
  const runtime = fixture(t), calls = [];
  await assert.rejects(restore(runtime, {}, { decrypt: async () => { throw new Error('bad authentication'); }, run: async () => calls.push('command'), marker: () => calls.push('marker') }));
  assert.deepEqual(calls, []);
});
test('restore installs only after decryption and finishes stopped/sealed without server/Redis execution', async t => {
  const runtime = fixture(t), calls = [];
  const result = await restore(runtime, { work: 'mock' }, {
    decrypt: async () => { calls.push('authenticated'); return { archiveHash: 'a'.repeat(64), manifest: { checkpoint: 'checkpoint' } }; },
    marker: (_, value) => calls.push(value), run: async args => calls.push(args.join(' ')),
    restoreDb: async () => calls.push('restore-db'), copy: async () => calls.push('copy'),
  });
  assert.deepEqual(calls, ['authenticated', 'restore-in-progress', 'up --detach --pull never --wait --wait-timeout 120 postgres', 'restore-db', 'copy', 'copy', 'restored-sealed', 'stop --timeout 30 postgres']);
  assert.equal(result.trafficOpened, false); assert.equal(result.currentAuthorityReconciled, false);
});
test('unknown database restore leaves in-progress seal and stops PostgreSQL, with no replay', async t => {
  const runtime = fixture(t), calls = [];
  await assert.rejects(restore(runtime, { work: 'mock' }, {
    decrypt: async () => ({ archiveHash: 'a'.repeat(64), manifest: {} }), marker: (_, state) => calls.push(state),
    run: async args => calls.push(args.join(' ')), restoreDb: async () => { throw new Error('unknown'); }, copy: async () => calls.push('copy'),
  }));
  assert.equal(calls[0], 'restore-in-progress'); assert.equal(calls.at(-1), 'stop --timeout 30 postgres');
  assert.ok(!calls.includes('copy')); assert.ok(!calls.includes('restored-sealed'));
});
