// Offline, one-time pathname preservation for the emitted standard API function.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const privateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.private');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--stage')) throw new Error('explicit-private-stage-required');
const stage = args.length ? path.resolve(args[1]) : path.join(privateRoot, 'research-stage-20261010-g');
if (!stage.startsWith(privateRoot + path.sep) || fs.realpathSync(stage) !== stage) throw new Error('private-stage-without-redirected-parents-required');
const file = path.join(stage, '.vercel/output/config.json');
const original = fs.readFileSync(file);
const config = JSON.parse(original);
assert.deepEqual(config, { version: 3, routes: [
  { handle: 'filesystem' },
  { src: '^(?:/(.*))$', dest: '/api/server', check: true },
  { src: '^/api(/.*)?$', status: 404 },
  { handle: 'error' },
  { status: 404, src: '^(?!/api).*$', dest: '/404.html' },
  { handle: 'miss' },
  { src: '^/api/(.+)(?:\\.(?:js))$', dest: '/api/$1', check: true },
], crons: [] });
// Reuse the documented low-level path transform emitted by the native builder.
config.routes[1].transforms = [{ type: 'request.path', op: 'set', args: '/$1' }];
const routes = ['/', '/participate', '/staff/operator', '/api/research/interview', '/capture/segment', '/.env.local'];
for (const route of routes) {
  const match = route.match(new RegExp(config.routes[1].src));
  assert.ok(match); assert.equal(config.routes[1].transforms[0].args.replace('$1', match[1]), route);
}
const staticRoot = path.join(stage, '.vercel/output/static');
const functionRoot = path.join(stage, '.vercel/output/functions/api/server.func');
const hash = value => createHash('sha256').update(value).digest('hex');
// CLI may deduplicate included assets into static and reference them at runtime.
// Materialize only exact identity mappings before removing that public surface.
const functionConfigPath = path.join(functionRoot, '.vc-config.json');
const originalFunctionConfig = fs.readFileSync(functionConfigPath);
const functionConfig = JSON.parse(originalFunctionConfig);
const materialized = [];
if (functionConfig.filePathMap !== undefined) {
  const map = functionConfig.filePathMap;
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'asset-manifest.json')));
  const allowed = new Set(['asset-manifest.json', 'research-manifest.json', 'bin/FFMPEG-LICENSE.txt', ...manifest.files.map(asset => 'site-assets/' + asset.path)]);
  assert.ok(map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length <= 32);
  for (const [destination, source] of Object.entries(map)) {
    assert.equal(source, destination); assert.ok(allowed.has(destination));
    assert.ok(destination.split('/').every(part => part && part !== '.' && part !== '..'));
    const from = path.join(staticRoot, source), to = path.join(functionRoot, destination);
    const stat = fs.lstatSync(from); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(fs.existsSync(to), false);
    const originalAsset = fs.readFileSync(path.join(stage, destination));
    assert.equal(hash(fs.readFileSync(from)), hash(originalAsset));
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
    materialized.push({ path: destination, bytes: stat.size, sha256: hash(originalAsset) });
  }
  fs.writeFileSync(path.join(stage, 'cli-function-config-original.json'), originalFunctionConfig, { flag: 'wx' });
  delete functionConfig.filePathMap;
  fs.writeFileSync(functionConfigPath, JSON.stringify(functionConfig, null, 2) + '\n');
}
function inventory(directory, prefix = '') {
  return fs.readdirSync(directory).sort().flatMap(name => {
    const absolute = path.join(directory, name), relative = path.posix.join(prefix, name), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('symlink-rejected');
    if (stat.isDirectory()) return inventory(absolute, relative);
    if (!stat.isFile()) throw new Error('unexpected-output-file');
    const bytes = fs.readFileSync(absolute);
    return [{ path: relative, bytes: bytes.length, sha256: hash(bytes) }];
  });
}
const functionFiles = inventory(functionRoot), staticFiles = inventory(staticRoot);
const expectedStatic = functionFiles.filter(file => !['.vc-config.json', 'api/server.js', 'package.json'].includes(file.path));
assert.deepEqual(staticFiles, expectedStatic);
assert.ok(staticFiles.length > 0 && staticFiles.length <= 256);
assert.equal(fs.existsSync(path.join(stage, 'cli-static-original')), false);
fs.writeFileSync(path.join(stage, 'cli-routing-original.json'), original, { flag: 'wx' });
fs.renameSync(staticRoot, path.join(stage, 'cli-static-original'));
assert.equal(fs.existsSync(staticRoot), false);
const revised = Buffer.from(JSON.stringify(config, null, 2) + '\n');
fs.writeFileSync(file, revised);
const sha = value => createHash('sha256').update(value).digest('hex');
const receipt = { schema: 1, state: 'api-pathname-routing-prepared-hosted-unqualified',
  originalSha256: sha(original), preparedSha256: sha(revised),
  change: 'routes[1].transforms', originalConfig: JSON.parse(original), preparedConfig: config,
  checkedOriginalPathnames: routes, excludedStaticFiles: staticFiles, staticPreservedAt: 'cli-static-original', noPublicFilesystemAssets: true, cloudCalls: 0, hostedAccepted: false };
receipt.materializedIdentityMappings = materialized;
fs.writeFileSync(path.join(stage, 'api-routing-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ state: receipt.state, originalSha256: receipt.originalSha256, preparedSha256: receipt.preparedSha256, noPublicFilesystemAssets: true }));
