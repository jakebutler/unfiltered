import { build } from 'vite';
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { publicExample, newPrivateOutput } from '../io.mjs';
import { medplumProfile } from './profile.schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = name => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error('argument-required'); return process.argv[i + 1]; };
const clinic = publicExample(root, arg('--manifest')), profile = medplumProfile(clinic), output = newPrivateOutput(root, arg('--output'));
if (process.versions.node !== '22.22.3') throw new Error('node-22.22.3-required');
mkdirSync(output, { mode: 0o700 });
const inputs = Object.fromEntries(['render', 'volume', 'start', 'backup', 'restore'].map(name => [name, join(root, `infra/aws/medplum/${name}.mjs`)]));
await build({ configFile: false, root, envDir: false, envPrefix: [], mode: 'production', ssr: { noExternal: true },
  build: { ssr: true, target: 'node22', outDir: output, emptyOutDir: false, sourcemap: false, minify: false,
    rollupOptions: { input: inputs, output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'shared-[hash].mjs' } } } });
for (const name of ['compose.yml', 'images.lock.json', 'bootstrap.sh']) cpSync(join(root, `infra/aws/medplum/${name}`), join(output, name));
writeFileSync(join(output, 'clinic.json'), JSON.stringify(clinic, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const files = Object.fromEntries(readdirSync(output).sort().map(name => [name, createHash('sha256').update(readFileSync(join(output, name))).digest('hex')]));
const packageHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
writeFileSync(join(output, 'package.json'), JSON.stringify({ schema: 1, platform: profile.platform, files, packageHash, profileHash: createHash('sha256').update(JSON.stringify(profile)).digest('hex'), state: 'packaged-runtime-unqualified' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ state: 'packaged-offline', output, packageHash, nativeQualified: false, cloudCalls: 0 }));
