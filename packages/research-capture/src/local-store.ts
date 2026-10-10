import { mkdir, readFile, writeFile, link, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CAPTURE_LIMITS, digest, validObjectKey, type PrivateObjectStore, type StoredObject } from './contracts';

/** Local qualification only. The directory is private and must never be static-hosted. */
export class LocalPrivateObjectStore implements PrivateObjectStore {
  constructor(private readonly directory: string) {}
  private path(key: string) { validObjectKey(key); return join(this.directory, key.replaceAll('/', '_')); }
  private async unpack(key: string): Promise<{ metadata: StoredObject | null; body: Uint8Array } | null> {
    let bytes: Buffer;
    try { bytes = await readFile(this.path(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const split = bytes.indexOf(10);
    if (split < 0 || split > 1024) throw new Error('Invalid object envelope');
    const metadata = JSON.parse(bytes.subarray(0, split).toString('utf8')) as StoredObject | null, body = bytes.subarray(split + 1);
    if (metadata && (metadata.bytes !== body.byteLength || await digest(body) !== metadata.sha256)) throw new Error('Object failed integrity check');
    return { metadata, body };
  }
  async putIfAbsent(key: string, body: Uint8Array, metadata: StoredObject): Promise<StoredObject> {
    if (body.byteLength !== metadata.bytes || body.byteLength > CAPTURE_LIMITS.segmentBytes || await digest(body) !== metadata.sha256) throw new Error('Invalid object');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.pending-${key.replaceAll('/', '_')}`);
    try {
      await writeFile(temporary, Buffer.concat([Buffer.from(JSON.stringify(metadata) + '\n'), body]), { mode: 0o600, flag: 'wx' });
      try { await link(temporary, this.path(key)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const prior = await this.head(key);
        if (!prior || prior.sha256 !== metadata.sha256 || prior.bytes !== metadata.bytes || prior.mime !== metadata.mime) throw new Error('Object key is already used or retired');
      }
    } finally { await unlink(temporary).catch(() => undefined); }
    return metadata;
  }
  async head(key: string) { return (await this.unpack(key))?.metadata ?? null; }
  async read(key: string, range: { start: number; end: number }) {
    const object = await this.unpack(key);
    if (!object?.metadata) throw new Error('Object unavailable');
    const bytes = object.body.slice(range.start, range.end + 1);
    return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }
  async retire(key: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.retiring-${randomUUID()}`);
    try { await writeFile(temporary, 'null\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path(key)); await unlink(join(this.directory, `.pending-${key.replaceAll('/', '_')}`)).catch(() => undefined); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
}
