import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, expect, it, vi } from 'vitest';
import { S3PrivateBucketPort, type S3PrivateBucketConfig } from '../../../packages/research-capture/src/s3-bucket';
import { BucketPrivateObjectStore } from '../../../packages/research-capture/src/bucket-store';

const config: S3PrivateBucketConfig = { bucket: 'unfiltered-research-test', region: 'us-east-1', accountId: '123456789012', namespace: 'research-objects', kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000001' };
const key = 'research/session1/segment1-a1', bytes = new TextEncoder().encode('synthetic bytes'), sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const credentials = vi.fn(async () => ({ accessKeyId: 'SYNTHETIC', secretAccessKey: 'synthetic-no-authority' }));
const absent = (name: string, code = 404) => Object.assign(new Error('synthetic service outcome'), { name, $metadata: { httpStatusCode: code } });
const ports: S3PrivateBucketPort[] = [];
afterEach(() => { ports.splice(0).forEach(p => p.close()); vi.restoreAllMocks(); vi.unstubAllEnvs(); credentials.mockClear(); });

async function fixture(options: { drift?: string; version?: string; deadline?: number } = {}) {
  const objects = new Map<string, { body: Uint8Array; metadata: Record<string, string>; contentType: string; checksum: string }>();
  let availableGate: Promise<void> | undefined, responseMutator = (r: any) => r, streamFactory = (b: Uint8Array) => Readable.from([b]);
  let writes = 0;
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any) => {
    const name = command.constructor.name, i = command.input;
    if (name === 'GetBucketVersioningCommand') return { Status: options.version } as any;
    if (name === 'GetBucketLifecycleConfigurationCommand') { if (options.drift === 'lifecycle') return { Rules: [] } as any; throw absent('NoSuchLifecycleConfiguration'); }
    if (name === 'GetBucketReplicationCommand') { if (options.drift === 'replication') return {} as any; throw absent('ReplicationConfigurationNotFoundError'); }
    if (name === 'GetObjectLockConfigurationCommand') { if (options.drift === 'lock') return {} as any; throw absent('ObjectLockConfigurationNotFoundError'); }
    if (name === 'GetBucketEncryptionCommand') return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: config.kmsKeyArn }, BucketKeyEnabled: false }] } } as any;
    if (name === 'GetPublicAccessBlockCommand') return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: options.drift !== 'public', RestrictPublicBuckets: true } } as any;
    if (name === 'GetBucketOwnershipControlsCommand') return { OwnershipControls: { Rules: [{ ObjectOwnership: options.drift === 'acl' ? 'ObjectWriter' : 'BucketOwnerEnforced' }] } } as any;
    if (name === 'PutObjectCommand') {
      writes++; if (i.IfNoneMatch && availableGate) await availableGate;
      if (i.IfNoneMatch && objects.has(i.Key)) throw absent('PreconditionFailed', 412);
      objects.set(i.Key, { body: Uint8Array.from(i.Body), metadata: i.Metadata, contentType: i.ContentType, checksum: i.ChecksumSHA256 });
      return { ChecksumSHA256: i.ChecksumSHA256, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn, BucketKeyEnabled: false } as any;
    }
    const row = objects.get(i.Key); if (!row) throw absent('NotFound');
    const metadata = { ContentLength: row.body.length, ContentType: row.contentType, Metadata: row.metadata, ChecksumSHA256: row.checksum, ChecksumType: 'FULL_OBJECT', ETag: '"'+sha(row.body).slice(0,32)+'"', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn, BucketKeyEnabled: false };
    if (name === 'HeadObjectCommand') return responseMutator(metadata) as any;
    if (name === 'GetObjectCommand') {
      if (i.IfMatch !== metadata.ETag) throw absent('PreconditionFailed', 412);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(i.Range)!;
      return responseMutator({ ...metadata, ContentLength: +end - +start + 1, ContentRange: `bytes ${start}-${end}/${row.body.length}`, Body: streamFactory(row.body.subarray(+start, +end+1)) }) as any;
    }
    throw Error('unexpected mocked command');
  });
  const port = await S3PrivateBucketPort.open({ ...config, deadlineMs: options.deadline }, credentials); ports.push(port);
  return { port, store: new BucketPrivateObjectStore(port), objects, send, writes: () => writes, gate: (g: Promise<void>) => { availableGate = g; }, mutate: (fn: (r: any) => any) => { responseMutator = fn; }, stream: (fn: (b: Uint8Array) => Readable) => { streamFactory = fn; } };
}
const put = (f: Awaited<ReturnType<typeof fixture>>) => f.store.putIfAbsent(key, bytes, { bytes: bytes.length, sha256: sha(bytes), mime: 'audio/webm' });

