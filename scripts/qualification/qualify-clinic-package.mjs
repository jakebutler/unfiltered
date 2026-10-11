/** Root-coordinated local artifact smoke. Synthetic config; outbound fetch is denied. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

let directory = resolve(process.argv[2] ?? '');
const browserFixture = process.argv.includes('--browser-worklet');
const packaged = JSON.parse(readFileSync(join(directory, 'package-receipt.json'), 'utf8'));
assert.equal(packaged.state, 'packaged-unqualified');
const origin = 'https://clinic.example';
const config = {
  origin, medplumBaseUrl: 'https://api.medplum.com/', projectId: '13eaac67-a2c3-4aa1-aa9e-590a083e5fef', clientId: '50db76bd-d099-4305-8ec3-7439ffc38ca1', clientSecret: 'synthetic-client-secret', cookieSecret: 'synthetic-cookie-secret-at-least-32-characters', mentalHealth: 'phq4',
  patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(scenario => [scenario, { reference: 'Patient/primary', displayName: 'Alex (synthetic)', description: 'Synthetic clinic fixture.', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/administrative' } }])),
  staff: ['physician', 'registered-dietitian', 'administrative', 'physician'].map((role, index) => ({ membershipId: `member-${index}`, profile: `Practitioner/staff-${index}`, policy: `AccessPolicy/policy-${index}`, name: `Synthetic staff ${index}`, role, patients: [index === 3 ? 'Patient/unrelated' : 'Patient/primary'], careTeams: [] })),
  storageQualification: { signature: 'a'.repeat(64), payload: { schema: 2, purpose: 'synthetic-clinic-conditional-resumable', deliveryContract: 'conditional-resumable-v1', mode: 'live', origin, expiresAt: new Date(Date.now() + 3600000).toISOString(), identity: { endpoint: 'https://api.medplum.com/fhir/R4/', projectId: '13eaac67-a2c3-4aa1-aa9e-590a083e5fef', clientId: '50db76bd-d099-4305-8ec3-7439ffc38ca1', membershipId: '6e565de2-837d-4618-9578-f6428fbb0be1' } } },
};
const id = `hosting-package-${randomUUID()}`, scratch = mkdtempSync(join(tmpdir(), 'corvo-package-smoke-'));
const report = { id, at: new Date().toISOString(), state: 'running', serverSha256: createHash('sha256').update(readFileSync(join(directory, 'server.cjs'))).digest('hex'), providersEnabled: false, outboundFetchAttempts: 0, checks: [] };
const receipt = `docs/implementation/evidence/${id}.json`;
writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
if (browserFixture) {
  const copy = join(scratch, 'package'); cpSync(directory, copy, { recursive: true }); directory = copy;
  const manifest = JSON.parse(readFileSync(join(directory, 'asset-manifest.json'), 'utf8'));
  for (const [source, target] of [['worklet-csp.html', 'index.html'], ['worklet-csp.js', 'worklet-csp.js']]) {
    const body = readFileSync(new URL(`./fixtures/${source}`, import.meta.url));
    writeFileSync(join(directory, 'public', target), body);
    manifest.files = manifest.files.filter(item => item.path !== target);
    manifest.files.push({ path: target, digest: createHash('sha256').update(body).digest('hex') });
  }
  writeFileSync(join(directory, 'asset-manifest.json'), JSON.stringify(manifest));
  report.fixtureChanges = ['index.html replaced with isolated test UI', 'worklet-csp.js added'];
}
const preload = join(scratch, 'guard.cjs');
writeFileSync(preload, `const http = require('node:http');
globalThis.fetch = async () => { process.send?.({outboundDenied:true}); throw new Error('artifact-smoke-outbound-fetch-denied'); };
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function() { const value = listen.call(this, 0, '127.0.0.1'); this.once('listening', () => process.send?.({port:this.address().port})); return value; };
`);
const child = spawn(process.execPath, ['--max-old-space-size=512', '--require', preload, join(directory, 'server.cjs')], { cwd: scratch, env: { NODE_ENV: 'production', CLINIC_CONFIG_JSON: JSON.stringify(config), PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let diagnostics = '';
child.stdout.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8000); });
child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8000); });
child.on('message', message => { if (message.outboundDenied) report.outboundFetchAttempts++; });
const closed = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
const check = (name, truth) => { assert(truth, name); report.checks.push(name); };
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('artifact-start-timeout')), 15000);
    child.on('message', message => { if (message.port) { clearTimeout(timeout); resolve(message.port); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('artifact-start-failed')); });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = path => fetch(base + path, { signal: AbortSignal.timeout(5000) });
  if (browserFixture) {
    report.csp = (await request('/')).headers.get('content-security-policy');
    report.workletSha256 = createHash('sha256').update(await (await request('/clinic-capture.worklet.js')).bytes()).digest('hex');
    console.log(JSON.stringify({ fixtureUrl: base, receipt, serverSha256: report.serverSha256, workletSha256: report.workletSha256, csp: report.csp, instruction: 'Use the visible Run worklet check button, read its result, then send done on stdin. Fixture expires in 180 seconds.' }));
    await new Promise(resolve => { const timer = setTimeout(resolve, 180000); process.stdin.once('data', () => { clearTimeout(timer); resolve(); }); });
    process.stdin.pause();
    check('no-outbound-fetch-attempt', report.outboundFetchAttempts === 0);
    report.state = 'browser-fixture-served-observation-separate';
  } else {
  for (const path of ['/', '/staff']) {
    const response = await request(path), html = await response.text();
    check(`page:${path}`, response.status === 200 && html.includes('Corvo Clinic') && html.includes('/assets/'));
    check(`csp:${path}`, response.headers.get('content-security-policy')?.includes("connect-src 'self' wss://clinic.example"));
  }
  const settings = await (await request('/api/clinic/config')).json();
  check('guided-mode', settings.conversation?.mode === 'guided');
  check('voice-disabled', settings.voice?.available === false);
  check('unknown-api-json-404', (await request('/api/not-found')).status === 404);
  for (const path of ['/.env.local', '/server.cjs', '/asset-manifest.json', '/package-receipt.json', '/package.json']) check(`private-path-denied:${path}`, (await request(path)).status === 404);
  const manifest = JSON.parse(readFileSync(join(directory, 'asset-manifest.json'), 'utf8'));
  for (const asset of manifest.files) {
    const response = await request('/' + asset.path), bytes = new Uint8Array(await response.arrayBuffer());
    check(`asset-integrity:${asset.path}`, response.status === 200 && createHash('sha256').update(bytes).digest('hex') === asset.digest);
  }
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/clinic/speech/input', { headers: { origin } });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('upgrade-timeout')); }, 5000);
    socket.on('error', () => undefined);
    socket.once('open', () => { clearTimeout(timeout); socket.terminate(); reject(new Error('unexpected-upgrade')); });
    socket.once('unexpected-response', (_request, response) => { clearTimeout(timeout); response.resume(); socket.terminate(); try { check('upgrade-denied-503', response.statusCode === 503); resolve(); } catch (error) { reject(error); } });
  });
  check('no-outbound-fetch-attempt', report.outboundFetchAttempts === 0);
  report.state = 'passed-local-artifact-smoke';
  }
} catch (error) {
  report.state = 'failed-local-artifact-smoke'; report.failure = error instanceof Error ? error.message : 'unknown';
  // All child input is the public synthetic fixture; diagnostics never contain live configuration.
  if (diagnostics) report.diagnostics = diagnostics;
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 2000);
  report.processExit = await closed; clearTimeout(force);
  rmSync(scratch, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ receipt, state: report.state, checks: report.checks.length, outboundFetchAttempts: report.outboundFetchAttempts, failure: report.failure, processExit: report.processExit }));
}
