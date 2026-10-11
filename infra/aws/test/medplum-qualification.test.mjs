import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync, realpathSync, openSync, ftruncateSync, closeSync, symlinkSync } from 'node:fs';
import { capacity, names, ownedVolume, privateClientArgs, NODE_IMAGE, CLI_HASH, PLUGIN_HASH, SOCKET, PACKAGE_HASH, verifyPackage, accountOwnedTrees, safeControlResult, OWNED_TREE_LIMIT_BYTES } from '../medplum/qualify-boundaries.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { controlArgs, execute } from '../medplum/qualify-restore.mjs';
const id='012345abcdef',n=names(id);
const baseline={availableMiB:3424,freeDiskMiB:17550,existingMiB:232,activeNames:['unfiltered-research-s4-backend-1'],cliHash:CLI_HASH,pluginHash:PLUGIN_HASH,socket:SOCKET,platform:'linux/arm64'};
test('explicit native admission is mandatory before filesystem or daemon access', async()=>{
  let calls=0; await assert.rejects(execute({executeSyntheticOwned:false},{run:()=>calls++}),/explicit-synthetic-native-admission-required/); assert.equal(calls,0);
});
test('resource admission preserves measured research reserve and refuses drift',()=>{
  capacity(baseline);
  for(const change of [{availableMiB:3327},{freeDiskMiB:2047},{existingMiB:577},{activeNames:[]},{activeNames:[...baseline.activeNames,'unrelated']},{cliHash:'0'.repeat(64)},{socket:'/other.sock'},{platform:'linux/amd64'},{availableMiB:NaN}])assert.throws(()=>capacity({...baseline,...change}));
});
test('names are distinct, bounded and cannot target existing clinic project',()=>{
  assert.notEqual(n.source,n.target); assert.notEqual(n.source,'unfiltered-medplum-s0');
  for(const bad of ['../escape','clinic-a','x'.repeat(12),'012345abcdef;stop'])assert.throws(()=>names(bad));
});
test('volume requires exact run,role,local-driver and canonical VM path',()=>{
  const name=n.volumes[0].name, v={Name:name,Driver:'local',Labels:{'unfiltered.drill':id,'unfiltered.role':'control'},Options:null,Mountpoint:`/var/lib/docker/volumes/${name}/_data`};
  assert.equal(ownedVolume(v,name,'control',id),v.Mountpoint);
  for(const changed of [{Name:'unfiltered-medplum-s0'},{Driver:'nfs'},{Options:{device:'/Users'}},{Mountpoint:'/var/lib/docker/volumes/other/_data'},{Labels:{'unfiltered.drill':id,'unfiltered.role':'source'}}])assert.throws(()=>ownedVolume({...v,...changed},name,'control',id));
});
test('control admits only pinned cached image, networknone and owned volume mounts',()=>{
  const paths=Object.fromEntries(n.volumes.map(v=>[v.role,`/var/lib/docker/volumes/${v.name}/_data`])),args=controlArgs(n,paths);
  assert.equal(args[args.indexOf('--network')+1],'none');assert.equal(args[args.indexOf('--pull')+1],'never');assert(args.includes(NODE_IMAGE));assert.equal(args[args.indexOf('--memory')+1],'128m');
  assert(!args.some(v=>v.includes('/Users/')||v.includes('/Volumes/')||v.includes('/.docker/')));
  assert(!args.includes('--privileged'));assert(!args.includes('--publish'));
});
test('client only reaches exact own internal network and does not mount socket,package or backend',()=>{
  const args=privateClientArgs(n,'/var/lib/docker/volumes/control/_data',`${n.target}_default`,'verify');
  assert(args.includes(NODE_IMAGE));assert.equal(args[args.indexOf('--network')+1],`${n.target}_default`);
  assert(!args.some(v=>v.includes('docker.sock')||v.includes('backend.private')||v.includes('archive.key')||v.includes('dst=/var/lib/docker')));
  assert(args.includes('type=bind,src=/var/lib/docker/volumes/control/_data/qualify-boundaries.mjs,dst=/qualify-boundaries.mjs,readonly'));
  assert.throws(()=>privateClientArgs(n,'/control','unfiltered-research-s4_default','verify'));
  assert.throws(()=>privateClientArgs(n,'/control',`${n.target}_default`,'unseal'));
});
test('exact package validation fails modified wire/file map without reading private files',()=>{
  const root=new URL('../.private/medplum-clinic-a-package-5/',import.meta.url),p=JSON.parse(readFileSync(new URL('package.json',root)));
  assert.equal(p.packageHash,PACKAGE_HASH);verifyPackage(p,name=>readFileSync(new URL(name,root)));
  assert.throws(()=>verifyPackage({...p,packageHash:'a'.repeat(64)},()=>{throw new Error('should not read');}));
  assert.throws(()=>verifyPackage(p,name=>name==='backup.mjs'?Buffer.from('changed'):readFileSync(new URL(name,root))));
});
test('unexpected running service fails before intent,volume or container mutation',async t=>{
  const runId=randomBytes(6).toString('hex'),parent=fileURLToPath(new URL('../.private/',import.meta.url)),receipt=`${parent}medplum-refusal-${runId}.json`,calls=[];
  t.after(()=>rmSync(`${parent}medplum-drill-docker-${runId}`,{recursive:true,force:true}));
  const run=(program,args)=>{calls.push([program,args]);
    if(program==='colima'){assert(args.join(' ').includes('df -Pm /var/lib/docker'));return `${CLI_HASH}  /usr/bin/docker\n${PLUGIN_HASH}  /usr/libexec/docker/cli-plugins/docker-compose\n${SOCKET}\naarch64\n3424\n/dev/vdb1 19985 4191 14755 23% /var/lib/docker\n`;}
    if(args[0]==='ps')return 'unrelated-service\n';if(args[0]==='stats')return '232MiB / 3.813GiB';throw new Error('unexpected-command');
  };
  const out=await execute({packagePath:fileURLToPath(new URL('../.private/medplum-clinic-a-package-5',import.meta.url)),receipt,id:runId,executeSyntheticOwned:true},{run,freePort:()=>{throw new Error('must-not-reach');}});
  assert.equal(out.state,'preflight-rejected-zero-native-mutations');assert(calls.some(([program,args])=>program==='docker'&&args[0]==='stats'));assert(!existsSync(receipt));assert(!existsSync(`${receipt}.intent`));
  assert(!calls.some(([_,args])=>['create','run','start','stop','volume','cp'].includes(args[0])));
});