it('uses conditional checksummed immutable bytes; repeated matching creates reconcile and exact ranges read privately', async () => {
  const f = await fixture(); await put(f); await put(f);
  expect(await f.store.head(key)).toEqual({ bytes: bytes.length, sha256: sha(bytes), mime: 'audio/webm' });
  expect(await new Response(await f.store.read(key, { start: 2, end: 7 })).text()).toBe('ntheti');
  const calls = f.send.mock.calls.map(([c]: any) => c);
  const create = calls.find(c => c.constructor.name === 'PutObjectCommand').input;
  expect(create).toMatchObject({ Key: 'research-objects/'+key, ExpectedBucketOwner: config.accountId, IfNoneMatch: '*', ChecksumSHA256: Buffer.from(sha(bytes),'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn, BucketKeyEnabled: false });
  expect(calls.find(c => c.constructor.name === 'GetObjectCommand').input).toMatchObject({ Range: 'bytes=2-7', IfMatch: expect.stringMatching(/^"/), ExpectedBucketOwner: config.accountId });
  expect(credentials).not.toHaveBeenCalled(); // send mock never resolves credentials or opens transport.
});
it('fences late create when retirement commits first, including an absent key', async () => {
  const f = await fixture(); let release!: () => void; f.gate(new Promise(r => { release = r; }));
  const late = put(f); await Promise.resolve(); await f.store.retire(key); release();
  await expect(late).rejects.toThrow('reconciliation'); expect(await f.store.head(key)).toBeNull();
  expect(f.objects.get('research-objects/'+key)!.body.length).toBe(0); expect(f.writes()).toBe(2);
});
it('replaces committed bytes and keeps repeated retirement idempotent without DeleteObject', async () => {
  const f = await fixture(); await put(f); await f.store.retire(key); await f.store.retire(key);
  await expect(put(f)).rejects.toThrow(); expect(await f.store.head(key)).toBeNull();
  expect(f.send.mock.calls.some(([c]: any) => c.constructor.name === 'DeleteObjectCommand')).toBe(false);
});
it.each(['Enabled', 'Suspended'])('rejects historical versioning %s before writes', async version => { await expect(fixture({version})).rejects.toThrow(); });
it.each(['lifecycle','replication','lock','public','acl'])('rejects %s drift at startup before writes', async drift => { await expect(fixture({drift})).rejects.toThrow(); });
it('propagates unknown/409 writes without retry or treating them as observed existence', async () => {
  const f = await fixture(); f.send.mockImplementationOnce(async () => { throw absent('ConditionalRequestConflict',409); });
  await expect(put(f)).rejects.toThrow('reconciliation'); expect(f.writes()).toBe(0);
});
it('preserves accepted bytes after lost acknowledgement, then reconciles by HEAD without another write', async () => {
  const f = await fixture(), actual = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (command: any, options: any) => { const result = await (actual as any)(command, options); if (command.constructor.name === 'PutObjectCommand') throw Error('lost acknowledgement'); return result; });
  await expect(put(f)).rejects.toThrow('reconciliation'); expect(f.writes()).toBe(1);
  expect(await f.store.head(key)).toEqual({bytes:bytes.length,sha256:sha(bytes),mime:'audio/webm'}); expect(f.writes()).toBe(1);
});
it('uses ETag to prevent serving an object retired between HEAD and GET', async () => {
  const f = await fixture(); await put(f); const actual = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (command: any, options: any) => { if (command.constructor.name === 'GetObjectCommand') await f.store.retire(key); return (actual as any)(command, options); });
  await expect(f.store.read(key,{start:0,end:1})).rejects.toThrow(); expect(await f.store.head(key)).toBeNull(); expect(f.writes()).toBe(2);
});
it('aborts a stalled request on deadline even if transport ignores abort; never resends it', async () => {
  const f = await fixture({deadline:20}), before = f.send.mock.calls.length;
  f.send.mockImplementationOnce(() => new Promise(() => undefined));
  await expect(put(f)).rejects.toThrow('reconciliation'); expect(f.send.mock.calls.length-before).toBe(1);
  expect((f.send.mock.calls.at(-1)![1] as any).abortSignal.aborted).toBe(true);
});
it.each(['sha256','length','encryption','version','expiry','replication','checksum','encoding'])('rejects forged or stale HEAD %s', async field => {
  const f = await fixture(); await put(f); f.mutate(r => ({ ...r, ...({sha256:{Metadata:{state:'available',sha256:'0'.repeat(64)}},length:{ContentLength:8000001},encryption:{SSEKMSKeyId:config.kmsKeyArn+'x'},version:{VersionId:'old'},expiry:{Expiration:'expiry'},replication:{ReplicationStatus:'COMPLETE'},checksum:{ChecksumSHA256:'bad'},encoding:{ContentEncoding:'gzip'}}[field]) }));
  await expect(f.store.head(key)).rejects.toThrow();
});
it('rejects a wrong range before emitting a body and releases it', async () => {
  const f = await fixture(); await put(f); let body!: Readable; f.stream(b => body = Readable.from([b])); f.mutate(r => r.Body ? {...r,ContentRange:'bytes 0-1/2'}:r);
  await expect(f.store.read(key,{start:0,end:2})).rejects.toThrow(); expect(body.destroyed).toBe(true);
});
it.each(['truncated','overflow','checksum'])('fails %s body rather than silently accepting inconsistent bytes', async kind => {
  const f = await fixture(); await put(f); f.stream(b => Readable.from([kind==='truncated'?b.subarray(1):kind==='overflow'?Buffer.concat([b,Buffer.from('x')]):new Uint8Array(b.length)]));
  await expect(new Response(await f.store.read(key,{start:0,end:bytes.length-1})).arrayBuffer()).rejects.toThrow();
});
it('cancels native body immediately and imposes a deadline on an idle stream', async () => {
  const f = await fixture({deadline:20}); await put(f); let body!: Readable; f.stream(() => body = new Readable({read(){}}));
  const stream = await f.store.read(key,{start:0,end:1}); await stream.cancel(); expect(body.destroyed).toBe(true);
  await expect(new Response(await f.store.read(key,{start:0,end:1})).arrayBuffer()).rejects.toThrow(); expect(body.destroyed).toBe(true);
});
it('rejects foreign keys, oversize bytes, nonzero retirement and malformed metadata before dispatch', async () => {
  const f = await fixture(), before = f.send.mock.calls.length;
  await expect(f.port.put('../foreign',bytes,{ifAbsent:true,metadata:{state:'available',sha256:sha(bytes)},contentType:'audio/webm'})).rejects.toThrow();
  await expect(f.port.put(key,new Uint8Array(8000001),{ifAbsent:true,metadata:{state:'available',sha256:sha(bytes)},contentType:'audio/webm'})).rejects.toThrow();
  await expect(f.port.put(key,bytes,{ifAbsent:false,metadata:{state:'retired'},contentType:'application/octet-stream'})).rejects.toThrow();
  await expect(f.port.put(key,bytes,{ifAbsent:true,metadata:{state:'available',sha256:'0'.repeat(64)},contentType:'audio/webm'})).rejects.toThrow();
  expect(f.send.mock.calls.length).toBe(before);
});

it('serializes official SDK conditional/checksum/owner headers and never retries a transport 503', async () => {
  vi.stubEnv('AWS_ENDPOINT_URL_S3','https://foreign.example.invalid');
  const requests: any[] = []; let failPut = false;
  const requestHandler = { handle: async (r: any) => {
    requests.push(r); let code=200, headers: Record<string,string> = {}, xml='';
    if (r.query.versioning !== undefined) xml='<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>';
    else if (r.query.lifecycle !== undefined || r.query.replication !== undefined || r.query['object-lock'] !== undefined) {code=404;xml='<Error><Code>'+ (r.query.lifecycle !== undefined?'NoSuchLifecycleConfiguration':r.query.replication!==undefined?'ReplicationConfigurationNotFoundError':'ObjectLockConfigurationNotFoundError')+'</Code></Error>';}
    else if (r.query.encryption!==undefined) xml='<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm><KMSMasterKeyID>'+config.kmsKeyArn+'</KMSMasterKeyID></ApplyServerSideEncryptionByDefault><BucketKeyEnabled>false</BucketKeyEnabled></Rule></ServerSideEncryptionConfiguration>';
    else if (r.query.publicAccessBlock!==undefined) xml='<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>';
    else if (r.query.ownershipControls!==undefined) xml='<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>';
    else if (r.method==='PUT') {if(failPut){code=503;xml='<Error><Code>SlowDown</Code></Error>'}else headers={'x-amz-checksum-sha256':r.headers['x-amz-checksum-sha256'],'x-amz-server-side-encryption':'aws:kms','x-amz-server-side-encryption-aws-kms-key-id':config.kmsKeyArn,'x-amz-server-side-encryption-bucket-key-enabled':'false'};}
    else throw Error('unexpected wire request');
    return {response:{statusCode:code,headers,body:Readable.from([Buffer.from(xml)])}};
  }, destroy(){} };
  const port = await S3PrivateBucketPort.open(config,credentials,requestHandler); ports.push(port);
  await port.put(key,bytes,{ifAbsent:true,metadata:{state:'available',sha256:sha(bytes)},contentType:'audio/webm'});
  const r = requests.at(-1); expect(r.protocol).toBe('https:'); expect(r.hostname).toBe(config.bucket+'.s3.us-east-1.amazonaws.com');
  expect(r.headers).toMatchObject({'if-none-match':'*','x-amz-expected-bucket-owner':config.accountId,'x-amz-meta-sha256':sha(bytes),'x-amz-server-side-encryption-aws-kms-key-id':config.kmsKeyArn});
  failPut=true;const before=requests.length;await expect(port.put(key,bytes,{ifAbsent:true,metadata:{state:'available',sha256:sha(bytes)},contentType:'audio/webm'})).rejects.toThrow();expect(requests.length-before).toBe(1);
});
