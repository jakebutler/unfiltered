import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync, openSync, ftruncateSync, closeSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { copySafeTree } from '../medplum/runtime.mjs';
import { encryptArchive, decryptArchive, inventory } from '../medplum/archive.mjs';

const metadata = { profileHash: 'a'.repeat(64), stackId: 'clinic-a', checkpoint: '2026-10-10T00:00:00.000Z', images: { postgres: 'pinned' } };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uf-medplum-archive-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); mkdirSync(source, { mode: 0o700 });
  for (const name of ['binary', 'redis']) mkdirSync(join(source, name), { mode: 0o700 });
  writeFileSync(join(source, 'database.dump'), 'synthetic database', { mode: 0o600 });
  writeFileSync(join(source, 'binary/fixture'), Buffer.alloc(65537, 7), { mode: 0o600 });
  writeFileSync(join(source, 'redis/dump.rdb'), 'synthetic redis', { mode: 0o600 });
  return { root, source, archive: join(root, 'backup.enc'), key: randomBytes(32), target: join(root, 'restored') };
}
test('single envelope preserves complete bytes and removes authenticated scratch', async t => {
  const f = fixture(t), encrypted = await encryptArchive(f.source, f.archive, f.key, metadata);
  const decoded = await decryptArchive(f.archive, f.target, f.key, { profileHash: metadata.profileHash, images: metadata.images });
  assert.equal(decoded.archiveHash, encrypted.archiveHash);
  for (const path of ['database.dump', 'binary/fixture', 'redis/dump.rdb']) assert.deepEqual(readFileSync(join(f.source, path)), readFileSync(join(f.target, path)));
  assert.ok(!readdirSync(f.target).includes('.authenticated.tmp'));
  assert.equal(decoded.manifest.traffic, 'sealed'); assert.equal(decoded.manifest.postCheckpointAuthority, 'reconciliation-required');
});
for (const which of ['wrong-key', 'ciphertext', 'tag', 'nonce']) test(`${which} fails authentication before any recovered file and cleans scratch`, async t => {
  const f = fixture(t); await encryptArchive(f.source, f.archive, f.key, metadata);
  let key = f.key;
  if (which === 'wrong-key') key = randomBytes(32);
  else { const data = readFileSync(f.archive); data[which === 'tag' ? data.length - 1 : which === 'nonce' ? 10 : 30] ^= 1; writeFileSync(f.archive, data); }
  await assert.rejects(decryptArchive(f.archive, f.target, key, { profileHash: metadata.profileHash }));
  assert.deepEqual(readdirSync(f.target), []);
});
test('cross-clinic identity rejects after authentication before recovered-file creation', async t => {
  const f = fixture(t); await encryptArchive(f.source, f.archive, f.key, metadata);
  await assert.rejects(decryptArchive(f.archive, f.target, f.key, { profileHash: 'b'.repeat(64) }), /restore-identity-mismatch/);
  assert.deepEqual(readdirSync(f.target), []);
});
test('existing output and restore destination are immutable', async t => {
  const f = fixture(t); await encryptArchive(f.source, f.archive, f.key, metadata); const original = readFileSync(f.archive);
  await assert.rejects(encryptArchive(f.source, f.archive, f.key, metadata)); assert.deepEqual(readFileSync(f.archive), original);
  mkdirSync(f.target, { mode: 0o700 }); writeFileSync(join(f.target, 'preserve'), 'owned elsewhere');
  await assert.rejects(decryptArchive(f.archive, f.target, f.key, {})); assert.equal(readFileSync(join(f.target, 'preserve'), 'utf8'), 'owned elsewhere');
});
test('symlink and oversized sparse source fail before plaintext encryption', async t => {
  const f = fixture(t); symlinkSync(join(f.root, 'outside'), join(f.source, 'binary/link')); await assert.rejects(inventory(f.source));
  rmSync(join(f.source, 'binary/link')); const fd = openSync(join(f.source, 'binary/oversized'), 'w', 0o600); ftruncateSync(fd, 67108865); closeSync(fd);
  await assert.rejects(inventory(f.source), /archive-bound-exceeded/);
});
test('source growth after inventory cannot exceed the encrypted byte bound', async t => {
  const f = fixture(t);
  const mutation = { toJSON() { appendFileSync(join(f.source, 'binary/fixture'), 'extra'); return 'test-only mutation'; } };
  await assert.rejects(encryptArchive(f.source, f.archive, f.key, { ...metadata, mutation }), /backup-source-grew/);
});
function forge(f, manifest, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', f.key, nonce);
  writeFileSync(f.archive, Buffer.concat([Buffer.from('UFMP002\n'), nonce, cipher.update(Buffer.concat([length, json, payload])), cipher.final(), cipher.getAuthTag()]), { mode: 0o600 });
}
const entry = (path, bytes = Buffer.alloc(0)) => ({ path, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), mode: 0o600, uid: 0, gid: 0 });
for (const path of ['binary/../../outside', 'redis/../database.dump', '/absolute', 'binary/./ambiguous']) test(`authenticated invalid path ${path} cannot install`, async t => {
  const f = fixture(t); forge(f, { ...metadata, schema: 2, directories: ['binary', 'redis'], traffic: 'sealed', postCheckpointAuthority: 'reconciliation-required', files: [entry('database.dump'), entry(path)] });
  await assert.rejects(decryptArchive(f.archive, f.target, f.key, {})); assert.deepEqual(readdirSync(f.target), []);
});
test('authenticated checksum/trailing-byte defects never become a successful restore', async t => {
  const f = fixture(t), data = Buffer.from('x');
  forge(f, { ...metadata, schema: 2, directories: ['binary', 'redis'], traffic: 'sealed', postCheckpointAuthority: 'reconciliation-required', files: [entry('database.dump'), { ...entry('redis/dump.rdb', data), hash: '0'.repeat(64) }] }, data);
  await assert.rejects(decryptArchive(f.archive, f.target, f.key, {}), /restore-hash-mismatch/);
  assert.ok(!readdirSync(f.target).includes('.authenticated.tmp'));
  rmSync(f.target, { recursive: true });
  forge(f, { ...metadata, schema: 2, directories: ['binary', 'redis'], traffic: 'sealed', postCheckpointAuthority: 'reconciliation-required', files: [entry('database.dump'), entry('redis/dump.rdb')] }, data);
  await assert.rejects(decryptArchive(f.archive, f.target, f.key, {}), /archive-trailing-bytes/);
});

