import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { open, stat, lstat, realpath, readdir, mkdir, chown, chmod, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('UFMP002\n'), MAX = 67108864, HEADER_MAX = 1048576, COUNT_MAX = 4096;
const hash = value => createHash('sha256').update(value).digest('hex');
const safeName = name => /^(?:database\.dump|(?:binary|redis)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)$/.test(name) && !name.split('/').some(p => p === '.' || p === '..');

const safeDirectory = name => /^(?:binary|redis)(?:\/[A-Za-z0-9._-]+)*$/.test(name) && !name.split('/').some(p => p === '.' || p === '..');

async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== resolve(path) || ![0o400, 0o600, 0o640, 0o644].includes(info.mode & 0o777)) throw new Error('archive-regular-file-required');
  return info;
}
export async function inventory(root) {
  const files = [], directories = []; let bytes = 0;
  async function walk(path, relative) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('archive-symlink-denied');
    if (info.isDirectory()) {
      if (!safeDirectory(relative)) throw new Error('archive-directory-denied');
      if (files.length + directories.length >= COUNT_MAX) throw new Error('archive-bound-exceeded');
      directories.push(relative);
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`);
      return;
    }
    if (!safeName(relative)) throw new Error('archive-path-denied');
    const file = await regular(path);
    bytes += file.size;
    if (bytes > MAX || files.length + directories.length >= COUNT_MAX) throw new Error('archive-bound-exceeded');
    const digest = createHash('sha256'); for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) digest.update(chunk);
    files.push({ path: relative, size: file.size, hash: digest.digest('hex'), mode: file.mode & 0o777, uid: file.uid, gid: file.gid });
  }
  for (const name of ['database.dump', 'binary', 'redis']) await walk(join(root, name), name);
  if (!files.some(file => file.path === 'database.dump') || !directories.includes('binary') || !directories.includes('redis')) throw new Error('archive-state-incomplete');
  return { files, directories };
}
function checkedHeader(value) {
  if (!value || value.schema !== 2 || !/^[a-f0-9]{64}$/.test(value.profileHash) || !Array.isArray(value.files) || value.files.length < 1 || !Array.isArray(value.directories) || value.files.length + value.directories.length > COUNT_MAX || value.postCheckpointAuthority !== 'reconciliation-required' || value.traffic !== 'sealed') throw new Error('archive-manifest-invalid');
  let bytes = 0; const seen = new Set(), directories = new Set();
  for (const path of value.directories) {
    if (typeof path !== 'string' || !safeDirectory(path) || directories.has(path)) throw new Error('archive-directory-invalid');
    directories.add(path);
  }
  if (!directories.has('binary') || !directories.has('redis')) throw new Error('archive-state-incomplete');
  for (const path of directories) if (path.includes('/') && !directories.has(dirname(path))) throw new Error('archive-directory-parent-missing');
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || !safeName(file.path) || seen.has(file.path) || directories.has(file.path) || (file.path !== 'database.dump' && !directories.has(dirname(file.path))) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.hash) || ![0o400, 0o600, 0o640, 0o644].includes(file.mode) || !Number.isSafeInteger(file.uid) || file.uid < 0 || !Number.isSafeInteger(file.gid) || file.gid < 0) throw new Error('archive-entry-invalid');
    seen.add(file.path); bytes += file.size;
  }
  if (bytes > MAX || !seen.has('database.dump')) throw new Error('archive-bound-or-state-invalid');
  return value;
}
export async function encryptArchive(root, output, key, metadata) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('archive-key-invalid');
  const { files, directories } = await inventory(root), manifest = checkedHeader({ ...metadata, schema: 2, files, directories, traffic: 'sealed', postCheckpointAuthority: 'reconciliation-required' });
  const encoded = Buffer.from(JSON.stringify(manifest)); if (encoded.length > HEADER_MAX) throw new Error('archive-manifest-bound');
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(encoded.length);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const destination = createWriteStream(output, { flags: 'wx', mode: 0o600 });
  destination.write(Buffer.concat([MAGIC, iv]));
  async function* source() {
    yield prefix; yield encoded;
    for (const file of files) {
      const path = join(root, file.path); await regular(path);
      const digest = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) {
        size += chunk.length; if (size > file.size) throw new Error('backup-source-grew');
        digest.update(chunk); yield chunk;
      }
      if (size !== file.size || digest.digest('hex') !== file.hash) throw new Error('backup-source-changed');
    }
  }
  await pipeline(source(), cipher, destination, { end: false });
  await new Promise((resolve, reject) => { destination.once('error', reject); destination.end(cipher.getAuthTag(), resolve); });
  return { manifest, archiveHash: await fileHash(output) };
}
export async function fileHash(path) {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) digest.update(chunk); return digest.digest('hex');
}

/** Authenticate the complete encrypted archive before creating any restored file. */
export async function decryptArchive(input, target, key, expected) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('archive-key-invalid');
  const sourceInfo = await regular(input);
  if (sourceInfo.size < 40 || sourceInfo.size > MAX + HEADER_MAX + 40) throw new Error('archive-input-bound');
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077 || await realpath(dirname(target)) !== resolve(dirname(target))) throw new Error('private-restore-parent-required');
  await mkdir(target, { mode: 0o700 }); // Existing targets fail, including empty directories and symlinks.
  const scratch = join(target, '.authenticated.tmp'), source = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  const head = Buffer.alloc(20), tag = Buffer.alloc(16);
  await source.read(head, 0, 20, 0); await source.read(tag, 0, 16, sourceInfo.size - 16); await source.close();
  if (!head.subarray(0, 8).equals(MAGIC)) throw new Error('archive-format-invalid');
  const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(8)); decipher.setAuthTag(tag);
  try { await pipeline(createReadStream(input, { start: 20, end: sourceInfo.size - 17, highWaterMark: 65536 }), decipher, createWriteStream(scratch, { flags: 'wx', mode: 0o600 })); }
  catch (error) { await unlink(scratch).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; }); throw error; }
  const plain = await open(scratch, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const length = Buffer.alloc(4); if ((await plain.read(length, 0, 4, 0)).bytesRead !== 4) throw new Error('archive-truncated');
    const n = length.readUInt32BE(); if (n < 2 || n > HEADER_MAX) throw new Error('archive-manifest-bound');
    const encoded = Buffer.alloc(n); if ((await plain.read(encoded, 0, n, 4)).bytesRead !== n) throw new Error('archive-truncated');
    const manifest = checkedHeader(JSON.parse(encoded.toString()));
    for (const [key, value] of Object.entries(expected)) if (JSON.stringify(manifest[key]) !== JSON.stringify(value)) throw new Error('restore-identity-mismatch');
    let position = 4 + n;
    for (const file of manifest.files) {
      const path = join(target, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const digest = createHash('sha256'); let remaining = file.size;
      try {
        while (remaining) {
          const chunk = Buffer.alloc(Math.min(65536, remaining)), result = await plain.read(chunk, 0, chunk.length, position);
          if (result.bytesRead !== chunk.length) throw new Error('archive-truncated');
          digest.update(chunk); await output.write(chunk); position += chunk.length; remaining -= chunk.length;
        }
        if (digest.digest('hex') !== file.hash) throw new Error('restore-hash-mismatch');
      } finally { await output.close(); }
      await chmod(path, file.mode);
      // Never accept arbitrary archive ownership even after authentication.
      const uid = file.path.startsWith('binary/') ? 1000 : file.path.startsWith('redis/') ? 999 : process.getuid?.();
      if (process.getuid?.() === 0) await chown(path, uid, uid);
    }
    if (position !== (await stat(scratch)).size) throw new Error('archive-trailing-bytes');
    // Explicit empty trees are reconstructed only after authenticated bytes and hashes validate.
    for (const directory of [...manifest.directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
      const path = join(target, directory); await mkdir(path, { recursive: true, mode: 0o700 });
      if (process.getuid?.() === 0) { const uid = directory === 'binary' || directory.startsWith('binary/') ? 1000 : 999; await chown(path, uid, uid); }
    }
    return { manifest, archiveHash: await fileHash(input) };
  } finally { await plain.close(); await unlink(scratch); }
}
