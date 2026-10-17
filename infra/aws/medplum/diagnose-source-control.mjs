/** Fixed retained-source diagnostic control; no seed, render, backup, restore, or unseal. */
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sha, CLI, CLI_HASH, PLUGIN, PLUGIN_HASH, SOCKET, NODE_IMAGE, accountOwnedTrees, verifyPackage } from './qualify-boundaries.mjs';
import { STAGES } from './diagnose-source-client.mjs';

const id = 'f2c99e4e4b12', project = `uf-aws-medplum-clinic-a-${id}`;
const original = `/var/lib/docker/volumes/uf-aws-medplum-drill-${id}-control/_data`;
const source = `/var/lib/docker/volumes/uf-aws-medplum-drill-${id}-source/_data`;
const output = `/var/lib/docker/volumes/uf-aws-medplum-diag-${id}-1/_data`;
const client = `uf-aws-medplum-diag-${id}-client-1`, config = join(original, 'source-config');
const env = { PATH: '/usr/bin:/bin:/usr/local/bin', DOCKER_HOST: `unix://${SOCKET}`, DOCKER_CONFIG: join(output, 'docker-empty') };
const run = (args, timeout = 60000) => execFileSync(CLI, args, { env, timeout, maxBuffer: 65536, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const inspect = cid => JSON.parse(run(['inspect', cid]))[0];
const owned = cid => { const c = inspect(cid); assert.equal(c.Config.Labels?.['com.docker.compose.project'], project); return c; };
function pressure() { const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m); assert(m && Number(m[1]) >= 262144); }
function safe(value) {
  assert(['private-input-rejected', 'read-boundary-failed-or-unknown', 'read-checks-passed-mutation-boundary-not-replayed'].includes(value.state));
  assert.equal(value.automaticRetry, false); assert.equal(value.mutationChecksReplayed, false);
  assert(Array.isArray(value.rows) && value.rows.length <= STAGES.length);
  const rows = value.rows.map((r, i) => {
    assert.equal(r.stage, STAGES[i]); assert(Number.isInteger(r.status) && (r.status === 0 || (r.status >= 100 && r.status <= 599)));
    assert(['pass', 'expectation-failed', 'transport-or-body-unknown'].includes(r.outcome));
    assert(i === value.rows.length - 1 || r.outcome === 'pass');
    return { stage: r.stage, status: r.status, outcome: r.outcome };
  });
  if (value.state === 'read-checks-passed-mutation-boundary-not-replayed') assert(rows.length === STAGES.length && rows.every(r => r.outcome === 'pass'));
  return { state: value.state, rows, automaticRetry: false, mutationChecksReplayed: false };
}
let stage = 'admission', result = { state: 'control-failed-or-unknown', rows: [], automaticRetry: false, mutationChecksReplayed: false }, cleanup = true, started = false, clientCreated = false, timer;
const services = new Map();
try {
  assert.deepEqual(process.argv.slice(2), ['--execute-read-only-diagnostic']);
  verifyPackage(json(join(original, 'package/package.json')), name => readFileSync(join(original, 'package', name)));
  assert.equal(sha(readFileSync(CLI)), CLI_HASH); assert.equal(sha(readFileSync(PLUGIN)), PLUGIN_HASH);
  assert.equal(run(['version', '--format', '{{.Client.Version}} {{.Server.Version}}']).trim(), '29.5.2 29.5.2');
  assert.equal(run(['compose', 'version', '--short']).trim(), '5.1.4');
  const compose = json(join(config, 'compose.json')), server = json(join(config, 'medplum-server.json'));
  assert.equal(sha(JSON.stringify(compose)), json(join(config, 'rendered.json')).composeHash);
  const expected = JSON.parse(JSON.stringify(json(join(original, 'package/compose.yml'))).replaceAll('@DATA@', source).replaceAll('@CONFIG@', config).replaceAll('@LISTEN@', '127.0.0.1:8213'));
  assert.deepEqual(compose, expected);
  assert.equal(compose.networks.default.internal, true); assert.deepEqual(server.workers, { enabled: [] });
  assert.equal(server.emailProvider, 'none'); assert.equal(server.vmContextBotsEnabled, false); assert.equal(server.autoDownloadEnabled, false);
  const ids = run(['ps', '--all', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 3);
  for (const cid of ids) {
    assert(/^[a-f0-9]{12,64}$/.test(cid)); const c = owned(cid), service = c.Config.Labels['com.docker.compose.service'];
    assert(['postgres', 'redis', 'server'].includes(service) && !services.has(service));
    assert.equal(c.State.Running, false); assert.equal(c.State.OOMKilled, false); assert.equal(c.State.ExitCode, 0);
    assert.equal(c.Config.Image, compose.services[service].image); assert.equal(c.HostConfig.RestartPolicy.Name, 'no');
    assert.equal(c.HostConfig.Memory, { postgres: 1073741824, redis: 268435456, server: 1610612736 }[service]);
    assert.equal(c.HostConfig.NanoCpus, { postgres: 700000000, redis: 200000000, server: 1000000000 }[service]);
    for (const binding of compose.services[service].volumes) {
      const [path, destination, mode] = binding.split(':'), mount = c.Mounts.find(m => m.Destination === destination);
      assert(mount && mount.Type === 'bind' && mount.Source === path && mount.RW === (mode !== 'ro'));
    }
    if (service === 'server') assert.deepEqual(c.HostConfig.PortBindings['8103/tcp'], [{ HostIp: '127.0.0.1', HostPort: '8213' }]);
    else assert(!c.HostConfig.PortBindings || Object.keys(c.HostConfig.PortBindings).length === 0);
    services.set(service, cid);
  }
  assert.equal(run(['network', 'inspect', '--format', '{{.Internal}}', `${project}_default`]).trim(), 'true');
  pressure(); accountOwnedTrees([original, source]); mkdirSync(env.DOCKER_CONFIG, { mode: 0o700 });
  async function healthy(service, deadline) {
    while (Date.now() < deadline) { pressure(); const s = owned(services.get(service)).State; assert(s.Running && !s.OOMKilled); if (s.Health?.Status === 'healthy') return; assert(s.Health?.Status !== 'unhealthy'); await delay(1000); }
    throw new Error('fixed-health-deadline');
  }
  stage = 'source-start'; started = true;
  run(['start', services.get('postgres'), services.get('redis')]); await healthy('postgres', Date.now() + 90000);
  run(['start', services.get('server')]); await healthy('server', Date.now() + 180000);
  stage = 'read-checks'; const args = ['run', '--pull', 'never', '--name', client, '--label', `unfiltered.diagnostic=${id}`, '--network', `${project}_default`, '--memory', '128m', '--cpus', '.05', '--pids-limit', '32', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,size=16m',
    '--mount', `type=bind,src=${original}/client/fixture.private.json,dst=/private/fixture.private.json,readonly`,
    '--mount', `type=bind,src=${output},dst=/diagnostic`, NODE_IMAGE, 'node', '--max-old-space-size=96', '/diagnostic/diagnose-source-client.mjs'];
  clientCreated = true; const abort = new AbortController();
  timer = setInterval(() => { try { pressure(); } catch { abort.abort(); } }, 2000);
  try { await promisify(execFile)(CLI, args, { env, timeout: 200000, signal: abort.signal, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* Still collect bounded status written on an assertion failure. */ }
  clearInterval(timer); timer = undefined;
  assert(readFileSync(join(output, 'read-status.json')).length <= 8192);
  result = safe(json(join(output, 'read-status.json'))); accountOwnedTrees([original, source, output]);
} catch { result = { state: 'control-failed-or-unknown', rows: [], failureStage: stage, automaticRetry: false, mutationChecksReplayed: false }; }
finally {
  clearInterval(timer);
  if (clientCreated) try { assert.equal(inspect(client).Config.Labels?.['unfiltered.diagnostic'], id); run(['stop', '--time', '10', client]); assert.equal(inspect(client).State.Running, false); } catch { cleanup = false; }
  if (started) for (const service of ['server', 'redis', 'postgres']) try { const cid = services.get(service); owned(cid); run(['stop', '--time', '30', cid]); assert.equal(owned(cid).State.Running, false); } catch { cleanup = false; }
  writeFileSync(join(output, 'result.json'), JSON.stringify({ ...result, cleanupVerified: cleanup, automaticRetry: false, originalDrillReplayed: false, providerCalls: 0, cloudCalls: 0 }), { flag: 'wx', mode: 0o600 });
  if (!cleanup || result.state !== 'read-checks-passed-mutation-boundary-not-replayed') process.exitCode = 1;
}
