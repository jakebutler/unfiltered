import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { medplumProfile, serverConfig, parseBackendSecret } from '../medplum/profile.schema.ts';
import { renderRuntime, profileDigest } from '../medplum/render.mjs';
import { selectVolume, mountedIdentity, mountExisting, requireUnmounted } from '../medplum/volume.mjs';
import { medplumTemplate } from '../templates/medplum.mjs';

const clinic = JSON.parse(readFileSync(new URL('../examples/clinic-a.json', import.meta.url))), profile = medplumProfile(clinic);
const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const secret = { schema: 1, stackId: 'clinic-a', databasePassword: 'a'.repeat(40), redisPassword: 'b'.repeat(40), signingKeyId: 'synthetic-storage-key', signingKey };
const admin = { email: 'admin@example.invalid', password: 'c'.repeat(40), clientId: '00000000-0000-4000-8000-000000000001', clientSecret: 'd'.repeat(40) };
const composeSource = JSON.parse(readFileSync(new URL('../medplum/compose.yml', import.meta.url)));
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uf-medplum-offline-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'); mkdirSync(data, { mode: 0o700 });
  for (const name of ['postgres', 'binary', 'redis']) mkdirSync(join(data, name), { mode: 0o700 });
  writeFileSync(join(data, '.authority.json'), JSON.stringify({ schema: 1, stackId: 'clinic-a', state: 'empty', profileHash: profileDigest(profile) }), { mode: 0o600 });
  return { data, config: join(root, 'config'), clinic, secret: { ...secret, bootstrapAdmin: admin }, phase: 'initialize', composeSource };
}
test('derives independent backend secret and retains the exact clinic namespace', () => {
  assert.equal(profile.backendSecretRef, 'unfiltered/clinic-a/medplum'); assert.notEqual(profile.backendSecretRef, clinic.authority.runtimeSecretRef);
  assert.deepEqual(profile.clinic.authority, clinic.authority);
  assert.throws(() => medplumProfile({ ...clinic, product: 'research' }));
});
for (const [name, bad] of [['cross-stack', { ...secret, stackId: 'clinic-b' }], ['unknown provider field', { ...secret, providerKey: 'no' }], ['weak key', { ...secret, signingKey: 'invalid' }], ['newline password', { ...secret, redisPassword: `${secret.redisPassword}\nfoo` }]]) test(`rejects backend ${name} without echo`, () => {
  assert.throws(() => parseBackendSecret(bad, profile), { message: 'medplum-backend-secret-invalid' });
});
test('pinned config explicitly disables external effects and rejects bootstrap on resume', () => {
  const config = serverConfig(profile, secret, 'resume');
  assert.deepEqual(config.workers, { enabled: [] }); assert.equal(config.autoDownloadEnabled, false);
  assert.equal(config.emailProvider, 'none'); assert.equal(config.allowProjectSmtp, false); assert.equal(config.signingKey, signingKey);
  assert.throws(() => serverConfig(profile, { ...secret, bootstrapAdmin: admin }, 'resume'));
  assert.throws(() => serverConfig(profile, secret, 'initialize'));
});
test('initial render uses private files, pinned limits and no DB/Redis host listener', t => {
  const f = fixture(t); renderRuntime(f);
  const compose = JSON.parse(readFileSync(join(f.config, 'compose.json')));
  assert.equal(compose.services.postgres.ports, undefined); assert.equal(compose.services.redis.ports, undefined);
  assert.equal(compose.networks.default.internal, true); assert.equal(compose.services.server.restart, 'no');
  const redis = readFileSync(join(f.config, 'redis.conf'), 'utf8'); assert.match(redis, /appendonly yes/); assert.match(redis, /appendfsync always/);
});
test('fresh restore renders without a host authority port or bootstrap admin', t => {
  const f = fixture(t); renderRuntime({ ...f, phase: 'restore', secret });
  assert.equal(JSON.parse(readFileSync(join(f.config, 'compose.json'))).services.server.ports, undefined);
  assert.equal(JSON.parse(readFileSync(join(f.config, 'medplum-server.json'))).defaultSuperAdminPassword, undefined);
});
test('initialization refuses existing Binary bytes even without PG_VERSION', t => {
  const f = fixture(t); writeFileSync(join(f.data, 'binary/existing'), 'preserve'); assert.throws(() => renderRuntime(f));
  assert.equal(readFileSync(join(f.data, 'binary/existing'), 'utf8'), 'preserve');
});
test('initialization refuses existing PostgreSQL and symlinked destination', t => {
  const f = fixture(t); writeFileSync(join(f.data, 'postgres/PG_VERSION'), '16'); assert.throws(() => renderRuntime(f));
  symlinkSync(f.data, f.config); assert.throws(() => renderRuntime(f));
});
test('exact-volume selector refuses ambiguous devices, root mount and partitioned disks', () => {
  const id = 'vol-0123456789abcdef0', disk = { path: '/dev/nvme1n1', serial: id.replace('-', ''), type: 'disk', mountpoints: [null] };
  assert.equal(selectVolume([disk], id), disk);
  for (const value of [[disk, disk], [{ ...disk, mountpoints: ['/'] }], [{ ...disk, children: [{}] }], [{ ...disk, serial: 'other' }]]) assert.throws(() => selectVolume(value, id));
});
test('initialization requires explicit unmounted result; mounted or unknown diagnostics cannot format', () => {
  assert.throws(() => requireUnmounted('/synthetic', () => '{"filesystems":[]}'), /initialization-over-mounted/);
  assert.throws(() => requireUnmounted('/synthetic', () => { throw Object.assign(new Error('unknown'), { status: 1, stderr: 'inspection failed' }); }));
  assert.doesNotThrow(() => requireUnmounted('/synthetic', () => { throw Object.assign(new Error('no mount'), { status: 1, stderr: '' }); }));
});
test('already mounted volume is revalidated, not remounted or initialized', t => {
  const f = fixture(t), volumeId = 'vol-0123456789abcdef0', uuid = 'synthetic-uuid';
  writeFileSync(join(f.data, '.authority.json'), JSON.stringify({ schema: 1, stackId: 'clinic-a', profileHash: profileDigest(profile), volumeId, filesystemUuid: uuid, state: 'initialized' }), { mode: 0o600 });
  const calls = [], run = (command, args) => { calls.push(command); return command.endsWith('findmnt') ? JSON.stringify({ filesystems: [{ source: '/dev/nvme1n1', target: f.data, fstype: 'ext4', uuid }] }) : JSON.stringify({ blockdevices: [{ path: '/dev/nvme1n1', type: 'disk', serial: volumeId.replace('-', ''), uuid }] }); };
  assert.equal(mountExisting({ volumeId, mount: f.data, profile, run }).state, 'initialized'); assert.ok(calls.every(command => !command.endsWith('/mount')));
  assert.throws(() => mountedIdentity(f.data, 'vol-1123456789abcdef0', profile, run));
});
test('private authority template has exact secret, actual encrypted storage and only clinic-server TLS ingress', () => {
  const template = medplumTemplate(clinic, 'a'.repeat(64)), r = template.Resources;
  assert.equal(r.Edge.Properties.Scheme, 'internal');
  assert.deepEqual(r.EdgeSecurityGroup.Properties.SecurityGroupIngress, [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupId: { Ref: 'ClinicServerSecurityGroupId' } }]);
  assert.equal(r.DataVolume.Properties.Encrypted, true); assert.equal(r.DataVolume.DeletionPolicy, 'Retain'); assert.ok(r.DataAttachment);
  const policy = JSON.stringify(r.RuntimeRole.Properties.Policies); assert.match(policy, /unfiltered\/clinic-a\/medplum-/); assert.doesNotMatch(policy, /\/runtime-|Resource":"\*"/);
  const bootstrap = r.Node.Properties.UserData['Fn::Base64']['Fn::Sub'][0]; assert.doesNotMatch(bootstrap, /(?:^|\n)\s*(?:\/[^\s]+\/)?mkfs/);
  assert.equal(r.Node.Properties.NetworkInterfaces[0].AssociatePublicIpAddress, false);
});
