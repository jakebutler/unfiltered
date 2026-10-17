import { createHash } from 'node:crypto';
import { lstatSync,readFileSync,existsSync,realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve,join } from 'node:path';
const fail=()=>new Error('Research metadata admission unavailable; keep both services stopped');
const hash=value=>createHash('sha256').update(value).digest('hex');
export const profileHash=manifest=>hash(JSON.stringify(manifest,null,2)+'\n');
export const runtimeHash=runtime=>hash(JSON.stringify(runtime));
export function checkBinding(binding){
 const keys=['schema','stackId','profileHash','metadataNamespace','objectNamespace','convexImage','volumeId','filesystemUuid'];
 if(!binding||Object.keys(binding).sort().join(',')!==keys.sort().join(',')||binding.schema!==1||!/^vol-[a-f0-9]{8,17}$/.test(binding.volumeId)||!/^[a-f0-9-]{36}$/.test(binding.filesystemUuid)||!/^[a-f0-9]{64}$/.test(binding.profileHash)||!/^ghcr.io\/get-convex\/convex-backend@sha256:[a-f0-9]{64}$/.test(binding.convexImage)||![binding.stackId,binding.metadataNamespace,binding.objectNamespace].every(v=>typeof v==='string'&&/^[a-z][a-z0-9-]{2,62}$/.test(v)))throw fail();
 return binding;
}
export function checkReadiness(binding,runtime,identity,ready,markers){
 checkBinding(binding);
 if(!markers||markers.sealed!==false||markers.pending!==false||markers.restored!==false||JSON.stringify(identity)!==JSON.stringify(binding)||!ready||Object.keys(ready).sort().join(',')!=='binding,recoveryIdentity,runtimeHash,schema,state'||ready.schema!==1||!['accepted-fresh','accepted-reconciled'].includes(ready.state)||JSON.stringify(ready.binding)!==JSON.stringify(binding)||ready.recoveryIdentity!==runtime?.recovery?.identity||runtime?.recovery?.state!=='fresh-or-reconciled'||ready.runtimeHash!==runtimeHash(runtime))throw fail();
 return {state:ready.state,volumeId:binding.volumeId};
}
export function checkMount(binding,observation){
 checkBinding(binding);
 if(!observation||observation.target!=='/srv/unfiltered'||!/^\/dev\/[A-Za-z0-9/_-]+$/.test(observation.source)||!['ext4','xfs'].includes(observation.fstype)||observation.uuid!==binding.filesystemUuid||observation.diskType!=='disk'||observation.serial!==binding.volumeId.replaceAll('-',''))throw fail();
}
function trustedJson(path,privateFile=false){
 const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>32768||s.mode&(privateFile?0o077:0o022)||realpathSync(path)!==resolve(path))throw fail();return JSON.parse(readFileSync(path,'utf8'));
}
export function gateState(directory){
 const s=lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink()||s.mode&0o022||realpathSync(directory)!==resolve(directory))throw fail();
 return {identity:trustedJson(join(directory,'METADATA-IDENTITY.json')),ready:trustedJson(join(directory,'READY')),markers:{sealed:existsSync(join(directory,'SEALED')),pending:existsSync(join(directory,'RECOVERY-PENDING')),restored:existsSync(join(directory,'RESTORE-SEALED.json'))}};
}
/** Deterministic launcher-side check reuses persisted identity/state. The host
 * ExecStartPre additionally verifies the native mount/device before EACH start. */
export function checkLauncher(manifest,runtime,binding,directory){
 checkBinding(binding);
 if(manifest.product!=='research'||binding.profileHash!==profileHash(manifest)||binding.stackId!==manifest.stackId||binding.metadataNamespace!==manifest.authority.metadataNamespace||binding.objectNamespace!==manifest.authority.objectNamespace)throw fail();
 const state=gateState(directory);return checkReadiness(binding,runtime,state.identity,state.ready,state.markers);
}
export function nativeGate(binding,runtime,run=execFileSync,readState=gateState,hasRestored=()=>existsSync('/srv/unfiltered/convex/RESTORE-SEALED.json')){
 const mount=JSON.parse(run('/usr/bin/findmnt',['--json','--mountpoint','/srv/unfiltered','--output','TARGET,SOURCE,FSTYPE,UUID'],{encoding:'utf8',timeout:5000,maxBuffer:16384,env:{}})).filesystems;
 if(!Array.isArray(mount)||mount.length!==1)throw fail();
 const block=JSON.parse(run('/usr/bin/lsblk',['--json','--inverse','--output','TYPE,SERIAL',mount[0].source],{encoding:'utf8',timeout:5000,maxBuffer:16384,env:{}})).blockdevices;
 const disks=[];function walk(rows){if(!Array.isArray(rows))throw fail();for(const row of rows){if(row.type==='disk')disks.push(row);if(row.children)walk(row.children);}}walk(block);if(disks.length!==1)throw fail();
 checkMount(binding,{...mount[0],diskType:disks[0].type,serial:disks[0].serial});
 const state=readState('/srv/unfiltered/admission');
 // Restored Convex checkpoints cannot bypass admission even if a stale READY
 // survives an operator mistake. No root-directory fallback or autoformat.
 state.markers.restored ||= hasRestored();
 return checkReadiness(binding,runtime,state.identity,state.ready,state.markers);
}
if(process.argv.includes('--check-start')){
 try{nativeGate(trustedJson('/opt/unfiltered/research-binding.json'),trustedJson('/run/unfiltered/research-runtime.json',true));}
 catch{console.error('Research startup gate denied; services remain stopped');process.exitCode=1;}
}
