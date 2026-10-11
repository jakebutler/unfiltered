// Offline only: separate build-only architecture from deployment project config.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const args = process.argv.slice(2);
const reviewed = args.length === 8 && args[4] === '--reviewed-inventory-sha256' && args[6] === '--reviewed-function-config-sha256' && /^[a-f0-9]{64}$/.test(args[5]) && /^[a-f0-9]{64}$/.test(args[7]);
if ((args.length !== 4 && !reviewed) || args[0] !== '--stage' || args[2] !== '--output') {
  throw new Error('usage: explicit stage/output, optionally both root-reviewed inventory and function-config SHA256 pins');
}
const privateRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../.private'));
const stage = realpathSync(resolve(args[1]));
const destination = resolve(args[3]);
const inside = (path) => path.startsWith(privateRoot + sep);
if (!inside(stage) || !inside(destination) || realpathSync(dirname(destination)) !== dirname(destination)) {
  throw new Error('stage and new output must be inside checkout infra/cloud/.private without redirected parents');
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = readFileSync(join(stage, 'vercel.json'));
const buildConfig = JSON.parse(sourceBytes);
const apiServer = buildConfig.framework === null;
if (apiServer && !reviewed) throw new Error('api-server-requires-explicit-reviewed-pins');
const functionEntry = apiServer ? 'api/server.js' : 'server.cjs';
const functionPrefix = apiServer ? 'functions/api/server.func/' : 'functions/index.func/';
const expectedBuildConfig = apiServer ? {
  $schema: 'https://openapi.vercel.sh/vercel.json', framework: null, fluid: true,
  buildCommand: null, installCommand: '', rewrites: [{ source: '/(.*)', destination: '/api/server' }],
  functions: { 'api/server.js': { architecture: 'x86_64', maxDuration: 300, supportsCancellation: true,
    includeFiles: '{research-bootstrap.cjs,site-assets/**,asset-manifest.json,research-manifest.json,bin/**}' } },
} : {
  $schema: 'https://openapi.vercel.sh/vercel.json', framework: 'node', fluid: true,
  buildCommand: null, installCommand: '', functions: { 'server.cjs': {
    architecture: 'x86_64', maxDuration: 300, supportsCancellation: true,
    includeFiles: reviewed ? '{research-bootstrap.cjs,site-assets/**,asset-manifest.json,research-manifest.json,bin/**}' : '{site-assets/**,asset-manifest.json,research-manifest.json,bin/**}',
  } },
};
if (!isDeepStrictEqual(buildConfig, expectedBuildConfig)) throw new Error('unexpected-build-config');
const output = join(stage, '.vercel/output');
function inventory(directory, prefix = '') {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), nameInOutput = join(prefix, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('symlink-in-prebuilt-output');
    if (stat.isDirectory()) files.push(...inventory(path, nameInOutput));
    else if (stat.isFile()) {
      const bytes = readFileSync(path);
      files.push({ path: nameInOutput, bytes: bytes.length, sha256: sha(bytes) });
    } else throw new Error('unexpected-prebuilt-file-type');
  }
  return files;
}
const before = inventory(output);
const functionFiles = before.filter((file) => file.path.startsWith(functionPrefix));
const builderMetadata = new Set(['config.json', 'builds.json', 'diagnostics/cli_traces.json',
  'diagnostics/deploy-manifest.json', 'diagnostics/project-manifest.json']);
