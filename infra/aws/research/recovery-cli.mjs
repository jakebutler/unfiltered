import { readFileSync,writeFileSync,lstatSync,realpathSync,existsSync,unlinkSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { sealMetadata,restoreMetadata } from './recovery.mjs';
const argument=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw new Error('explicit-recovery-arguments-required');return resolve(process.argv[i+1]);};
const privateBytes=(path,maximum)=>{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||s.size>maximum||realpathSync(path)!==path)throw new Error('private-recovery-file-required');return readFileSync(path);};
try{
 const operation=process.argv[2];if(!['seal','restore'].includes(operation))throw new Error('explicit-seal-or-restore-required');
 const key=privateBytes(argument('--key-file'),32);if(key.length!==32)throw new Error('32-byte-key-required');
 const identity=JSON.parse(privateBytes(argument('--identity'),4096).toString());
 // An explicit attestation is required; native stop/inspect evidence remains an
 // operator gate. This command performs no container or remote storage action.
 if(!process.argv.includes('--writers-and-backend-stopped'))throw new Error('sealed-writer-attestation-required');
 if(operation==='restore'){
   const admission=argument('--admission-directory'),stat=lstatSync(admission);
   if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o022||realpathSync(admission)!==admission)throw new Error('trusted-volume-admission-directory-required');
   // Seal both normal service starts BEFORE any archive processing or writes.
   if(!existsSync(join(admission,'SEALED')))writeFileSync(join(admission,'SEALED'),'restore-in-progress\n',{flag:'wx',mode:0o644});
   if(existsSync(join(admission,'READY')))unlinkSync(join(admission,'READY'));
 }
 const result=operation==='seal'?sealMetadata(argument('--metadata'),argument('--archive'),key,identity):restoreMetadata(argument('--archive'),argument('--target'),key,identity);
 writeFileSync(argument('--receipt'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({state:result.state,objectBytes:0,traffic:'sealed'}));
}catch{console.error('research-metadata-recovery-failed-or-unknown; retain sealed state');process.exitCode=1;}
