import { build } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeploymentManifest } from '../manifest.schema.ts';
import { publicExample, newPrivateOutput } from '../io.mjs';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const arg = name => { const at = process.argv.indexOf(name); if (at < 0 || !process.argv[at + 1]) throw new Error('explicit-packaging-arguments-required'); return process.argv[at + 1]; };
if (process.versions.node !== '22.22.3') throw new Error('pinned-node-22.22.3-required');
const profile = parseDeploymentManifest(publicExample(root, arg('--manifest'))), output = newPrivateOutput(root, arg('--output')), platform = arg('--platform');
if (profile.product !== 'clinic') throw new Error('clinic-profile-required');
const lock = JSON.parse(readFileSync(join(root, 'infra/aws/clinic/images.lock.json'), 'utf8'));
if (!Object.hasOwn(lock.platforms, platform) || !/^sha256:[a-f0-9]{64}$/.test(lock.platforms[platform])) throw new Error('locked-platform-required');
const image = `${lock.repository}:${lock.tag}@${lock.platforms[platform]}`;
mkdirSync(output, { recursive: true, mode: 0o700 });
const receipt = { schema: 1, state: 'building', platform, baseImage: image, buildNode: process.version, packageLockHash: '', profileHash: '', artifactHash: '', files: [], sourceFiles: [], cloudCalls: 0, providersEnabled: false };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
receipt.packageLockHash = sha(readFileSync(join(root, 'package-lock.json')));
const save = () => writeFileSync(join(output, 'package-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
save();
const sourceFiles = new Map();
const trace = { name: 'aws-source-trace', generateBundle() { for (const raw of this.getModuleIds()) {
  const path = raw.split('?')[0];
  if (path.startsWith(root + '/') && !path.includes('/node_modules/') && existsSync(path)) {
    if (/holdout|\.private|\.env/i.test(relative(root, path))) throw new Error('private-source-in-package');
    if (lstatSync(path).isFile()) sourceFiles.set(relative(root, path), sha(readFileSync(path)));
  }
} } };
try {
  // envDir and envPrefix both disable discovery/injection of ambient private Vite configuration.
  await build({ configFile: false, root: join(root, 'apps/clinic'), envDir: false, envPrefix: [], plugins: [trace], mode: 'production', build: { outDir: join(output, 'public'), emptyOutDir: true, sourcemap: false } });
  await build({ configFile: false, root, envDir: false, envPrefix: [], plugins: [trace], mode: 'production', ssr: { noExternal: true }, build: { ssr: join(root, 'infra/aws/clinic/entry.ts'), outDir: output, emptyOutDir: false, sourcemap: false, target: 'node22', minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'server.cjs', inlineDynamicImports: true } } } });
  const assets = [];
  const walk = (directory, prefix = '') => { for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), stat = lstatSync(path), short = prefix + name;
    if (stat.isSymbolicLink()) throw new Error('symlinks-forbidden');
    if (stat.isDirectory()) walk(path, short + '/');
    else {
      if (!/\.(?:html|js|css|svg|png|jpe?g|webp|ico|woff2?|ttf)$/.test(short) && !/^fonts\/(?:Inter|SpaceGrotesk)-OFL\.txt$/.test(short)) throw new Error('unexpected-public-artifact');
      assets.push({ path: short, digest: sha(readFileSync(path)) });
    }
  } };
  walk(join(output, 'public'));
  if (assets.length > 200 || assets.reduce((n, a) => n + lstatSync(join(output, 'public', a.path)).size, 0) > 10_000_000) throw new Error('public-artifact-envelope-exceeded');
  writeFileSync(join(output, 'asset-manifest.json'), `${JSON.stringify({ files: assets }, null, 2)}\n`);
  writeFileSync(join(output, 'deployment-manifest.json'), `${JSON.stringify(profile, null, 2)}\n`);
  writeFileSync(join(output, 'launcher.cjs'), readFileSync(join(root, 'infra/aws/clinic/launcher.cjs')));
  writeFileSync(join(output, 'Dockerfile'), readFileSync(join(root, 'infra/aws/clinic/Dockerfile'), 'utf8').replace(/^ARG NODE_IMAGE=.*$/m, `ARG NODE_IMAGE=${image}`).replace('FROM ${NODE_IMAGE}', 'FROM --platform=' + platform + ' ${NODE_IMAGE}'));
  writeFileSync(join(output, '.dockerignore'), '*\n!Dockerfile\n!server.cjs\n!launcher.cjs\n!asset-manifest.json\n!deployment-manifest.json\n!public/\n!public/**\n');
  const paths = ['Dockerfile', '.dockerignore', 'server.cjs', 'launcher.cjs', 'asset-manifest.json', 'deployment-manifest.json', ...assets.map(a => `public/${a.path}`)].sort();
  receipt.files = paths.map(path => ({ path, sha256: sha(readFileSync(join(output, path))) }));
  receipt.sourceFiles = [...sourceFiles].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
  receipt.profileHash = sha(readFileSync(join(output, 'deployment-manifest.json')));
  receipt.artifactHash = sha(JSON.stringify(receipt.files));
  receipt.state = 'packaged-container-unbuilt'; save();
  console.log(JSON.stringify({ state: receipt.state, output, platform, baseImage: image, artifactHash: receipt.artifactHash, files: paths.length, cloudCalls: 0 }));
} catch { receipt.state = 'failed-retain-output'; save(); throw new Error('aws-clinic-packaging-failed-retain-output'); }