const functionBytes = functionFiles.reduce((sum, file) => sum + file.bytes, 0);
const reviewedInventoryMatches = reviewed && sha(JSON.stringify(before)) === args[5] && functionFiles.length <= 256 && functionBytes <= 250000000 && functionFiles.some(file => file.path === functionPrefix + 'research-bootstrap.cjs');
if ((reviewed ? !reviewedInventoryMatches : functionFiles.length !== 17 || functionBytes !== 144871288) ||
    before.some((file) => !builderMetadata.has(file.path) && !file.path.startsWith(functionPrefix))) {
  throw new Error('unexpected-reviewed-output-inventory');
}
if (apiServer) {
  const assetManifest = JSON.parse(readFileSync(join(output, functionPrefix, 'asset-manifest.json')));
  if (!assetManifest || !Array.isArray(assetManifest.files) || assetManifest.files.length > 32) throw new Error('invalid-pinned-asset-manifest');
  const frontendScripts = assetManifest.files.filter(file => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(file.path));
  if (frontendScripts.length !== 1) throw new Error('unexpected-pinned-frontend-entry');
  for (const file of assetManifest.files) {
    const physical = functionFiles.find(candidate => candidate.path === functionPrefix + 'site-assets/' + file.path);
    if (!physical || !/^[a-f0-9]{64}$/.test(file.digest) || physical.sha256 !== file.digest) throw new Error('pinned-asset-manifest-mismatch');
  }
  const allowed = ['.vc-config.json', 'api/server.js', 'package.json', 'research-bootstrap.cjs', 'research-manifest.json', 'asset-manifest.json',
    'bin/ffmpeg', 'bin/FFMPEG-LICENSE.txt', 'site-assets/assets/index-1m71vlPx.css', 'site-assets/' + frontendScripts[0].path,
    'site-assets/fonts/Inter-OFL.txt', 'site-assets/fonts/Inter-Variable.ttf', 'site-assets/fonts/SpaceGrotesk-OFL.txt',
    'site-assets/fonts/SpaceGrotesk-Variable.ttf', 'site-assets/index.html', 'site-assets/prototype/assets/index-D5HeaQuc.js',
    'site-assets/prototype/index.html', 'site-assets/research-capture.worklet.js'].sort();
  if (!isDeepStrictEqual(functionFiles.map(file => file.path.slice(functionPrefix.length)).sort(), allowed)) throw new Error('unexpected-api-function-physical-files');
}
const vc = JSON.parse(readFileSync(join(output, functionPrefix, '.vc-config.json')));
if (vc.handler !== functionEntry || vc.runtime !== 'nodejs22.x' || vc.architecture !== 'x86_64' ||
    vc.maxDuration !== 300 || vc.supportsCancellation !== true || vc.shouldAddHelpers !== apiServer ||
    !isDeepStrictEqual(vc.environment, {}) ||
    before.find((file) => file.path === functionPrefix + '.vc-config.json')?.sha256 !==
      (reviewed ? args[7] : 'aeb1fee2192b5abb585ff646f27fa5a67814511458b9cbe932594e3edf5cb08f')) {
  throw new Error('unexpected-reviewed-function-config');
}
const routing = JSON.parse(readFileSync(join(output, 'config.json')));
const expectedRouting = apiServer ? { version: 3, routes: [
  { handle: 'filesystem' },
  { src: '^(?:/(.*))$', dest: '/api/server', check: true, transforms: [{ type: 'request.path', op: 'set', args: '/$1' }] },
  { src: '^/api(/.*)?$', status: 404 }, { handle: 'error' },
  { status: 404, src: '^(?!/api).*$', dest: '/404.html' }, { handle: 'miss' },
  { src: '^/api/(.+)(?:\\.(?:js))$', dest: '/api/$1', check: true },
], crons: [] } : { version: 3, routes: [
  { handle: 'error' }, { status: 404, src: '^(?!/api).*$', dest: '/404.html' },
  { handle: 'filesystem' }, { src: '/(.*)', dest: '/', transforms: [
    { type: 'request.path', op: 'set', args: '/$1' },
  ] },
], crons: [] };
if (!isDeepStrictEqual(routing, expectedRouting)) throw new Error('unexpected-reviewed-routing');
const deploymentConfig = structuredClone(buildConfig);
delete deploymentConfig.functions[functionEntry].architecture;
const configBytes = Buffer.from(JSON.stringify(deploymentConfig, null, 2) + '\n');
const after = inventory(output);
if (!isDeepStrictEqual(before, after) || !readFileSync(join(stage, 'vercel.json')).equals(sourceBytes)) {
  throw new Error('original-stage-changed-during-preparation');
}
// Exclusive creation preserves prior attempts, candidates and platform output.
mkdirSync(destination);
writeFileSync(join(destination, 'vercel.deploy.json'), configBytes, { flag: 'wx' });
const receipt = {
  schema: 1, state: 'prebuilt-deploy-config-prepared-hosted-unqualified',
  stage: relative(privateRoot, stage), outputFiles: before,
  functionFileCount: functionFiles.length, functionBytes,
  verification: reviewed ? 'explicit-root-reviewed-sha256-pins' : 'candidate-c-fixed-pins',
  outputInventorySha256: sha(JSON.stringify(before)), beforeAfterOutputIdentical: true,
  originalBuildConfigSha256: sha(sourceBytes), deployConfigSha256: sha(configBytes),
  removedProperty: `functions.${functionEntry}.architecture`,
  entryMode: apiServer ? 'api-server' : 'listener', noPublicFilesystemAssets: apiServer,
  preservedFunctionArchitecture: vc.architecture, providersActivated: false,
  cloudCalls: 0, hostedAccepted: false,
};
writeFileSync(join(destination, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ config: join(destination, 'vercel.deploy.json'),
  receipt: join(destination, 'receipt.json'), outputInventorySha256: receipt.outputInventorySha256,
  beforeAfterOutputIdentical: true, cloudCalls: 0 }));
