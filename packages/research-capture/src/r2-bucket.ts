import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, type S3ClientConfig, type HeadObjectOutput, type GetObjectOutput } from '@aws-sdk/client-s3';
import { validObjectKey } from './contracts';
import type { PrivateBucketPort } from './bucket-store';

export type R2PrivateBucketConfig = Readonly<{ accountId: '728ae4b71b42dfcef062336c06bd8595'; bucket: 'unfiltered-recordings'; namespace: string; deadlineMs: number; maxObjectBytes: number }>;
export type R2CredentialProvider = () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
const failure = () => new Error('Private R2 operation requires reconciliation');
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const mimeTypes = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4']);
const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const named = (e: unknown, name: string, code: number) => (e as { name?: string })?.name === name && status(e) === code;
type Row = { bytes: number; metadata: Record<string, string>; contentType: string; etag: string; retired: boolean };

/** Node-only, explicit injection. Construction performs no I/O. No public URLs,
 * ambient credentials, bucket administration, DELETE, multipart or retry. */
export class R2PrivateBucketPort implements PrivateBucketPort {
  private constructor(private readonly config: R2PrivateBucketConfig, private readonly client: S3Client) {}
  static create(input: R2PrivateBucketConfig, credentials: R2CredentialProvider, requestHandler?: S3ClientConfig['requestHandler']) {
    const config = { ...input };
    if (Object.keys(config).length !== 5 || config.accountId !== '728ae4b71b42dfcef062336c06bd8595' || config.bucket !== 'unfiltered-recordings' || !/^[a-z][a-z0-9-]{2,62}$/.test(config.namespace) || !Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 15000 || !Number.isSafeInteger(config.maxObjectBytes) || config.maxObjectBytes < 1 || config.maxObjectBytes > 4000000 || typeof credentials !== 'function') throw failure();
    const explicitCredentials = async () => {
      try {
        const value = await credentials();
        if (!value || ![value.accessKeyId, value.secretAccessKey].every(s => typeof s === 'string' && s.length > 0 && s.length <= 256) || value.sessionToken !== undefined && (typeof value.sessionToken !== 'string' || value.sessionToken.length < 1 || value.sessionToken.length > 4096)) throw failure();
        return { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey, ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}) };
      } catch { throw failure(); }
    };
    const client = new S3Client({ region: 'auto', endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`, forcePathStyle: true, credentials: explicitCredentials, maxAttempts: 1, followRegionRedirects: false, useFipsEndpoint: false, useDualstackEndpoint: false, useAccelerateEndpoint: false, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', requestHandler: requestHandler ?? { connectionTimeout: Math.min(3000, config.deadlineMs), requestTimeout: config.deadlineMs } });
    return new R2PrivateBucketPort(Object.freeze(config), client);
  }
  close() { this.client.destroy(); }
  private key(key: string) { validObjectKey(key); const physical = `${this.config.namespace}/${key}`; if (Buffer.byteLength(physical) > 1024) throw failure(); return physical; }
  private deadline() { return Date.now() + this.config.deadlineMs; }
  private async call(command: PutObjectCommand | HeadObjectCommand | GetObjectCommand, until: number, controller = new AbortController()): Promise<any> {
    const remaining = until - Date.now(); if (remaining <= 0) throw failure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = this.client.send(command as any, { abortSignal: controller.signal }) as Promise<any>;
    // A transport that resolves after abort still owns its response body.
    void request.then(r => { if (controller.signal.aborted && r.Body instanceof Readable) r.Body.destroy(); }, () => undefined);
    try { return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, remaining); })]); }
    finally { clearTimeout(timer); }
  }
  private metadata(row: HeadObjectOutput): Row {
    const metadata = row.Metadata ?? {}, retired = metadata.state === 'retired';
    if (row.VersionId !== undefined || row.DeleteMarker || row.ContentEncoding || row.WebsiteRedirectLocation || row.MissingMeta || typeof row.ETag !== 'string' || !/^"[\x21\x23-\x7e]{1,126}"$/.test(row.ETag)) throw failure();
    if (retired) {
      if (Object.keys(metadata).length !== 1 || row.ContentLength !== 0 || row.ContentType !== 'application/octet-stream') throw failure();
    } else if (Object.keys(metadata).length !== 2 || metadata.state !== 'available' || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '') || !Number.isSafeInteger(row.ContentLength) || row.ContentLength! < 1 || row.ContentLength! > this.config.maxObjectBytes || !mimeTypes.has(row.ContentType ?? '')) throw failure();
    return { bytes: row.ContentLength!, metadata: { ...metadata }, contentType: row.ContentType!, etag: row.ETag, retired };
  }
  private async inspect(key: string, until: number): Promise<Row | null> {
    const physical = this.key(key);
    try {
      const result = await this.call(new HeadObjectCommand({ Bucket: this.config.bucket, Key: physical }), until);
      if (status(result) !== 200) throw failure();
      return this.metadata(result);
    } catch (e) {
      // HEAD's generic NotFound/404 does NOT prove object absence. A bounded
      // one-byte GET lets the SDK classify the XML error; never serve its body.
      if (named(e, 'NoSuchKey', 404)) return null;
      if (named(e, 'NotFound', 404)) {
        try {
          const probe = await this.call(new GetObjectCommand({ Bucket: this.config.bucket, Key: physical, Range: 'bytes=0-0' }), until);
          if (probe.Body instanceof Readable) probe.Body.destroy();
        } catch (probeError) { if (named(probeError, 'NoSuchKey', 404)) return null; }
      }
      throw failure();
    }
  }
  async head(key: string) { const row = await this.inspect(key, this.deadline()); return row && { bytes: row.bytes, metadata: row.metadata, contentType: row.contentType }; }
  async put(key: string, input: Uint8Array, options: { ifAbsent: boolean; metadata: Record<string, string>; contentType: string }): Promise<'stored' | 'exists'> {
    const physical = this.key(key);
    if (!(input instanceof Uint8Array) || input.byteLength > this.config.maxObjectBytes) throw failure();
    const body = Uint8Array.from(input), metadata = { ...options.metadata }, retired = !options.ifAbsent;
    if (typeof options.ifAbsent !== 'boolean' || (retired ? body.byteLength !== 0 || options.contentType !== 'application/octet-stream' || metadata.state !== 'retired' || Object.keys(metadata).length !== 1 : body.byteLength < 1 || metadata.state !== 'available' || metadata.sha256 !== hash(body) || Object.keys(metadata).length !== 2 || !mimeTypes.has(options.contentType))) throw failure();
    try {
      const result = await this.call(new PutObjectCommand({ Bucket: this.config.bucket, Key: physical, Body: body, ContentLength: body.byteLength, ContentType: options.contentType, Metadata: metadata, IfNoneMatch: options.ifAbsent ? '*' : undefined }), this.deadline());
      // R2 may acknowledge an upload with an opaque identifier. It is never a
      // read selector or proof of historical versioning; the store still needs
      // exact HEAD verification before availability or retirement succeeds.
      const version = result.VersionId;
      if (status(result) !== 200 || version !== undefined && (typeof version !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(version))) throw failure();
      return 'stored';
    } catch (e) { if (options.ifAbsent && named(e, 'PreconditionFailed', 412)) return 'exists'; throw failure(); }
  }
  async get(key: string, range: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null> {
    range = { ...range }; // Pin the admitted bounds across the awaited HEAD.
    const until = this.deadline();
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end - range.start + 1 > this.config.maxObjectBytes) throw failure();
    const row = await this.inspect(key, until); if (!row || row.retired) return null;
    if (range.end >= row.bytes) throw failure();
    const controller = new AbortController();
    let response: GetObjectOutput;
    try { response = await this.call(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(key), Range: `bytes=${range.start}-${range.end}`, IfMatch: row.etag }), until, controller); }
    catch { controller.abort(); throw failure(); }
    const body = response.Body, length = range.end - range.start + 1;
    if (!(body instanceof Readable)) { controller.abort(); throw failure(); }
    try {
      // Metadata validates the full object; ContentLength describes this range.
      const actual = this.metadata({ ...response, ContentLength: row.bytes });
      if (status(response) !== 206 || response.ContentLength !== length || response.ContentRange !== `bytes ${range.start}-${range.end}/${row.bytes}` || actual.etag !== row.etag || actual.retired || actual.metadata.sha256 !== row.metadata.sha256 || actual.contentType !== row.contentType || until <= Date.now()) throw failure();
    } catch { controller.abort(); body.destroy(); throw failure(); }
    const reader = (Readable.toWeb(body, { strategy: { highWaterMark: 256000, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>).getReader();
    let received = 0, pending: Uint8Array | undefined, ended = false;
    const fullHash = range.start === 0 && range.end === row.bytes - 1 ? createHash('sha256') : undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const stop = () => { if (ended) return; ended = true; clearTimeout(timer); controller.abort(); body.destroy(); void reader.cancel().catch(() => undefined); };
    const timer = setTimeout(() => { stop(); streamController.error(failure()); }, Math.max(1, until - Date.now()));
    return new ReadableStream<Uint8Array>({
      start(c) { streamController = c; },
      async pull(c) {
        try {
          if (ended) return;
          // SDK transport chunks can be much smaller than an authorized media
          // block. Coalesce within the existing 256KB bound so each network
          // fragment does not trigger another complete authorization roundtrip.
          const chunk = new Uint8Array(256000); let filled = 0;
          while (filled < chunk.byteLength) {
            if (!pending?.byteLength) {
              const next = await reader.read(); if (ended) return;
              if (next.done) {
                if (received !== length || fullHash && fullHash.digest('hex') !== row.metadata.sha256) throw failure();
                stop(); if (filled) c.enqueue(chunk.subarray(0, filled)); c.close(); return;
              }
              if (!(next.value instanceof Uint8Array) || next.value.byteLength > length - received) throw failure();
              received += next.value.byteLength; fullHash?.update(next.value); pending = next.value;
            }
            const take = Math.min(pending.byteLength, chunk.byteLength - filled);
            chunk.set(pending.subarray(0, take), filled); filled += take; pending = pending.subarray(take);
          }
          c.enqueue(chunk);
        } catch { stop(); c.error(failure()); }
      }, cancel() { stop(); },
    }, { highWaterMark: 0 });
  }
}
