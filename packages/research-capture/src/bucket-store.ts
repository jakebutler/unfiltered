import { digest, validObjectKey, type PrivateObjectStore, type StoredObject } from './contracts';

/** Narrow port for R2 bindings or an AWS S3 SDK wrapper. Conditional writes MUST be
 * atomic at the bucket. R2: onlyIf.etagDoesNotMatch='*'; S3: IfNoneMatch='*'.
 * A normal overwrite is used ONLY for the zero-byte retirement marker. */
export interface PrivateBucketPort {
  put(key: string, body: Uint8Array, options: { ifAbsent: boolean; metadata: Record<string, string>; contentType: string }): Promise<'stored' | 'exists'>;
  head(key: string): Promise<{ bytes: number; metadata: Record<string, string>; contentType: string } | null>;
  get(key: string, range: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null>;
}
export class BucketPrivateObjectStore implements PrivateObjectStore {
  constructor(private readonly bucket: PrivateBucketPort) {}
  async putIfAbsent(key: string, body: Uint8Array, metadata: StoredObject) {
    validObjectKey(key);
    if (body.byteLength !== metadata.bytes || await digest(body) !== metadata.sha256) throw new Error('Invalid object');
    await this.bucket.put(key, body, { ifAbsent: true, metadata: { sha256: metadata.sha256, state: 'available' }, contentType: metadata.mime });
    const actual = await this.head(key);
    if (!actual || actual.bytes !== metadata.bytes || actual.sha256 !== metadata.sha256 || actual.mime !== metadata.mime) throw new Error('Object write requires reconciliation');
    return actual;
  }
  async head(key: string): Promise<StoredObject | null> {
    validObjectKey(key); const object = await this.bucket.head(key);
    if (!object || object.metadata.state === 'retired') return null;
    if (object.metadata.state !== 'available' || !/^[a-f0-9]{64}$/.test(object.metadata.sha256)) throw new Error('Unknown object metadata');
    return { bytes: object.bytes, sha256: object.metadata.sha256, mime: object.contentType };
  }
  async read(key: string, range: { start: number; end: number }) {
    validObjectKey(key); const body = await this.bucket.get(key, range); if (!body) throw new Error('Object unavailable'); return body;
  }
  async retire(key: string) {
    validObjectKey(key);
    await this.bucket.put(key, new Uint8Array(), { ifAbsent: false, metadata: { state: 'retired' }, contentType: 'application/octet-stream' });
    const result = await this.bucket.head(key);
    if (!result || result.bytes !== 0 || result.metadata.state !== 'retired') throw new Error('Retirement marker not confirmed');
  }
}
