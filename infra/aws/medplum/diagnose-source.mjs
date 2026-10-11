/** One fixed retained-source diagnostic, explicitly gated; not a drill retry. */
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { capacity, ownedVolume, CLI, PLUGIN, SOCKET, NODE_IMAGE, sha } from './qualify-boundaries.mjs';
import { STAGES } from './diagnose-source-client.mjs';
const here = dirname(fileURLToPath(import.meta.url)), repository = resolve(here, '../../..'), privateDir = join(repository, 'infra/aws/.private');
const id = 'f2c99e4e4b12', project = `uf-aws-medplum-clinic-a-${id}`;
const control = `uf-aws-medplum-diag-${id}-control-1`, client = `uf-aws-medplum-diag-${id}-client-1`, volume = `uf-aws-medplum-diag-${id}-1`;
const receipt = join(privateDir, 'AWS-MEDPLUM-SOURCE-DIAGNOSTIC-2026-10-10.json');
export function sanitize(value) {
  assert(['control-failed-or-unknown', 'private-input-rejected', 'read-boundary-failed-or-unknown', 'read-checks-passed-mutation-boundary-not-replayed'].includes(value.state));
  assert(Array.isArray(value.rows) && value.rows.length <= STAGES.length);
  const rows = value.rows.map((r, i) => {
    assert.equal(r.stage, STAGES[i]); assert(Number.isInteger(r.status) && (r.status === 0 || (r.status >= 100 && r.status <= 599)));
    assert(['pass', 'expectation-failed', 'transport-or-body-unknown'].includes(r.outcome)); assert(i === value.rows.length - 1 || r.outcome === 'pass');
    return { stage: r.stage, status: r.status, outcome: r.outcome };
  });
  if (value.state === 'read-checks-passed-mutation-boundary-not-replayed') assert(rows.length === STAGES.length && rows.every(r => r.outcome === 'pass'));
  return { state: value.state, rows, ...( ['admission', 'source-start', 'read-checks'].includes(value.failureStage) ? { failureStage: value.failureStage } : {}), automaticRetry: false, originalDrillReplayed: false, mutationChecksReplayed: false, providerCalls: 0, cloudCalls: 0 };
}
export async function execute() {
  assert.equal(process.versions.node, '22.22.3'); assert.deepEqual(process.argv.slice(2), ['--execute-retained-source-read-diagnostic']);
  assert.equal(realpathSync(privateDir), privateDir); assert(!(lstatSync(privateDir).mode & 0o077));
  assert(!existsSync(receipt) && !existsSync(`${receipt}.intent`));
  const originalReceipt = join(privateDir, 'AWS-MEDPLUM-NATIVE-2026-10-10.json');
  assert.equal(sha(readFileSync(originalReceipt)), '8725c5b14dc7e38f601c96f3574fbfa7904645b464113660c7f8c715709bccec');
  const previous = JSON.parse(readFileSync(originalReceipt)); assert.equal(previous.failureStep, 'source-fixture'); assert.equal(previous.cleanupVerified, true);
  const config = join(privateDir, `medplum-diagnostic-docker-${id}-1`); mkdirSync(config, { mode: 0o700 });
  const socket = join(homedir(), '.colima/unfiltered-s0/docker.sock'); assert(lstatSync(socket).isSocket());
  const env = { PATH: process.env.PATH, HOME: homedir(), DOCKER_HOST: `unix://${socket}`, DOCKER_CONFIG: config };
  const run = (program, args, timeout = 60000) => execFileSync(program, args, { env, timeout, maxBuffer: 65536, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const docker = (args, timeout) => run('docker', args, timeout), ssh = args => run('colima', ['--profile', 'unfiltered-s0', 'ssh', '--', ...args]);
  const inspect = cid => JSON.parse(docker(['inspect', cid]))[0];
  const observe = () => {
    const r = ssh(['sh', '-c', 'sha256sum /usr/bin/docker /usr/libexec/docker/cli-plugins/docker-compose; readlink -f /var/run/docker.sock; uname -m; awk \'/^MemAvailable:/ {print int($2/1024)}\' /proc/meminfo; df -Pm / | tail -1']).trim().split('\n');
    assert.equal(r.length, 6); return { cliHash: r[0].split(/\s+/)[0], pluginHash: r[1].split(/\s+/)[0], socket: r[2], platform: r[3] === 'aarch64' ? 'linux/arm64' : r[3], availableMiB: Number(r[4]), freeDiskMiB: Number(r[5].trim().split(/\s+/)[3]) };
  };
  let admitted = false, created = false, cleanup = true, timer, output, result = { state: 'control-failed-or-unknown', rows: [] }, pressureFailed = false;
  const abort = new AbortController(), interrupt = () => abort.abort(); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const profile = run('colima', ['list', '--json']).trim().split('\n').map(JSON.parse).find(p => p.name === 'unfiltered-s0');
    assert(profile && profile.status === 'Running' && profile.arch === 'aarch64' && profile.cpus === 2 && profile.memory === 4294967296 && profile.disk === 21474836480);
    assert.equal(ssh(['sh', '-c', 'test ! -e /Users && test ! -e /Volumes && echo mountnone']).trim(), 'mountnone');
    const mem = docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', 'unfiltered-research-s4-backend-1']).trim().split('/')[0].trim().match(/^(\d+(?:\.\d+)?)(KiB|MiB|GiB)$/); assert(mem);
    const observed = observe(); capacity({ ...observed, activeNames: docker(['ps', '--format', '{{.Names}}']).trim().split('\n').filter(Boolean), existingMiB: Number(mem[1]) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 }[mem[2]]) });
    assert.equal(docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', NODE_IMAGE]).trim(), 'linux/arm64');
    for (const name of [control, client]) assert(!docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']).trim());
    assert(!docker(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']).trim());
    const original = ownedVolume(JSON.parse(docker(['volume', 'inspect', `uf-aws-medplum-drill-${id}-control`]))[0], `uf-aws-medplum-drill-${id}-control`, 'control', id);
    const source = ownedVolume(JSON.parse(docker(['volume', 'inspect', `uf-aws-medplum-drill-${id}-source`]))[0], `uf-aws-medplum-drill-${id}-source`, 'source', id);
    const listener = createServer(); await new Promise((ok, no) => { listener.once('error', no); listener.listen({ host: '127.0.0.1', port: 8213, exclusive: true }, ok); }); await new Promise(ok => listener.close(ok));
    const scripts = ['diagnose-source-control.mjs', 'diagnose-source-client.mjs', 'qualify-boundaries.mjs'];
    writeFileSync(`${receipt}.intent`, JSON.stringify({ originalReceiptHash: sha(readFileSync(originalReceipt)), scripts: Object.fromEntries(scripts.map(s => [s, sha(readFileSync(join(here, s)))])), automaticRetry: false }), { flag: 'wx', mode: 0o600 }); admitted = true;
    docker(['volume', 'create', '--label', `unfiltered.diagnostic=${id}`, volume]); const v = JSON.parse(docker(['volume', 'inspect', volume]))[0];
    assert.equal(v.Name, volume); assert.equal(v.Driver, 'local'); assert.equal(v.Labels?.['unfiltered.diagnostic'], id); assert.equal(Object.keys(v.Options ?? {}).length, 0);
    output = `/var/lib/docker/volumes/${volume}/_data`; assert.equal(v.Mountpoint, output);
    docker(['create', '--pull', 'never', '--name', control, '--label', `unfiltered.diagnostic=${id}`, '--network', 'none', '--memory', '128m', '--cpus', '.05', '--pids-limit', '64', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,size=16m',
      '--mount', `type=volume,src=${volume},dst=${output}`, '--mount', `type=volume,src=uf-aws-medplum-drill-${id}-control,dst=${original},readonly`, '--mount', `type=volume,src=uf-aws-medplum-drill-${id}-source,dst=${source},readonly`,
      '--mount', `type=bind,src=${SOCKET},dst=${SOCKET}`, '--mount', `type=bind,src=${CLI},dst=${CLI},readonly`, '--mount', `type=bind,src=${PLUGIN},dst=${PLUGIN},readonly`, NODE_IMAGE, 'node', '--max-old-space-size=96', `${output}/diagnose-source-control.mjs`, '--execute-read-only-diagnostic']); created = true;
    for (const script of scripts) docker(['cp', join(here, script), `${control}:${output}/${script}`]);
    timer = setInterval(() => { try { const o = observe(); if (o.availableMiB < 256 || o.freeDiskMiB < 1024) { pressureFailed = true; abort.abort(); } } catch { pressureFailed = true; abort.abort(); } }, 5000);
    let attachOk = true; try { await promisify(execFile)('docker', ['start', '--attach', control], { env, timeout: 540000, signal: abort.signal, maxBuffer: 65536 }); } catch { attachOk = false; }
    clearInterval(timer); timer = undefined;
    const path = join(privateDir, `medplum-diagnostic-result-${id}-1.json`); docker(['cp', `${control}:${output}/result.json`, path]); const info = lstatSync(path); assert(info.isFile() && !info.isSymbolicLink() && info.size <= 8192);
    result = sanitize(JSON.parse(readFileSync(path))); if (pressureFailed || !attachOk && result.state === 'read-checks-passed-mutation-boundary-not-replayed') result = { state: 'control-failed-or-unknown', rows: result.rows };
  } catch { result = { state: 'control-failed-or-unknown', rows: [] }; }
  finally {
    clearInterval(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (admitted) {
      // Stop diagnostic controller first; then exact diagnostic client and original source only.
      for (const [name, exists] of [[control, created], [client, true]]) if (exists) try { const c = inspect(name); assert.equal(c.Config.Labels?.['unfiltered.diagnostic'], id); docker(['stop', '--time', '10', name]); assert.equal(inspect(name).State.Running, false); } catch { if (name === control) cleanup = false; else if (docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']).trim()) cleanup = false; }
      try {
        const ids = docker(['ps', '--all', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']).trim().split('\n').filter(Boolean);
        for (const cid of ids) try { assert(/^[a-f0-9]{12,64}$/.test(cid)); assert.equal(inspect(cid).Config.Labels?.['com.docker.compose.project'], project); docker(['stop', '--time', '30', cid]); assert.equal(inspect(cid).State.Running, false); } catch { cleanup = false; }
        assert.deepEqual(docker(['ps', '--format', '{{.Names}}']).trim().split('\n').filter(Boolean), ['unfiltered-research-s4-backend-1']);
        assert.equal(inspect('unfiltered-research-s4-backend-1').State.Health?.Status, 'healthy');
      } catch { cleanup = false; }
      if (!cleanup) result = { state: 'control-failed-or-unknown', rows: result.rows ?? [] };
      writeFileSync(receipt, JSON.stringify({ ...result, cleanupVerified: cleanup, retainedDiagnosticVolume: volume, originalReceiptUnchanged: sha(readFileSync(originalReceipt)) === '8725c5b14dc7e38f601c96f3574fbfa7904645b464113660c7f8c715709bccec', automaticRetry: false, originalDrillReplayed: false, mutationChecksReplayed: false, providerCalls: 0, cloudCalls: 0 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
  }
  return { state: admitted ? result.state : 'preflight-rejected-zero-native-mutations', cleanupVerified: cleanup, receipt: admitted ? receipt : undefined };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const r = await execute(); console.log(JSON.stringify(r)); if (!r.cleanupVerified || r.state !== 'read-checks-passed-mutation-boundary-not-replayed') process.exitCode = 1; }
  catch { console.error('retained-source-diagnostic-refused-or-unknown'); process.exitCode = 1; }
}
