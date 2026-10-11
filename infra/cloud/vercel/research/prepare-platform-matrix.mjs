// Offline-only temporary protected matrix; preserves all deployed E function bytes.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const privateRoot = path.join(root, 'infra/cloud/.private');
const base = path.join(privateRoot, 'research-stage-20261010-e');
const output = path.join(base, '.vercel/output');
const destination = path.join(privateRoot, 'research-stage-20261010-f');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(directory, prefix = '') {
  return fs.readdirSync(directory).sort().flatMap(name => {
    const absolute = path.join(directory, name), relative = path.posix.join(prefix, name), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('symlink-rejected');
    if (stat.isDirectory()) return inventory(absolute, relative);
    if (!stat.isFile()) throw new Error('non-file-rejected');
    const bytes = fs.readFileSync(absolute);
    return [{ path: relative, bytes: bytes.length, sha256: sha(bytes) }];
  });
}
const before = inventory(output);
assert.equal(sha(JSON.stringify(before)), 'ce75f29b3eb260c3bf753731e8a145b719a8d62f7160b9ecf2214e5ff03ae4b2');
const originalConfig = JSON.parse(fs.readFileSync(path.join(output, 'config.json')));
const originalNativeConfig = JSON.parse(fs.readFileSync(path.join(output, 'functions/index.func/.vc-config.json')));
const originalOrdinaryConfig = JSON.parse(fs.readFileSync(path.join(output, 'functions/api/diagnostic.func/.vc-config.json')));
const specifications = [
  { kind: 'standard-x64', architecture: 'x86_64', route: '/__diagnostic/ordinary-x64', functionPath: 'api/matrix-standard-x64.func', emittedPath: 'api/matrix-standard-x64.func', native: false },
  { kind: 'native-arm', architecture: 'arm64', route: '/__diagnostic/native-arm', functionPath: 'diagnostic-native-arm.func', emittedPath: 'index.func', native: true },
  { kind: 'native-x64', architecture: 'x86_64', route: '/__diagnostic/native-x64', functionPath: 'diagnostic-native-x64.func', emittedPath: 'index.func', native: true },
];
const checked = [];
for (const spec of specifications) {
  const build = path.join(privateRoot, `research-matrix-${spec.kind}-20261010-f/.vercel/output`);
  const directory = path.join(build, 'functions', spec.emittedPath);
  const files = inventory(directory);
  assert.ok(files.length <= 8 && files.reduce((sum, file) => sum + file.bytes, 0) <= 131072);
  const config = JSON.parse(fs.readFileSync(path.join(directory, '.vc-config.json')));
  assert.deepEqual(config, { ...(spec.native ? originalNativeConfig : originalOrdinaryConfig),
    architecture: spec.architecture, maxDuration: 30,
    handler: spec.native ? 'server.cjs' : 'api/matrix-standard-x64.js' });
  const builds = JSON.parse(fs.readFileSync(path.join(build, 'builds.json')));
  const builders = builds.builds.map(item => item.use);
  assert.ok(builders.includes(spec.native ? '@vercel/backends' : '@vercel/node'));
  const source = fs.readFileSync(path.join(directory, config.handler));
  const events = [], exported = { exports: {} }, forbidden = new Proxy({}, { get() { throw new Error('forbidden-request-or-env-read'); } });
  let listener, listens = 0;
  const server = { listen(port) { assert.equal(port, 3000); listens += 1; return server; } };
  const requireBuiltin = name => { assert.equal(name, 'node:http'); return { createServer(callback) { listener = callback; return server; } }; };
  exported.require = requireBuiltin;
  const sandbox = { module: exported, exports: exported.exports, process: forbidden,
    require: requireBuiltin, console: { info: value => events.push(JSON.parse(value)) } };
  vm.runInNewContext(source.toString(), sandbox, { timeout: 1000, displayErrors: false });
  const handler = spec.native ? listener : exported.exports;
  if (spec.native) { assert.equal(exported.exports, server); assert.equal(listens, 1); }
  let status, headers, body;
  handler(forbidden, { writeHead(code, value) { status = code; headers = value; }, end(value) { body = value; } });
  assert.equal(status, 200); assert.equal(headers['Cache-Control'], 'no-store');
  const expectedBody = spec.native ? '{"schema":1,"diagnostic":"native-node22","status":"ok"}\n' : '{"schema":1,"diagnostic":"ordinary-node22-x64","status":"ok"}\n';
  assert.equal(body, expectedBody);
  assert.deepEqual(events, spec.native ? ['entry', 'listen-called', 'invoked'].map(event => ({ component: 'research-platform-matrix', kind: 'native', event, schema: 1 })) : [{ component: 'research-platform-matrix', kind: 'ordinary-x64', event: 'invoked', schema: 1 }]);
  checked.push({ ...spec, directory, files, config, builders, expectedBody, expectedBodySha256: sha(expectedBody), handlerSha256: sha(source), checks: { actualEmittedHandler: true, fixedResponse: true, deniedRequestAndEnvironmentReads: true, nativeListenExport: spec.native } });
}
const native = checked.filter(item => item.native);
assert.equal(native[0].handlerSha256, native[1].handlerSha256);
assert.deepEqual(native[0].files.filter(file => file.path !== '.vc-config.json'), native[1].files.filter(file => file.path !== '.vc-config.json'));
const additionalRoutes = checked.map(item => ({ src: `^${item.route}$`, dest: `/${item.functionPath.slice(0, -5)}` }));
const routing = { ...originalConfig, routes: [...additionalRoutes, ...originalConfig.routes] };
assert.deepEqual(routing.routes.slice(3), originalConfig.routes);
for (const route of additionalRoutes) assert.equal(new RegExp(route.src).test(route.src.slice(1, -1) + '/extra'), false);
fs.mkdirSync(destination); fs.mkdirSync(path.join(destination, '.vercel'));
fs.cpSync(output, path.join(destination, '.vercel/output'), { recursive: true, force: false, errorOnExist: true });
fs.copyFileSync(path.join(base, '.vercel/project.json'), path.join(destination, '.vercel/project.json'), fs.constants.COPYFILE_EXCL);
fs.copyFileSync(path.join(base, 'vercel.deploy.json'), path.join(destination, 'vercel.deploy.json'), fs.constants.COPYFILE_EXCL);
for (const item of checked) {
  const target = path.join(destination, '.vercel/output/functions', item.functionPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(item.directory, target, { recursive: true, force: false, errorOnExist: true });
}
fs.writeFileSync(path.join(destination, '.vercel/output/config.json'), JSON.stringify(routing, null, 2) + '\n');
const after = inventory(output), composed = inventory(path.join(destination, '.vercel/output'));
assert.deepEqual(after, before);
const added = checked.map(item => `functions/${item.functionPath}/`);
assert.deepEqual(composed.filter(file => file.path !== 'config.json' && !added.some(prefix => file.path.startsWith(prefix))), before.filter(file => file.path !== 'config.json'));
const receipt = {
  schema: 1, state: 'protected-platform-matrix-prepared-not-deployed',
  base: 'research-stage-20261010-e', stage: 'research-stage-20261010-f',
  baseInventorySha256: sha(JSON.stringify(before)), outputInventorySha256: sha(JSON.stringify(composed)),
  unchangedBase: true, unchangedExistingFunctionBytes: true, identicalNativeHandlerBytes: true,
  routesAdded: additionalRoutes, originalConfig, outputConfig: routing,
  functions: checked.map(({ directory, ...item }) => item), outputFiles: composed,
  limitations: ['VM listen interception is not platform invocation', 'Inherited E build metadata describes its original CLI build; this receipt describes additive matrix composition'],
  providerCalls: 0, environmentPulls: 0, deploymentMutations: 0,
};
fs.writeFileSync(path.join(destination, 'diagnostic-matrix-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ stage: destination, outputInventorySha256: receipt.outputInventorySha256, unchangedExistingFunctionBytes: true, identicalNativeHandlerBytes: true, actualOutputChecksPassed: 3 }));
