import { build } from 'vite';
import { isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, realpathSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wsBundleDefines } from './ws-bundle.mjs';
// Explicit local build; never reads env files, auth state, provider keys or invokes deployment.
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));
const argument = name => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error(`explicit-${name.slice(2)}-required`); return resolve(process.argv[i + 1]); };
const modeIndex = process.argv.indexOf('--entry-mode');
const entryMode = modeIndex < 0 ? 'listener' : process.argv[modeIndex + 1];
if (!['listener', 'api-server'].includes(entryMode)) throw new Error('invalid-explicit-entry-mode');
const apiServer = entryMode === 'api-server';
const entryFile = apiServer ? 'api/server.js' : 'server.cjs';
const output = argument('--output'), manifestPath = argument('--manifest'), ffmpegPath = argument('--ffmpeg'), licensePath = argument('--ffmpeg-license');
if (existsSync(output) || !output.startsWith(`${root}/infra/cloud/.private/`)) throw new Error('new-ignored-output-directory-required');
const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
if (!exact(raw, ['schema','mode','canonicalOrigin','deployment','convexSite','r2','maxSegmentBytes','maxResponseBytes','ffmpeg']) || raw.schema !== 1 || !['deployable-candidate','offline-fixture'].includes(raw.mode) || raw.deployment !== 'https://elegant-crane-662.convex.cloud' || raw.convexSite !== 'https://elegant-crane-662.convex.site' || !integer(raw.maxSegmentBytes,1,4000000) || !integer(raw.maxResponseBytes,1,4000000) || !exact(raw.r2,['accountId','bucket','namespace','deadlineMs']) || raw.r2.accountId !== '728ae4b71b42dfcef062336c06bd8595' || raw.r2.bucket !== 'unfiltered-recordings' || !/^[a-z][a-z0-9-]{2,62}$/.test(raw.r2.namespace) || !integer(raw.r2.deadlineMs,1,15000) || !exact(raw.ffmpeg,['sha256','bytes','architecture','version','source','license','licenseSha256']) || !hash(raw.ffmpeg.sha256) || !hash(raw.ffmpeg.licenseSha256) || !integer(raw.ffmpeg.bytes,64,150000000) || raw.ffmpeg.architecture !== 'linux-x64' || typeof raw.ffmpeg.version !== 'string' || !raw.ffmpeg.version.length || raw.ffmpeg.version.length > 100 || !['LGPL-2.1-or-later', 'LGPL-3.0-or-later','GPL-2.0-or-later','GPL-3.0-or-later'].includes(raw.ffmpeg.license)) throw new Error('invalid-public-root-manifest');
const origin = new URL(raw.canonicalOrigin), source = new URL(raw.ffmpeg.source);
if (origin.protocol !== 'https:' || origin.origin !== raw.canonicalOrigin || origin.port || origin.username || origin.password || source.protocol !== 'https:' || source.username || source.password || raw.mode === 'offline-fixture' && !/\.(invalid|test)$/.test(origin.hostname) || raw.mode === 'deployable-candidate' && /(?:^|\.)(invalid|test|localhost)$/.test(origin.hostname)) throw new Error('invalid-root-origin-or-binary-source');
for (const path of [ffmpegPath, licensePath]) if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('explicit-regular-binary-and-license-required');
const binary = readFileSync(ffmpegPath), license = readFileSync(licensePath);
if (binary.length !== raw.ffmpeg.bytes || sha(binary) !== raw.ffmpeg.sha256 || sha(license) !== raw.ffmpeg.licenseSha256 || license.length < 1 || license.length > 1000000 || binary[0] !== 0x7f || binary.subarray(1,4).toString() !== 'ELF' || binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== 62) throw new Error('pinned-linux-x64-binary-or-license-mismatch');
mkdirSync(output,{ recursive:true, mode:0o700 });
const receipt = { schema:1, state:'building', at:new Date().toISOString(), mode:raw.mode, entryMode, hostedAccepted:false, providersActivated:false, cloudCalls:0, dependencyLockSha256:sha(readFileSync(join(root,'package-lock.json'))), files:[], inventories:{} };
const save = () => writeFileSync(join(output,'package-receipt.json'), JSON.stringify(receipt,null,2)+'\n'); save();
const forbidden = /\/node_modules\/(?:next|drizzle-orm|@workos-inc\/authkit-nextjs|sharp|valibot|postcss|nanoid|source-map-js)(?:\/|$)/;
const inventory = stage => ({ name:`research-inventory-${stage}`, generateBundle(_options,bundle) { const ids = new Set(); const external = new Set(); for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') { Object.keys(chunk.modules).forEach(id => ids.add(id)); [...chunk.imports,...chunk.dynamicImports].forEach(id => { if (!(id in bundle)) external.add(id); }); } const modules = [...ids].map(id => id.replaceAll('\0','').replace(root+'/','')).sort(); if ([...ids].some(id => forbidden.test(id))) throw new Error('excluded-runtime-dependency-reached-bundle'); if (stage === 'server' && [...external].some(id => !isBuiltin(id))) throw new Error('unbundled-runtime-dependency'); receipt.inventories[stage] = { modules, external:[...external].sort() }; } });
try {
  const common = { configFile:false, envDir:false, envPrefix:'__CORVO_NO_AUTOMATIC_ENV__', mode:'production' };
  await build({ ...common, root:join(root,'apps/research'), define:{ 'import.meta.env.VITE_RESEARCH_CONVEX_URL':JSON.stringify(raw.deployment) }, plugins:[inventory('frontend')], build:{ outDir:join(output,'site-assets'), emptyOutDir:true, sourcemap:false } });
  await build({ ...common, base:'./', root:join(root,'infra/cloud/vercel/research/prototype'), publicDir:false, define:{ __RESEARCH_ORIGIN__:JSON.stringify(raw.canonicalOrigin) }, plugins:[inventory('prototype')], build:{ outDir:join(output,'site-assets/prototype'), emptyOutDir:false, sourcemap:false } });
  await build({ ...common, root, publicDir:false, define:wsBundleDefines, plugins:[inventory('server')], ssr:{ noExternal:true }, build:{ ssr:join(root,'infra/cloud/vercel/research/server.ts'), outDir:output, emptyOutDir:false, sourcemap:false, target:'node22', minify:false, rollupOptions:{ output:{ format:'cjs',entryFileNames:'research-bootstrap.cjs',inlineDynamicImports:true } } } });
  if (apiServer) mkdirSync(join(output,'api'));
  copyFileSync(join(root,'infra/cloud/vercel/research',apiServer ? 'startup-api.js' : 'startup-diagnostics.cjs'),join(output,entryFile));
  const assets=[];
  function walk(directory) { for (const name of readdirSync(directory)) { const path=join(directory,name), stat=lstatSync(path); if (stat.isSymbolicLink()) throw new Error('symlink-in-package'); if (stat.isDirectory()) walk(path); else { const short=relative(join(output,'site-assets'),path); if (!/\.(?:html|js|css|svg|png|jpe?g|webp|ico|woff2?|ttf)$/.test(short) && !/^fonts\/(Inter|SpaceGrotesk)-OFL\.txt$/.test(short) || stat.size > 4000000) throw new Error('unexpected-or-oversized-public-file'); assets.push({path:short,digest:sha(readFileSync(path))}); } } }
  walk(join(output,'site-assets'));
  // Every emitted HTML asset must resolve through the same guarded manifest.
  receipt.assetReferences = [];
  for (const asset of assets.filter(item => item.path.endsWith('.html'))) {
    const html = readFileSync(join(output,'site-assets',asset.path),'utf8');
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const url = new URL(match[1], `${raw.canonicalOrigin}/${asset.path}`);
      if (url.origin !== raw.canonicalOrigin || url.search || url.hash) throw new Error('unexpected-html-asset-reference');
      const matched = assets.find(item => '/'+item.path === url.pathname);
      if (!matched || sha(readFileSync(join(output,'site-assets',matched.path))) !== matched.digest) throw new Error('html-asset-missing-from-guarded-manifest');
      receipt.assetReferences.push({ html:asset.path, reference:match[1], resolved:matched.path, digest:matched.digest });
    }
  }
  mkdirSync(join(output,'bin')); copyFileSync(ffmpegPath,join(output,'bin/ffmpeg')); chmodSync(join(output,'bin/ffmpeg'),0o755); copyFileSync(licensePath,join(output,'bin/FFMPEG-LICENSE.txt'));
  writeFileSync(join(output,'research-manifest.json'), JSON.stringify(raw,null,2)+'\n');
  writeFileSync(join(output,'asset-manifest.json'), JSON.stringify({files:assets},null,2)+'\n');
  writeFileSync(join(output,'package.json'),JSON.stringify({name:'corvo-research-synthetic-demo',version:'0.1.0',private:true,type:'commonjs',engines:{node:'22.x'},scripts:apiServer ? {} : {start:'node server.cjs'}},null,2)+'\n');
  writeFileSync(join(output,'vercel.json'),JSON.stringify({$schema:'https://openapi.vercel.sh/vercel.json',framework:apiServer ? null : 'node',fluid:true,buildCommand:null,installCommand:'',...(apiServer ? {rewrites:[{source:'/(.*)',destination:'/api/server'}]} : {}),functions:{[entryFile]:{architecture:'x86_64',maxDuration:300,supportsCancellation:true,includeFiles:'{research-bootstrap.cjs,site-assets/**,asset-manifest.json,research-manifest.json,bin/**}'}}},null,2)+'\n');
  writeFileSync(join(output,'.vercelignore'),'.env*\n*.log\npackage-receipt.json\n');
  receipt.files=[entryFile,'research-bootstrap.cjs','research-manifest.json','asset-manifest.json','package.json','vercel.json','.vercelignore','bin/ffmpeg','bin/FFMPEG-LICENSE.txt',...assets.map(asset=>'site-assets/'+asset.path)].map(path=>({path,bytes:lstatSync(join(output,path)).size,sha256:sha(readFileSync(join(output,path)))}));
  receipt.totalBytes=receipt.files.reduce((sum,file)=>sum+file.bytes,0); if (receipt.totalBytes>250000000) throw new Error('package-exceeds-unpacked-platform-envelope');
  receipt.state=raw.mode === 'offline-fixture' ? 'offline-fixture-nondeployable' : 'packaged-hosted-unqualified'; save();
  console.log(JSON.stringify({state:receipt.state,output,files:receipt.files.length,hostedAccepted:false,cloudCalls:0}));
} catch { receipt.state='failed-retain-output'; save(); throw new Error('research-package-failed-retain-local-output'); }
