import { build } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local packaging only: no Vercel CLI, credential reads, remote builds or deploys.
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const index = process.argv.indexOf('--output');
if (index < 0 || !process.argv[index + 1]) throw new Error('explicit-new-output-directory-required');
const output = resolve(process.argv[index + 1]);
if (existsSync(output) || !output.startsWith(`${root}/infra/cloud/.private/`)) throw new Error('new-ignored-output-directory-required');
mkdirSync(output, { recursive: true, mode: 0o700 });
const manifest = { schema: 1, state: 'building', at: new Date().toISOString(), providersEnabled: false, cloudCalls: 0, files: [] };
const save = () => writeFileSync(join(output, 'package-receipt.json'), `${JSON.stringify(manifest, null, 2)}\n`);
save();
try {
  await build({ configFile: false, root: join(root, 'apps/clinic'), envDir: false, mode: 'production', build: { outDir: join(output, 'public'), emptyOutDir: true, sourcemap: false } });
  await build({ configFile: false, root, envDir: false, mode: 'production', ssr: { noExternal: true }, build: { ssr: join(root, 'infra/cloud/vercel/server.ts'), outDir: output, emptyOutDir: false, sourcemap: false, target: 'node22', minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'server.cjs', inlineDynamicImports: true } } } });
  const assets = [];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('symlinks-not-allowed-in-deployment');
      if (stat.isDirectory()) walk(path);
      else {
        const short = relative(join(output, 'public'), path);
        if (!/\.(?:html|js|css|svg|png|jpe?g|webp|ico|woff2?|ttf)$/.test(short) && !/^fonts\/(?:Inter|SpaceGrotesk)-OFL\.txt$/.test(short)) throw new Error('unexpected-public-build-file');
        assets.push({ path: short, digest: createHash('sha256').update(readFileSync(path)).digest('hex') });
      }
    }
  }
  walk(join(output, 'public'));
  writeFileSync(join(output, 'asset-manifest.json'), `${JSON.stringify({ files: assets }, null, 2)}\n`);
  writeFileSync(join(output, 'package.json'), `${JSON.stringify({ name: 'corvo-clinic-synthetic-demo', version: '0.1.0', private: true, type: 'commonjs', engines: { node: '22.x' }, scripts: { start: 'node server.cjs' } }, null, 2)}\n`);
  writeFileSync(join(output, 'vercel.json'), `${JSON.stringify({ $schema: 'https://openapi.vercel.sh/vercel.json', framework: null, fluid: true, buildCommand: '', installCommand: '', functions: { 'server.cjs': { maxDuration: 300, supportsCancellation: true, includeFiles: '{public/**,asset-manifest.json}' } } }, null, 2)}\n`);
  writeFileSync(join(output, '.vercelignore'), '.env*\n*.log\n');
  manifest.state = 'packaged-unqualified';
  manifest.files = ['server.cjs', 'asset-manifest.json', 'package.json', 'vercel.json', '.vercelignore', ...assets.map(asset => `public/${asset.path}`)];
  save();
  console.log(JSON.stringify({ status: manifest.state, output, files: manifest.files.length, providersEnabled: false, cloudCalls: 0 }));
} catch { manifest.state = 'failed-retain-output'; save(); throw new Error('clinic-packaging-failed-inspect-retained-local-output'); }
