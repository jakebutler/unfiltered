import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, GetBucketVersioningCommand, GetBucketLifecycleConfigurationCommand, GetBucketReplicationCommand, GetObjectLockConfigurationCommand, GetBucketEncryptionCommand, GetPublicAccessBlockCommand, GetBucketOwnershipControlsCommand, type S3ClientConfig, type HeadObjectOutput, type GetObjectOutput } from '@aws-sdk/client-s3';
import { CAPTURE_LIMITS, validObjectKey } from './contracts';
import type { PrivateBucketPort } from './bucket-store';

export type S3PrivateBucketConfig = { bucket: string; region: string; accountId: string; namespace: string; kmsKeyArn: string; deadlineMs?: number };
export type S3CredentialProvider = () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest();
const mimeTypes = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4']);
const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const named = (e: unknown, name: string) => (e as { name?: string })?.name === name && status(e) === 404;
const failure = () => new Error('Private object operation requires reconciliation');

/** Node-only port. No public URL, DeleteObject, multipart, endpoint override or ambient credentials. */
export class S3PrivateBucketPort implements PrivateBucketPort {
  private constructor(private readonly config: S3PrivateBucketConfig, private readonly client: S3Client) {}
  static async open(input: S3PrivateBucketConfig, credentials: S3CredentialProvider, requestHandler?: S3ClientConfig['requestHandler']) {
    const config = { ...input, deadlineMs: input.deadlineMs ?? 15000 };
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) || !/^[a-z]{2}-[a-z]+-[1-9]$/.test(config.region) || !/^\d{12}$/.test(config.accountId) || !/^[a-z][a-z0-9-]{2,62}$/.test(config.namespace) || !new RegExp(`^arn:aws:kms:${config.region}:${config.accountId}:key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(config.kmsKeyArn) || !Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 15000 || typeof credentials !== 'function') throw failure();
    // Explicit trusted endpoint wins over AWS_ENDPOINT_URL[_S3] environment/profile overrides.
    const client = new S3Client({ region: config.region, endpoint: `https://s3.${config.region}.amazonaws.com`, credentials, maxAttempts: 1, followRegionRedirects: false, useFipsEndpoint: false, useDualstackEndpoint: false, useAccelerateEndpoint: false, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', requestHandler: requestHandler ?? { connectionTimeout: 3000, requestTimeout: config.deadlineMs } });
    const port = new S3PrivateBucketPort(Object.freeze(config), client);
    try { await port.qualify(); return port; } catch { client.destroy(); throw failure(); }
  }
  close() { this.client.destroy(); }
  private key(key: string) { validObjectKey(key); return `${this.config.namespace}/${key}`; }
  private get scope() { return { Bucket: this.config.bucket, ExpectedBucketOwner: this.config.accountId }; }
  private async call(command: any, controller = new AbortController()): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = this.client.send(command, { abortSignal: controller.signal });
    // A late SDK response after timeout still owns a socket/body; do not leave it unread.
    void request.then((r: any) => { if (controller.signal.aborted && r.Body instanceof Readable) r.Body.destroy(); }, () => undefined);
    try { return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, this.config.deadlineMs); })]); }
    finally { clearTimeout(timer); }
  }
  private async qualify() {
    const version = await this.call(new GetBucketVersioningCommand(this.scope));
    if (version.Status !== undefined || version.MFADelete !== undefined) throw failure();
    for (const [command, absent] of [[new GetBucketLifecycleConfigurationCommand(this.scope), 'NoSuchLifecycleConfiguration'], [new GetBucketReplicationCommand(this.scope), 'ReplicationConfigurationNotFoundError'], [new GetObjectLockConfigurationCommand(this.scope), 'ObjectLockConfigurationNotFoundError']] as const) {
      try { await this.call(command); throw failure(); } catch (e) { if (!named(e, absent)) throw failure(); }
    }
    const encrypted = await this.call(new GetBucketEncryptionCommand(this.scope)), rules = encrypted.ServerSideEncryptionConfiguration?.Rules;
    if (rules?.length !== 1 || rules[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== 'aws:kms' || rules[0].ApplyServerSideEncryptionByDefault?.KMSMasterKeyID !== this.config.kmsKeyArn || rules[0].BucketKeyEnabled !== false) throw failure();
    const blocked = (await this.call(new GetPublicAccessBlockCommand(this.scope))).PublicAccessBlockConfiguration;
    if (!blocked || ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].some(key => blocked[key] !== true)) throw failure();
    const ownership = (await this.call(new GetBucketOwnershipControlsCommand(this.scope))).OwnershipControls?.Rules;
    if (ownership?.length !== 1 || ownership[0].ObjectOwnership !== 'BucketOwnerEnforced') throw failure();
  }
  private metadata(row: HeadObjectOutput) {
    const metadata = row.Metadata ?? {}, retired = metadata.state === 'retired';
    if (row.ServerSideEncryption !== 'aws:kms' || row.SSEKMSKeyId !== this.config.kmsKeyArn || row.BucketKeyEnabled !== false || row.VersionId !== undefined || row.DeleteMarker || row.ReplicationStatus || row.Expiration || row.ObjectLockMode || row.ObjectLockRetainUntilDate || row.ObjectLockLegalHoldStatus || row.MissingMeta || row.ContentEncoding || row.WebsiteRedirectLocation || typeof row.ETag !== 'string' || !/^"[\x21\x23-\x7e]{1,126}"$/.test(row.ETag)) throw failure();
    if (retired) {
      if (Object.keys(metadata).length !== 1 || row.ContentLength !== 0 || row.ContentType !== 'application/octet-stream' || row.ChecksumSHA256 !== hash(new Uint8Array()).toString('base64')) throw failure();
    } else if (metadata.state !== 'available' || Object.keys(metadata).length !== 2 || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '') || !Number.isSafeInteger(row.ContentLength) || row.ContentLength! < 1 || row.ContentLength! > CAPTURE_LIMITS.segmentBytes || !mimeTypes.has(row.ContentType ?? '') || row.ChecksumSHA256 !== Buffer.from(metadata.sha256, 'hex').toString('base64')) throw failure();
    if (row.ChecksumType !== undefined && row.ChecksumType !== 'FULL_OBJECT') throw failure();
    return { bytes: row.ContentLength!, metadata, contentType: row.ContentType!, etag: row.ETag, retired };
  }
  private async inspect(key: string) {
    try { return this.metadata(await this.call(new HeadObjectCommand({ ...this.scope, Key: this.key(key), ChecksumMode: 'ENABLED' }))); }
    catch (e) { if (status(e) === 404 && !(e as { $response?: { headers?: Record<string, string> } }).$response?.headers?.['x-amz-delete-marker']) return null; throw failure(); }
  }
  async head(key: string) { const row = await this.inspect(key); return row && { bytes: row.bytes, metadata: row.metadata, contentType: row.contentType }; }
  async put(key: string, input: Uint8Array, options: { ifAbsent: boolean; metadata: Record<string, string>; contentType: string }): Promise<'stored' | 'exists'> {
    if (!(input instanceof Uint8Array) || input.byteLength > CAPTURE_LIMITS.segmentBytes) throw failure();
    const physicalKey = this.key(key), body = Uint8Array.from(input), checksum = hash(body);
    const retired = !options.ifAbsent;
    if (retired ? body.byteLength !== 0 || options.contentType !== 'application/octet-stream' || options.metadata.state !== 'retired' || Object.keys(options.metadata).length !== 1 : body.byteLength < 1 || body.byteLength > CAPTURE_LIMITS.segmentBytes || options.metadata.state !== 'available' || options.metadata.sha256 !== checksum.toString('hex') || Object.keys(options.metadata).length !== 2 || !mimeTypes.has(options.contentType)) throw failure();
    try {
      const result = await this.call(new PutObjectCommand({ ...this.scope, Key: physicalKey, Body: body, ContentLength: body.byteLength, ContentType: options.contentType, Metadata: { ...options.metadata }, IfNoneMatch: options.ifAbsent ? '*' : undefined, ChecksumSHA256: checksum.toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.config.kmsKeyArn, BucketKeyEnabled: false }));
      if (result.VersionId !== undefined || result.ChecksumSHA256 !== checksum.toString('base64') || result.ServerSideEncryption !== 'aws:kms' || result.SSEKMSKeyId !== this.config.kmsKeyArn || result.BucketKeyEnabled !== false) throw failure();
      return 'stored';
    } catch (e) { if (options.ifAbsent && status(e) === 412) return 'exists'; throw failure(); }
  }
  async get(key: string, range: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null> {
    const row = await this.inspect(key);
    if (!row || row.retired) return null;
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= row.bytes) throw failure();
    const controller = new AbortController(), length = range.end - range.start + 1;
    let response: GetObjectOutput;
    try { response = await this.call(new GetObjectCommand({ ...this.scope, Key: this.key(key), Range: `bytes=${range.start}-${range.end}`, IfMatch: row.etag }), controller); }
    catch { controller.abort(); throw failure(); }
    const body = response.Body;
    if (!(body instanceof Readable)) { controller.abort(); throw failure(); }
    if (response.ContentLength !== length || response.ContentRange !== `bytes ${range.start}-${range.end}/${row.bytes}` || response.ETag !== row.etag || response.Metadata?.state !== 'available' || response.Metadata?.sha256 !== row.metadata.sha256 || Object.keys(response.Metadata).length !== 2 || response.ContentType !== row.contentType || response.ServerSideEncryption !== 'aws:kms' || response.SSEKMSKeyId !== this.config.kmsKeyArn || response.BucketKeyEnabled !== false || response.VersionId !== undefined || response.DeleteMarker || response.Expiration || response.ReplicationStatus || response.ContentEncoding) { controller.abort(); body.destroy(); throw failure(); }
    const reader = (Readable.toWeb(body, { strategy: { highWaterMark: 256000, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>).getReader();
    let received = 0, pending: Uint8Array | undefined, ended = false;
    const fullHash = range.start === 0 && range.end === row.bytes - 1 ? createHash('sha256') : undefined;
    const stop = () => { if (ended) return; ended = true; clearTimeout(timer); controller.abort(); body.destroy(); void reader.cancel().catch(() => undefined); };
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const timer = setTimeout(() => { stop(); streamController.error(failure()); }, this.config.deadlineMs);
    return new ReadableStream<Uint8Array>({
      start(c) { streamController = c; },
      async pull(c) {
        try {
          if (ended) return;
          if (!pending?.byteLength) {
            const next = await reader.read(); if (ended) return;
            if (next.done) { if (received !== length || fullHash && fullHash.digest('hex') !== row.metadata.sha256) throw failure(); stop(); c.close(); return; }
            if (!(next.value instanceof Uint8Array) || next.value.byteLength > length - received) throw failure();
            received += next.value.byteLength; fullHash?.update(next.value); pending = next.value;
          }
          const chunk = pending.subarray(0, 256000); pending = pending.subarray(chunk.byteLength); c.enqueue(chunk);
        } catch { stop(); c.error(failure()); }
      }, cancel() { stop(); },
    }, { highWaterMark: 0 });
  }
}
