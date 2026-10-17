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
  await build({ configFile: false, root: join(root, 'apps/clinic'), envDir: false, mode: 'production', build: { outDir: join(output, 'site-assets'), emptyOutDir: true, sourcemap: false } });
  await build({ configFile: false, root, publicDir: false, envDir: false, mode: 'production', ssr: { noExternal: true }, build: { ssr: join(root, 'infra/cloud/vercel/server.ts'), outDir: output, emptyOutDir: false, sourcemap: false, target: 'node22', minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'clinic-bootstrap.cjs', inlineDynamicImports: true } } } });
  // Keep construction separate from the platform entrypoint and serve assets through our headers.
  writeFileSync(join(output, 'server.cjs'), "const { createClinicApplication } = require('./clinic-bootstrap.cjs');\nconst server = createClinicApplication();\nserver.listen(Number(process.env.PORT || 3000));\nmodule.exports = server;\n");
  const assets = [];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('symlinks-not-allowed-in-deployment');
      if (stat.isDirectory()) walk(path);
      else {
        const short = relative(join(output, 'site-assets'), path);
        if (!/\.(?:html|js|css|svg|png|jpe?g|webp|ico|woff2?|ttf)$/.test(short) && !/^fonts\/(?:Inter|SpaceGrotesk)-OFL\.txt$/.test(short)) throw new Error('unexpected-public-build-file');
        assets.push({ path: short, digest: createHash('sha256').update(readFileSync(path)).digest('hex') });
      }
    }
  }
  walk(join(output, 'site-assets'));
  writeFileSync(join(output, 'asset-manifest.json'), `${JSON.stringify({ files: assets }, null, 2)}\n`);
  writeFileSync(join(output, 'package.json'), `${JSON.stringify({ name: 'corvo-clinic-synthetic-demo', version: '0.1.0', private: true, type: 'commonjs', engines: { node: '22.x' }, scripts: { start: 'node server.cjs' } }, null, 2)}\n`);
  writeFileSync(join(output, 'vercel.json'), `${JSON.stringify({ $schema: 'https://openapi.vercel.sh/vercel.json', framework: 'node', fluid: true, buildCommand: null, installCommand: '', functions: { 'server.cjs': { maxDuration: 300, supportsCancellation: true, includeFiles: '{clinic-bootstrap.cjs,site-assets/**,asset-manifest.json}' } } }, null, 2)}\n`);
  writeFileSync(join(output, '.vercelignore'), '.env*\n*.log\npackage-receipt.json\n');
  manifest.state = 'packaged-unqualified';
  manifest.files = ['server.cjs', 'clinic-bootstrap.cjs', 'asset-manifest.json', 'package.json', 'vercel.json', '.vercelignore', ...assets.map(asset => `site-assets/${asset.path}`)];
  save();
  console.log(JSON.stringify({ status: manifest.state, output, files: manifest.files.length, providersEnabled: false, cloudCalls: 0 }));
} catch { manifest.state = 'failed-retain-output'; save(); throw new Error('clinic-packaging-failed-inspect-retained-local-output'); }
