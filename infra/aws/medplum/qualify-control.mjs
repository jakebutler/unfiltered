/** Trusted synthetic control: exact reviewed package, no generic reopen interface. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chownSync, chmodSync, statSync, lstatSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { names, verifyPackage, privateClientArgs, sha, SOCKET, PACKAGE_HASH, CLI, PLUGIN, CLI_HASH, PLUGIN_HASH, accountOwnedTrees, safeChecks } from './qualify-boundaries.mjs';
const [root, source, target, id] = process.argv.slice(2), n = names(id), pkg = join(root, 'package');
const env = { PATH: '/usr/bin:/bin:/usr/local/bin', DOCKER_HOST: `unix://${SOCKET}`, DOCKER_CONFIG: join(root, 'docker-empty') };
const native = (args, timeout = 60000) => execFileSync('/usr/bin/docker', args, { env, timeout, maxBuffer: 65536, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
const cli = args => execFileSync(process.execPath, ['--max-old-space-size=96', ...args], { env, timeout: 240000, maxBuffer: 65536, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, value) => writeFileSync(p, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600, flag: 'wx' });
let sourceConfig, targetConfig, result, cleanupOk = true, stage = 'package-admission'; const checks={};
const compose = (config, project, args, timeout) => native(['compose','--project-name',project,'--file',join(config,'compose.json'), ...args], timeout);
function pressure() {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m); assert(match && Number(match[1]) >= 262144, 'native-pressure-stop');
}
const ownedBytes = () => accountOwnedTrees([root,source,target]);
function freshData(data, p) {
  for (const name of ['postgres','binary','redis']) mkdirSync(join(data, name), { mode: 0o700 });
  chownSync(join(data,'binary'),1000,1000); chownSync(join(data,'redis'),999,999);
  write(join(data,'.authority.json'), { schema: 1, stackId:'clinic-a', profileHash:p.profileHash, state:'empty' });
}
function client(config, project, mode) {
  const c = json(join(config,'compose.json')); assert.equal(c.networks.default.internal,true);
  try { native(privateClientArgs(n, root, `${project}_default`, mode), 180000); }
  finally { try { const path=join(root,'client',`${mode}.checks.json`);assert(statSync(path).size<=8192);checks[mode]=safeChecks(json(path)); } catch { /* No arbitrary parse/body/error strings enter the result. */ } }
  assert.equal(checks[mode]?.state,'checks-passed');
  native(['rm', n.client]);
}
function stopped(config, project) {
  const ids = compose(config,project,['ps','--all','--quiet']).trim().split('\n').filter(Boolean);
  for (const cid of ids) { assert(/^[a-f0-9]{12,64}$/.test(cid)); const status = JSON.parse(native(['inspect','--format','{{json .State}}',cid])); assert.equal(status.Running,false); assert.equal(status.OOMKilled,false); assert.equal(status.ExitCode,0); }
}
try {
  const p = json(join(pkg,'package.json')); verifyPackage(p,name=>readFileSync(join(pkg,name)));
  assert.equal(sha(readFileSync(CLI)),CLI_HASH); assert.equal(sha(readFileSync(PLUGIN)),PLUGIN_HASH);
  assert.equal(native(['version','--format','{{.Client.Version}} {{.Server.Version}}']).trim(),'29.5.2 29.5.2'); assert.equal(native(['compose','version','--short']).trim(),'5.1.4');
  assert.equal(json(join(pkg,'clinic.json')).stackId,'clinic-a'); for (const path of [root,source,target]) chmodSync(path,0o700); pressure();
  mkdirSync(env.DOCKER_CONFIG,{mode:0o700}); for (const name of ['client','archives','keys']) mkdirSync(join(root,name),{mode:0o700});
  const password = () => randomBytes(40).toString('base64url');
  const admin = { email:`synthetic-${id}@example.invalid`, password:password(), clientId:randomUUID(), clientSecret:password() };
  const secret = { schema:1, stackId:'clinic-a', databasePassword:password(), redisPassword:password(), signingKeyId:`synthetic-${id}`, signingKey:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey, bootstrapAdmin:admin };
  write(join(root,'backend.private.json'),secret); write(join(root,'client','client-input.private.json'),{id:admin.clientId,secret:admin.clientSecret}); write(join(root,'keys','archive.key'),randomBytes(32));
  stage = 'source-render'; sourceConfig = join(root,'source-config'); targetConfig = join(root,'target-config'); freshData(source,p); freshData(target,p);
  cli([join(pkg,'render.mjs'),'--backend-secret',join(root,'backend.private.json'),'--phase','initialize','--data',source,'--output',sourceConfig,'--listen','127.0.0.1:8213']);
  // Frozen packaged helper validates the rendered profile/marker; pullnever launch only.
  const helpers = await import(join(pkg,'shared-hXNTmH8z.mjs'));
  const runtime = helpers.l(sourceConfig,n.source,`unix://${SOCKET}`);
  stage = 'source-start'; compose(sourceConfig,n.source,['up','--detach','--pull','never','--wait','--wait-timeout','180'],210000);
  helpers.u(runtime,'initialized'); stage = 'source-fixture'; client(sourceConfig,n.source,'seed'); ownedBytes(); pressure();
  const redisScript = 'export REDISCLI_AUTH="$(sed -n \'s/^requirepass //p\' /run/secrets/redis.conf)"; exec redis-cli "$@"';
  const redis = args => compose(sourceConfig,n.source,['exec','-T','redis','sh','-c',redisScript,'fixture',...args]).trim();
  const sentinel = `synthetic-${id}-unknown-do-not-replay`; assert.equal(redis(['SET',`uf:drill:${id}`,sentinel]),'OK'); assert.equal(redis(['RPUSH',`uf:drill:${id}:queue`,sentinel]),'1');
  stage = 'backup'; cli([join(pkg,'backup.mjs'),'--backup','--config',sourceConfig,'--project',n.source,'--docker-host',`unix://${SOCKET}`,'--work',join(root,'backup-work'),'--archive',join(root,'archives','backup.enc'),'--key-file',join(root,'keys','archive.key'),'--writers-sealed','clinic-a','--receipt',join(root,'backup-receipt.json')]);
  compose(sourceConfig,n.source,['stop','--timeout','30']); stopped(sourceConfig,n.source); ownedBytes(); pressure();
  delete secret.bootstrapAdmin; write(join(root,'recovered.private.json'),secret);
  stage = 'restore-render'; cli([join(pkg,'render.mjs'),'--backend-secret',join(root,'recovered.private.json'),'--phase','restore','--data',target,'--output',targetConfig,'--listen','127.0.0.1:8213']);
  assert.equal(json(join(targetConfig,'compose.json')).services.server.ports,undefined);
  stage = 'restore'; cli([join(pkg,'restore.mjs'),'--restore','--config',targetConfig,'--project',n.target,'--docker-host',`unix://${SOCKET}`,'--work',join(root,'restore-work'),'--archive',join(root,'archives','backup.enc'),'--key-file',join(root,'keys','archive.key'),'--receipt',join(root,'restore-receipt.json')]);
  assert.equal(json(join(target,'.authority.json')).state,'restored-sealed'); stopped(targetConfig,n.target); ownedBytes();
  stage = 'sealed-start-denial'; const before = compose(targetConfig,n.target,['ps','--all','--quiet']);
  let refused = false; try { cli([join(pkg,'start.mjs'),'--start','--config',targetConfig,'--project',n.target,'--docker-host',`unix://${SOCKET}`]); } catch { refused = true; }
  assert(refused); assert.equal(compose(targetConfig,n.target,['ps','--all','--quiet']),before);
  const server = json(join(targetConfig,'medplum-server.json')); assert.deepEqual(server.workers,{enabled:[]}); assert.equal(server.emailProvider,'none'); assert.equal(server.vmContextBotsEnabled,false); assert.equal(server.autoDownloadEnabled,false);
  // Only this fixed synthetic harness can inspect a restored checkpoint, privately.
  stage = 'private-checkpoint-inspection'; pressure(); compose(targetConfig,n.target,['up','--detach','--pull','never','--wait','--wait-timeout','180'],210000);
  client(targetConfig,n.target,'verify'); assert.deepEqual(json(join(root,'client','seed.proof.json')),json(join(root,'client','verify.proof.json')));
  const targetRedis = args => compose(targetConfig,n.target,['exec','-T','redis','sh','-c',redisScript,'fixture',...args]).trim();
  assert.equal(targetRedis(['GET',`uf:drill:${id}`]),sentinel); assert.equal(targetRedis(['LRANGE',`uf:drill:${id}:queue`,'0','-1']),sentinel);
  assert(statSync(join(root,'archives','backup.enc')).size <= 68157480); const retainedBytes=ownedBytes();
  result = { state:'synthetic-package-checkpoint-restored', checks, retainedBytes, packageHash:PACKAGE_HASH, archiveHash:sha(readFileSync(join(root,'archives','backup.enc'))), proof:json(join(root,'client','verify.proof.json')), redisSentinelHash:sha(sentinel), providerCalls:0, cloudCalls:0, trafficOpened:false, postCheckpointAuthorityReconciled:false, clinicManifestNativeWiringQualified:false, nativeAwsQualified:false, queueExecutionQualified:false };
} catch { result = { state:'failed-or-unknown', checks, failureStep:stage, automaticRetry:false, trafficOpened:false, providerCalls:0, cloudCalls:0 }; }
finally {
  // Only fixed new projects, never existing/related clinics. Retain all volumes.
  try { const ids = native(['ps','--all','--filter',`label=unfiltered.drill=${id}`,'--filter','label=unfiltered.role=client','--format','{{.ID}}']).trim().split('\n').filter(Boolean); for (const cid of ids) { assert(/^[a-f0-9]{12,64}$/.test(cid)); assert.equal(native(['inspect','--format','{{index .Config.Labels "unfiltered.drill"}}',cid]).trim(),id); native(['stop','--time','10',cid]); } } catch { cleanupOk = false; }
  for (const [config,project] of [[sourceConfig,n.source],[targetConfig,n.target]]) if (config) { try { compose(config,project,['stop','--timeout','30']); stopped(config,project); } catch { cleanupOk=false; } }
  if (!cleanupOk) result = { ...result, state:'failed-or-unknown', automaticRetry:false, trafficOpened:false, cleanupVerified:false };
  write(join(root,'result.json'),{...result,cleanupVerified:cleanupOk});
  process.exitCode = result.state === 'synthetic-package-checkpoint-restored' && cleanupOk ? 0 : 1;
}
