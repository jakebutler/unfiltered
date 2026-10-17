// Bounded local-only smoke proof. Uses synthetic test data; never reads a private operator config.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { newPrivateOutput } from '../io.mjs';
import { clinicFixture } from '../test/fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = name => { const at = process.argv.indexOf(name); if (at < 0 || !process.argv[at + 1]) throw Error('explicit-smoke-arguments-required'); return process.argv[at + 1]; };
const image = arg('--image'), host = arg('--docker-host'), output = newPrivateOutput(root, arg('--receipt'));
if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^unix:\/\/\/Users\/[^/]+\/\.colima\/unfiltered-s0\/docker\.sock$/.test(host)) throw Error('observed-local-image-and-socket-required');
const name = 'unfiltered-aws-smoke-' + randomUUID();
const receipt = { schema: 1, state: 'running', image, containerName: name, startedAt: new Date().toISOString(), cloudCalls: 0, providerCalls: 0, network: 'none', checks: {}, cleanup: false };
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const docker = (args, timeout = 15000) => {
  const result = spawnSync('docker', ['--host', host, ...args], { cwd: root, env: { PATH: process.env.PATH, DOCKER_CONFIG: resolve(root, 'infra/aws/.private/docker-public') }, timeout, maxBuffer: 64000, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw Error('local-container-command-failed');
  return result.stdout.trim();
};
let created = false;
try {
  const metadata = JSON.parse(docker(['image', 'inspect', image, '--format', '{{json .}}']));
  if (metadata.Architecture !== 'arm64' || metadata.Config.User !== 'node' || JSON.stringify(metadata.Config.Cmd) !== '["node","launcher.cjs"]') throw Error('container-metadata-mismatch');
  receipt.architecture = metadata.Architecture;
  // The only entrypoint override writes an explicitly synthetic fixture to private tmpfs.
  // It then invokes the actual launcher, bounded file reader, parser and application.
  const start = `require('node:fs').writeFileSync('/run/secrets/clinic-config.json', ${JSON.stringify(JSON.stringify(clinicFixture()))}, {mode:0o400});require('./launcher.cjs').main();`;
  // A command timeout may follow an accepted create. Remember our unique name before dispatch.
  created = true;
  docker(['run', '--detach', '--pull=never', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '768m', '--cpus', '1', '--pids-limit', '128', '--log-driver', 'none', '--tmpfs', '/run/secrets:rw,noexec,nosuid,size=64k,uid=1000,gid=1000,mode=0700', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--entrypoint', 'node', image, '-e', start]);
  const probe = `
const {createHash}=require('node:crypto'), fs=require('node:fs');
const assert=(value)=>{if(!value)throw Error('packaged-smoke-check-failed')};
(async()=>{
  let response; const deadline=Date.now()+10000;
  while(Date.now()<deadline){try{response=await fetch('http://127.0.0.1:8080/api/clinic/config',{headers:{Host:'10.0.1.12:8080'},signal:AbortSignal.timeout(1000)});break}catch{await new Promise(r=>setTimeout(r,100))}}
  assert(response?.status===200);const config=await response.json();assert(config.syntheticOnly===true&&config.conversation.mode==='guided'&&config.voice.available===false);
  let count=0;for(const asset of JSON.parse(fs.readFileSync('asset-manifest.json')).files){const r=await fetch('http://127.0.0.1:8080/'+asset.path,{signal:AbortSignal.timeout(1000)});assert(r.status===200);assert(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex')===asset.digest);count++}
  for(const path of ['server.cjs','deployment-manifest.json','.env','run/secrets/clinic-config.json']){const r=await fetch('http://127.0.0.1:8080/'+path,{signal:AbortSignal.timeout(1000)});assert(r.status===404)}
  const denied=await fetch('http://127.0.0.1:8080/api/clinic/config',{headers:{Origin:'https://foreign.example.invalid'},signal:AbortSignal.timeout(1000)});assert(denied.status===403);
  console.log(JSON.stringify({privateIpHostNoOrigin:200,providerOff:true,hashedAssets:count,privatePathsDenied:4,foreignOrigin:403,node:process.version,uid:process.getuid()}));
})().catch(()=>process.exit(1));`;
  receipt.checks = JSON.parse(docker(['exec', name, 'node', '-e', probe], 20000));
  const environment = JSON.parse(docker(['inspect', name, '--format', '{{json .HostConfig}}']));
  if (!environment.ReadonlyRootfs || environment.NetworkMode !== 'none' || environment.Memory !== 768 * 1024 * 1024 || environment.PortBindings && Object.keys(environment.PortBindings).length) throw Error('runtime-bound-mismatch');
  docker(['stop', '--time', '10', name]);
  const stopped = JSON.parse(docker(['inspect', name, '--format', '{{json .State}}']));
  if (stopped.Running || stopped.OOMKilled || stopped.ExitCode !== 0) throw Error('shutdown-failed');
  receipt.checks.sigtermExit = stopped.ExitCode;
  receipt.state = 'passed-local-synthetic';
} catch { receipt.state = 'failed-retained-no-retry'; process.exitCode = 1; }
finally {
  if (created) { try { docker(['rm', '--force', name]); receipt.cleanup = true; } catch { receipt.state = 'failed-cleanup-required'; process.exitCode = 1; } }
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