test('owned-volume accounting aggregates sparse sizes and refuses outside symlinks',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'uf-native-budget-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.equal(OWNED_TREE_LIMIT_BYTES,1073741824);
  const a=join(root,'source'),b=join(root,'restore');for(const path of [a,b]){const fd=openSync(path,'wx',0o600);ftruncateSync(fd,536870912);closeSync(fd);}
  assert.equal(accountOwnedTrees([a,b]),1073741824);const fd=openSync(b,'r+');ftruncateSync(fd,536870913);closeSync(fd);
  assert.throws(()=>accountOwnedTrees([a,b]),/owned-tree-byte-bound/);
  symlinkSync(a,join(root,'outside'));assert.throws(()=>accountOwnedTrees([join(root,'outside')]),/owned-tree-entry-bound/);
});
test('observed Q2 two-database envelope rejects under historical512MiB and fits declared1GiB',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'uf-native-q2-size-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const paths=['control','source','restore'].map(name=>join(root,name));
  for(const [i,size] of [135239247,338007319,235666189].entries()){const fd=openSync(paths[i],'wx',0o600);ftruncateSync(fd,size);closeSync(fd);}
  const previous=await import('../.private/medplum-qualifier-q2-boundary/qualify-boundaries.mjs');
  assert.throws(()=>previous.accountOwnedTrees(paths),/owned-tree-byte-bound/);assert.equal(accountOwnedTrees(paths),708912755);
});
test('nonzero control result retains only a bounded known failure observation',()=>{
  assert.deepEqual(safeControlResult({state:'failed-or-unknown',failureStep:'source-fixture',cleanupVerified:true,upstreamError:'private-unused-text',password:'synthetic-not-a-real-secret'}),{state:'failed-or-unknown',failureStep:'source-fixture',automaticRetry:false,trafficOpened:false,cleanupVerified:true});
  assert(!('failureStep' in safeControlResult({state:'failed-or-unknown',failureStep:'untrusted dynamic string'})));
  assert.throws(()=>safeControlResult({state:'synthetic-package-checkpoint-restored',retainedBytes:1073741825}));
});
