// Offline composition only. Temporary diagnostics never change the frozen research function.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const privateRoot = path.join(root, 'infra/cloud/.private');
const original = path.join(privateRoot, 'research-stage-20261010-d2');
const standard = path.join(privateRoot, 'research-standard-diagnostic-20261010-e2/.vercel/output');
const destination = path.join(privateRoot, 'research-stage-20261010-e');
const originalOutput = path.join(original, '.vercel/output');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(directory, prefix = '') {
  return fs.readdirSync(directory).sort().flatMap(name => {
    const absolute = path.join(directory, name), relative = path.posix.join(prefix, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('symlink-rejected');
    if (stat.isDirectory()) return inventory(absolute, relative);
    if (!stat.isFile()) throw new Error('non-file-rejected');
    const bytes = fs.readFileSync(absolute);
    return [{ path: relative, bytes: bytes.length, sha256: sha(bytes) }];
  });
}
const before = inventory(originalOutput);
assert.equal(sha(JSON.stringify(before)), '6b2cc2f03c093e086f8067e1103602b2043bb40e357576c10ef19aad34f3aa08');
const standardFunction = path.join(standard, 'functions/api/diagnostic.func');
const standardFiles = inventory(standardFunction);
assert.deepEqual(standardFiles.map(x => x.path), ['.vc-config.json', 'api/diagnostic.js', 'package.json']);
const standardConfig = JSON.parse(fs.readFileSync(path.join(standardFunction, '.vc-config.json')));
assert.deepEqual(standardConfig, {
  handler: 'api/diagnostic.js', runtime: 'nodejs22.x', architecture: 'arm64', maxDuration: 30,
  environment: {}, shouldDisableAutomaticFetchInstrumentation: false, launcherType: 'Nodejs',
  shouldAddHelpers: true, shouldAddSourcemapSupport: false, awsLambdaHandler: '',
});
const source = fs.readFileSync(path.join(root, 'infra/cloud/vercel/research/diagnostic-platform/function.cjs'));
assert.deepEqual(fs.readFileSync(path.join(standardFunction, standardConfig.handler)), source);
// Execute the actual emitted handler with forbidden request/env/import access.
const events = [], exported = { exports: {} };
const forbidden = new Proxy({}, { get() { throw new Error('forbidden-access'); } });
const sandbox = { module: exported, console: { info: value => events.push(value) }, process: forbidden,
  require() { throw new Error('forbidden-import'); } };
vm.runInNewContext(source.toString(), sandbox, { timeout: 1000, displayErrors: false });
let status, headers, response;
exported.exports(forbidden, { writeHead(code, value) { status = code; headers = value; }, end(value) { response = value; } });
assert.equal(status, 200);
assert.equal(headers['Cache-Control'], 'no-store');
assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
assert.equal(response, '{"schema":1,"diagnostic":"standard-node22","status":"ok"}\n');
assert.deepEqual(events, ['{"component":"research-platform-diagnostic","event":"invoked","schema":1}']);
const staticBytes = fs.readFileSync(path.join(root, 'infra/cloud/vercel/research/diagnostic-platform/static.txt'));
assert.equal(staticBytes.toString(), 'research-platform-static-ok\n');
const originalConfig = JSON.parse(fs.readFileSync(path.join(originalOutput, 'config.json')));
const additionalRoutes = [
  { src: '^/__diagnostic/static$', dest: '/__diagnostic/static.txt', headers: { 'Cache-Control': 'no-store' } },
  { src: '^/__diagnostic/function$', dest: '/api/diagnostic' },
];
const config = { ...originalConfig, routes: [...additionalRoutes, ...originalConfig.routes] };
assert.deepEqual(config.routes.slice(2), originalConfig.routes);
for (const [url, expected] of [['/__diagnostic/static', '/__diagnostic/static.txt'], ['/__diagnostic/function', '/api/diagnostic']]) {
  assert.equal(additionalRoutes.find(r => new RegExp(r.src).test(url))?.dest, expected);
  assert.equal(additionalRoutes.some(r => new RegExp(r.src).test(`${url}/extra`)), false);
}
// Exclusive destination; any partial/error artifact is preserved for diagnosis.
fs.mkdirSync(destination);
fs.mkdirSync(path.join(destination, '.vercel'));
fs.cpSync(originalOutput, path.join(destination, '.vercel/output'), { recursive: true, errorOnExist: true, force: false });
fs.copyFileSync(path.join(original, '.vercel/project.json'), path.join(destination, '.vercel/project.json'), fs.constants.COPYFILE_EXCL);
fs.copyFileSync(path.join(privateRoot, 'research-deploy-config-20261010-d2/vercel.deploy.json'), path.join(destination, 'vercel.deploy.json'), fs.constants.COPYFILE_EXCL);
fs.mkdirSync(path.join(destination, '.vercel/output/functions/api'));
fs.cpSync(standardFunction, path.join(destination, '.vercel/output/functions/api/diagnostic.func'), { recursive: true, errorOnExist: true, force: false });
fs.mkdirSync(path.join(destination, '.vercel/output/static/__diagnostic'), { recursive: true });
fs.writeFileSync(path.join(destination, '.vercel/output/static/__diagnostic/static.txt'), staticBytes, { flag: 'wx' });
fs.writeFileSync(path.join(destination, '.vercel/output/config.json'), JSON.stringify(config, null, 2) + '\n');
const after = inventory(originalOutput), composed = inventory(path.join(destination, '.vercel/output'));
assert.deepEqual(after, before);
assert.deepEqual(composed.filter(x => x.path.startsWith('functions/index.func/')), before.filter(x => x.path.startsWith('functions/index.func/')));
assert.deepEqual(composed.filter(x => !x.path.startsWith('functions/api/diagnostic.func/') && !x.path.startsWith('static/') && x.path !== 'config.json'), before.filter(x => x.path !== 'config.json'));
const receipt = {
  schema: 1, state: 'temporary-protected-platform-diagnostic-prepared-not-deployed',
  base: 'research-stage-20261010-d2', stage: 'research-stage-20261010-e',
  baseInventorySha256: sha(JSON.stringify(before)), outputInventorySha256: sha(JSON.stringify(composed)),
  unchangedBase: true, unchangedResearchFunction: true, routesAdded: additionalRoutes,
  standardBuilder: '@vercel/node', standardFunctionConfig: standardConfig, standardFunctionFiles: standardFiles,
  originalConfig, outputConfig: config, outputFiles: composed,
  offlineChecks: { actualEmittedHandler: true, exactResponse: true, forbiddenRequestEnvImport: true, exactRoutes: true },
  limitations: ['No hosted request or deployment', 'CLI child dependency step used host Node24; no dependencies installed; emitted runtime Node22', 'Preserved base build metadata describes D2; this receipt records the additive E composition'],
  providerCalls: 0, environmentReads: 0, deployed: false,
};
fs.writeFileSync(path.join(destination, 'diagnostic-platform-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ stage: destination, receipt: 'diagnostic-platform-receipt.json', outputInventorySha256: receipt.outputInventorySha256, unchangedResearchFunction: true, actualEmittedHandlerPassed: true }));
