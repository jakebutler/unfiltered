import { createCipheriv,createDecipheriv,createHash,randomBytes } from 'node:crypto';
import { lstatSync,realpathSync,readdirSync,readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
const MAX=64*1024*1024,sha=v=>createHash('sha256').update(v).digest('hex');
const safe=p=>typeof p==='string'&&/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(p)&&!p.split('/').some(x=>!x||x==='.'||x==='..');
const privateDirectory=p=>{const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.mode&0o077||realpathSync(p)!==resolve(p))throw new Error('private-real-directory-required');};
function validateIdentity(i){if(!i||Object.keys(i).sort().join(',')!=='convexImage,metadataNamespace,objectNamespace,profileHash,recoveryIdentity'||![i.profileHash,i.recoveryIdentity].every(v=>/^[a-f0-9]{64}$/.test(v))||!/^ghcr.io\/get-convex\/convex-backend@sha256:[a-f0-9]{64}$/.test(i.convexImage)||![i.metadataNamespace,i.objectNamespace].every(v=>/^[a-z][a-z0-9-]{2,62}$/.test(v)))throw new Error('recovery-identity-invalid');}
/** Caller must stop the application and pinned backend before this offline file
 * operation. This archive contains only the Convex volume, never S3 objects. */
export function sealMetadata(directory,output,key,identity){
 validateIdentity(identity);privateDirectory(directory);privateDirectory(dirname(output));if(!Buffer.isBuffer(key)||key.length!==32||existsSync(output))throw new Error('new-archive-and-key-required');
 const files=[];let total=0;function walk(p,base=''){for(const name of readdirSync(p).sort()){const path=join(p,name),relative=base+name,s=lstatSync(path);if(s.isSymbolicLink()||!safe(relative))throw new Error('metadata-path-denied');if(s.isDirectory())walk(path,relative+'/');else{if(!s.isFile()||s.nlink!==1||(total+=s.size)>MAX||files.length>=4096)throw new Error('metadata-envelope-exceeded');const bytes=readFileSync(path);files.push({path:relative,sha256:sha(bytes),body:bytes.toString('base64')});}}}walk(directory);
 if(!files.length)throw new Error('metadata-empty');const plain=Buffer.from(JSON.stringify({schema:1,identity,traffic:'sealed',postCheckpointAuthority:'quarantine-required',files}));if(plain.length>MAX*1.5)throw new Error('metadata-envelope-exceeded');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encoded=Buffer.concat([Buffer.from('UFRS001\n'),iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);writeFileSync(output,encoded,{flag:'wx',mode:0o600});return{state:'backed-up-sealed',archiveSha256:sha(encoded),files:files.length,objectBytesArchived:0,identity};
}
export function restoreMetadata(archive,target,key,expected){
 validateIdentity(expected);privateDirectory(dirname(target));const stat=lstatSync(archive);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>MAX*1.5+36||existsSync(target)||!Buffer.isBuffer(key)||key.length!==32)throw new Error('private-archive-new-target-required');
 const bytes=readFileSync(archive);if(bytes.length<37||bytes.subarray(0,8).toString()!=='UFRS001\n')throw new Error('invalid-archive');const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));decipher.setAuthTag(bytes.subarray(-16));const plain=Buffer.concat([decipher.update(bytes.subarray(20,-16)),decipher.final()]);const decoded=JSON.parse(plain.toString());
 if(decoded.schema!==1||decoded.traffic!=='sealed'||decoded.postCheckpointAuthority!=='quarantine-required'||JSON.stringify(decoded.identity)!==JSON.stringify(expected)||!Array.isArray(decoded.files)||decoded.files.length<1||decoded.files.length>4096)throw new Error('archive-identity-mismatch');
 const seen=new Set();let total=0;const files=decoded.files.map(f=>{if(!f||!safe(f.path)||seen.has(f.path)||typeof f.body!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.body))throw new Error('archive-file-invalid');seen.add(f.path);const body=Buffer.from(f.body,'base64');if((total+=body.length)>MAX||sha(body)!==f.sha256)throw new Error('archive-file-invalid');return{path:f.path,body};});
 // Complete authentication, identity, path and digest validation precede writes.
 mkdirSync(target,{mode:0o700});for(const f of files){mkdirSync(dirname(join(target,f.path)),{recursive:true,mode:0o700});writeFileSync(join(target,f.path),f.body,{flag:'wx',mode:0o600});}
 writeFileSync(join(target,'RESTORE-SEALED.json'),JSON.stringify({schema:1,identity:expected,state:'quarantine-required',archiveSha256:sha(bytes),s3RestoreForbidden:true})+'\n',{flag:'wx',mode:0o600});return{state:'restored-sealed',files:files.length,objectBytesRestored:0};
}
export const RECOVERY_TABLES=['researchOperators','authSessions','authRefreshTokens','authVerificationCodes','authVerifiers','researchInvitations','researchShares','researchViewerSessions','researchSessions','researchCaptures','researchMedia','researchSources','researchDomBatches','researchReports','researchAnalyses','researchInterviewPolicy','researchSpeechPolicy','researchSpeechGrants','researchGatewayAllocations','researchGatewaySlots'];
/** Persist the checkpoint after every quarantine page and every retirement.
 * Unknown retirement never advances the key cursor or opens traffic. Native
 * callers supply an admin-only local mutation and the qualified same S3 port. */
export async function reconcileRecovery(identity,checkpoint,quarantine,store,save,maxPages=64){
 if(!/^[a-f0-9]{64}$/.test(identity)||checkpoint.identity!==identity||checkpoint.state!=='sealed'||!Number.isInteger(checkpoint.phase)||checkpoint.phase<0||checkpoint.phase>RECOVERY_TABLES.length)throw new Error('sealed-recovery-checkpoint-required');
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>64)throw new Error('bounded-recovery-page-budget-required');let pages=0;
 for(;checkpoint.phase<RECOVERY_TABLES.length;){
  if(!checkpoint.pending){if(pages++>=maxPages)return checkpoint;const page=await quarantine({identity,table:RECOVERY_TABLES[checkpoint.phase],cursor:checkpoint.cursor??null});if(!page||!Array.isArray(page.fenceKeys)||page.fenceKeys.length>1000||typeof page.cursor!=='string'||typeof page.done!=='boolean')throw new Error('recovery-page-invalid');checkpoint.pending={...page,nextKey:0};await save(checkpoint);}
  const page=checkpoint.pending;if(!Number.isInteger(page.nextKey)||page.nextKey<0||page.nextKey>page.fenceKeys.length)throw new Error('invalid-recovery-key-cursor');for(;page.nextKey<page.fenceKeys.length;){const key=page.fenceKeys[page.nextKey];if(!safe(key)||!/^research\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(key))throw new Error('recovery-key-invalid');await store.retire(key);if(await store.head(key)!==null)throw new Error('retirement-unresolved');page.nextKey++;await save(checkpoint);}
  checkpoint.cursor=page.cursor;if(page.done){checkpoint.phase++;checkpoint.cursor=null;}delete checkpoint.pending;await save(checkpoint);
 }
 checkpoint.state='quarantined-awaiting-fresh-identity-and-native-qualification';await save(checkpoint);return checkpoint;
}