test('authenticated empty Binary, Redis and nested trees retain explicit directory inventory', async t => {
  const f = fixture(t);
  rmSync(join(f.source, 'binary/fixture')); rmSync(join(f.source, 'redis/dump.rdb'));
  mkdirSync(join(f.source, 'binary/empty/nested'), { recursive: true, mode: 0o700 });
  mkdirSync(join(f.source, 'redis/empty'), { mode: 0o700 });
  const encrypted = await encryptArchive(f.source, f.archive, f.key, metadata);
  assert.equal(encrypted.manifest.schema, 2);
  assert.deepEqual(encrypted.manifest.directories, ['binary', 'binary/empty', 'binary/empty/nested', 'redis', 'redis/empty']);
  const decoded = await decryptArchive(f.archive, f.target, f.key, metadata);
  assert.deepEqual(decoded.manifest.directories, encrypted.manifest.directories);
  for (const path of ['binary/empty/nested', 'redis/empty']) assert.deepEqual(readdirSync(join(f.target, path)), []);
  assert.equal(readFileSync(join(f.target, 'database.dump'), 'utf8'), 'synthetic database');
});
for (const path of ['database.dump', 'binary', 'redis']) test(`missing required source ${path} is not an empty tree`, async t => {
  const f = fixture(t); rmSync(join(f.source, path), { recursive: true });
  await assert.rejects(encryptArchive(f.source, f.archive, f.key, metadata));
  assert.ok(!readdirSync(f.root).includes('backup.enc'));
});
const validHeader = () => ({ ...metadata, schema: 2, directories: ['binary', 'redis'], traffic: 'sealed', postCheckpointAuthority: 'reconciliation-required', files: [entry('database.dump')] });
for (const [name, mutate] of [
  ['legacy manifest', m => { m.schema = 1; delete m.directories; }],
  ['missing Binary root', m => { m.directories = ['redis']; }],
  ['missing database', m => { m.files = [entry('binary/fixture')]; }],
  ['duplicate directory', m => { m.directories.push('binary'); }],
  ['file-directory conflict', m => { m.directories.push('binary/fixture'); m.files.push(entry('binary/fixture')); }],
  ['missing directory parent', m => { m.directories.push('binary/missing/nested'); }],
  ['undeclared file parent', m => { m.files.push(entry('redis/missing/file')); }],
  ['unsafe directory', m => { m.directories.push('binary/../outside'); }],
  ['aggregate entry bound', m => { for (let i = 0; i < 4094; i++) m.directories.push(`binary/empty-${i}`); }],
]) test(`authenticated ${name} cannot recover files or empty directories`, async t => {
  const f = fixture(t), header = validHeader(); mutate(header); forge(f, header);
  await assert.rejects(decryptArchive(f.archive, f.target, f.key, {}));
  assert.deepEqual(readdirSync(f.target), []);
});
test('historical v1 envelope is explicitly rejected', async t => {
  const f = fixture(t); forge(f, validHeader());
  const bytes = readFileSync(f.archive); Buffer.from('UFMP001\n').copy(bytes); writeFileSync(f.archive, bytes);
  await assert.rejects(decryptArchive(f.archive, f.target, f.key, {}), /archive-format-invalid/);
  assert.deepEqual(readdirSync(f.target), []);
});

test('tree copy preserves guarded empty root, nonempty bytes and nested empty dirs without overwriting', async t => {
  const f = fixture(t); mkdirSync(join(f.source, 'binary/empty'), { mode: 0o700 });
  mkdirSync(f.target, { mode: 0o700 });
  await copySafeTree(join(f.source, 'binary'), f.target, process.getuid?.());
  assert.deepEqual(readFileSync(join(f.target, 'fixture')), readFileSync(join(f.source, 'binary/fixture')));
  assert.deepEqual(readdirSync(join(f.target, 'empty')), []);
  await assert.rejects(copySafeTree(join(f.source, 'binary'), f.target, process.getuid?.()), /empty-tree-target-required/);
  assert.deepEqual(readFileSync(join(f.target, 'fixture')), readFileSync(join(f.source, 'binary/fixture')));
});
