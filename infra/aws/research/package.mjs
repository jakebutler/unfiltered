import { build } from 'vite';
import { isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,existsSync,realpathSync,copyFileSync,chmodSync } from 'node:fs';
import { resolve,relative,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeploymentManifest } from '../manifest.schema.ts';
import { publicExample,newPrivateOutput } from '../io.mjs';
const root=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'../../..'));
const arg=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw new Error('explicit-package-arguments-required');return process.argv[i+1];};
if(process.versions.node!=='22.22.3')throw new Error('pinned-node-required');
const manifest=parseDeploymentManifest(publicExample(root,arg('--manifest'))),output=newPrivateOutput(root,arg('--output'));
if(manifest.product!=='research')throw new Error('research-profile-required');
const pin=publicExample(root,arg('--ffmpeg-manifest')),binaryPath=resolve(arg('--ffmpeg')),licensePath=resolve(arg('--ffmpeg-license'));
const sha=v=>createHash('sha256').update(v).digest('hex');
for(const p of[binaryPath,licensePath])if(!lstatSync(p).isFile()||lstatSync(p).isSymbolicLink())throw new Error('regular-binary-and-license-required');
const binary=readFileSync(binaryPath),license=readFileSync(licensePath);
if(pin.architecture!=='linux-x64'||binary.length!==pin.bytes||binary.length>150000000||sha(binary)!==pin.sha256||sha(license)!==pin.licenseSha256||license.length<1||license.length>1000000||binary.length<64||binary[0]!==127||binary.subarray(1,4).toString()!=='ELF'||binary[4]!==2||binary[5]!==1||binary.readUInt16LE(18)!==62)throw new Error('pinned-linux-x64-binary-or-license-mismatch');
mkdirSync(output,{mode:0o700});const receipt={schema:1,state:'building',platform:'linux/amd64',cloudCalls:0,providersEnabled:false,dependencyLockSha256:sha(readFileSync(join(root,'package-lock.json'))),files:[],sourceFiles:[]};
const save=()=>writeFileSync(join(output,'package-receipt.json'),JSON.stringify(receipt,null,2)+'\n');save();
const sources=new Map();const trace={name:'research-aws-trace',generateBundle(_o,bundle){for(const raw of this.getModuleIds()){const p=raw.split('?')[0];if(p.startsWith(root+'/')&&!p.includes('/node_modules/')&&existsSync(p)&&lstatSync(p).isFile()){const short=relative(root,p);if(/holdout|\.private|\.env/i.test(short))throw new Error('private-source-denied');sources.set(short,sha(readFileSync(p)));}}for(const c of Object.values(bundle))if(c.type==='chunk')for(const id of[...c.imports,...c.dynamicImports])if(!(id in bundle)&&!isBuiltin(id))throw new Error('unbundled-runtime-dependency');}};
try{
 const common={configFile:false,envDir:false,envPrefix:[],mode:'production'};
 await build({...common,root:join(root,'apps/research'),define:{'import.meta.env.VITE_RESEARCH_CONVEX_URL':JSON.stringify(manifest.authority.convexOrigin)},plugins:[trace],build:{outDir:join(output,'site-assets'),sourcemap:false}});
 await build({...common,base:'./',root:join(root,'infra/cloud/vercel/research/prototype'),publicDir:false,define:{__RESEARCH_ORIGIN__:JSON.stringify(manifest.publicOrigin)},plugins:[trace],build:{outDir:join(output,'site-assets/prototype'),emptyOutDir:false,sourcemap:false}});
 await build({...common,root,publicDir:false,plugins:[trace],ssr:{noExternal:true},build:{ssr:join(root,'infra/aws/research/entry.ts'),outDir:output,emptyOutDir:false,target:'node22',minify:false,sourcemap:false,rollupOptions:{output:{format:'cjs',entryFileNames:'server.cjs',inlineDynamicImports:true}}}});
 const assets=[];function walk(path){for(const name of readdirSync(path).sort()){const p=join(path,name),s=lstatSync(p);if(s.isSymbolicLink())throw new Error('symlink-denied');if(s.isDirectory())walk(p);else{const short=relative(join(output,'site-assets'),p);if(!/\.(?:html|js|css|svg|png|jpe?g|webp|ico|woff2?|ttf)$/.test(short)&&!/^fonts\/(Inter|SpaceGrotesk)-OFL\.txt$/.test(short)||s.size>4000000)throw new Error('unexpected-public-file');assets.push({path:short,digest:sha(readFileSync(p))});}}}walk(join(output,'site-assets'));
 if(assets.length>200)throw new Error('asset-envelope-exceeded');
 writeFileSync(join(output,'asset-manifest.json'),JSON.stringify({files:assets},null,2)+'\n');writeFileSync(join(output,'deployment-manifest.json'),JSON.stringify(manifest,null,2)+'\n');writeFileSync(join(output,'ffmpeg-manifest.json'),JSON.stringify(pin,null,2)+'\n');
 for(const name of['launcher.cjs','bounded-file.cjs','Dockerfile','compose.yml','images.lock.json','recovery.mjs','recovery-cli.mjs','OPERATIONS.md','startup-gate.mjs'])copyFileSync(join(root,'infra/aws/research',name),join(output,name));
 mkdirSync(join(output,'bin'));copyFileSync(binaryPath,join(output,'bin/ffmpeg'));chmodSync(join(output,'bin/ffmpeg'),0o755);copyFileSync(licensePath,join(output,'bin/FFMPEG-LICENSE.txt'));
 const paths=['server.cjs','launcher.cjs','bounded-file.cjs','startup-gate.mjs','Dockerfile','asset-manifest.json','deployment-manifest.json','ffmpeg-manifest.json','bin/ffmpeg','bin/FFMPEG-LICENSE.txt',...assets.map(a=>'site-assets/'+a.path)];
 writeFileSync(join(output,'.dockerignore'),'*\n'+paths.map(p=>'!'+p+'\n').join('')+'!site-assets/\n!site-assets/**\n!bin/\n!bin/**\n');
 const deploymentSources=[];
 function freezeSources(folder){for(const name of readdirSync(join(root,folder)).sort()){const short=folder+'/'+name,p=join(root,short),stat=lstatSync(p);if(stat.isSymbolicLink())throw new Error('source-symlink-denied');if(/holdout|\.private|\.env/i.test(short))throw new Error('private-deployment-source-denied');if(stat.isDirectory())freezeSources(short);else if(/\.(?:ts|js|json)$/.test(short)){const target=join(output,'backend-source',short);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(p,target);deploymentSources.push('backend-source/'+short);sources.set(short,sha(readFileSync(p)));}}}
 for(const folder of['convex','packages/research-core/src','packages/research-capture/src'])freezeSources(folder);
 for(const name of['package.json','package-lock.json']){copyFileSync(join(root,name),join(output,'backend-source',name));deploymentSources.push('backend-source/'+name);}
 receipt.files=[...deploymentSources,...paths,'compose.yml','images.lock.json','recovery.mjs','recovery-cli.mjs','OPERATIONS.md','.dockerignore'].sort().map(path=>({path,sha256:sha(readFileSync(join(output,path)))}));receipt.sourceFiles=[...sources].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256}));receipt.artifactHash=sha(JSON.stringify(receipt.files));receipt.state='packaged-container-unbuilt';save();console.log(JSON.stringify({state:receipt.state,output,artifactHash:receipt.artifactHash,cloudCalls:0}));
}catch{receipt.state='failed-retain-output';save();throw new Error('research-aws-package-failed-retain-output');}
