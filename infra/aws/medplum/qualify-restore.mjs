/** Root-reviewed synthetic-only native qualification; imports perform no native action. */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { NODE_IMAGE, CLI, PLUGIN, SOCKET, CLI_HASH, PLUGIN_HASH, PACKAGE_HASH, names, verifyPackage, capacity, ownedVolume, sha, safeControlResult } from './qualify-boundaries.mjs';
const here = dirname(fileURLToPath(import.meta.url)), repository = resolve(here,'../../..');
const scripts = ['qualify-control.mjs','qualify-client.mjs','qualify-boundaries.mjs'];
function privatePath(path, existing) {
  const parent = realpathSync(dirname(path)); if (parent !== join(repository,'infra/aws/.private') || (lstatSync(parent).mode & 0o077)) throw new Error('new-owned-private-receipt-required');
  if (existing) { const info=lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path)!==resolve(path)) throw new Error('private-package-required'); }
  if (!existing && (existsSync(path) || existsSync(`${path}.intent`))) throw new Error('immutable-receipt-or-intent-exists');
  return resolve(path);
}
export async function freePort() {
  const server=createServer(); await new Promise((ok,no)=>{server.once('error',no);server.listen({host:'127.0.0.1',port:8213,exclusive:true},ok);}); await new Promise(ok=>server.close(ok));
}
export function controlArgs(n, mounts) {
  return ['create','--pull','never','--name',n.control,'--label',`unfiltered.drill=${n.id}`,'--label','unfiltered.role=control','--network','none','--memory','128m','--cpus','.05','--pids-limit','64','--read-only','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--security-opt','no-new-privileges:true','--log-driver','none','--tmpfs','/tmp:rw,nosuid,size=16m',
    ...n.volumes.flatMap(v=>['--mount',`type=volume,src=${v.name},dst=${mounts[v.role]}`]),
    '--mount',`type=bind,src=${SOCKET},dst=${SOCKET}`,'--mount',`type=bind,src=${CLI},dst=${CLI},readonly`,'--mount',`type=bind,src=${PLUGIN},dst=${PLUGIN},readonly`,
    NODE_IMAGE,'node','--max-old-space-size=96',`${mounts.control}/qualify-control.mjs`,mounts.control,mounts.source,mounts.restore,n.id];
}
export async function execute({packagePath,receipt,id,executeSyntheticOwned}, dependencies={}) {
  if (executeSyntheticOwned !== true || process.versions.node !== '22.22.3') throw new Error('explicit-synthetic-native-admission-required');
  const n=names(id), ppath=privatePath(resolve(packagePath),true), rpath=privatePath(resolve(receipt),false), p=JSON.parse(readFileSync(join(ppath,'package.json')));
  verifyPackage(p,name=>readFileSync(join(ppath,name)));
  const hostSocket=join(homedir(),'.colima/unfiltered-s0/docker.sock'); if (!lstatSync(hostSocket).isSocket()) throw new Error('existing-owned-daemon-required');
  // Own config contains no context or credentials. Never use ambient Docker auth.
  const dockerConfig=join(dirname(rpath),`medplum-drill-docker-${id}`); mkdirSync(dockerConfig,{mode:0o700});
  const env={PATH:process.env.PATH,HOME:homedir(),DOCKER_CONFIG:dockerConfig,DOCKER_HOST:`unix://${hostSocket}`};
  const run=dependencies.run??((program,args,timeout=60000)=>execFileSync(program,args,{env,timeout,maxBuffer:65536,encoding:'utf8',stdio:['ignore','pipe','ignore']}));
  const docker=(args,timeout)=>run('docker',args,timeout), ssh=args=>run('colima',['--profile','unfiltered-s0','ssh','--',...args]);
  let admitted=false, controlCreated=false, timer, cleanup=true, result={state:'failed-or-unknown',automaticRetry:false}, pressureFailed=false;
  const abort=new AbortController(), interrupt=()=>abort.abort(); process.once('SIGINT',interrupt); process.once('SIGTERM',interrupt);
  const tools=()=>{
    const rows=ssh(['sh','-c','sha256sum /usr/bin/docker /usr/libexec/docker/cli-plugins/docker-compose; readlink -f /var/run/docker.sock; uname -m; awk \'/^MemAvailable:/ {print int($2/1024)}\' /proc/meminfo; df -Pm /var/lib/docker | tail -1']).trim().split('\n');
    if(rows.length!==6) throw new Error('native-observation-invalid');
    return {cliHash:rows[0].split(/\s+/)[0],pluginHash:rows[1].split(/\s+/)[0],socket:rows[2],platform:rows[3]==='aarch64'?'linux/arm64':rows[3],availableMiB:Number(rows[4]),freeDiskMiB:Number(rows[5].trim().split(/\s+/)[3])};
  };
  const stopOwned=()=>{
    // Stop trusted control first, so it cannot race final shutdown by starting a service.
    if(controlCreated) try { assertLabel(n.control,'unfiltered.drill',id); docker(['stop','--time','10',n.control]); } catch {cleanup=false;}
    const clients=docker(['ps','--all','--filter',`label=unfiltered.drill=${id}`,'--format','{{.ID}}']).trim().split('\n').filter(Boolean);
    for(const cid of clients) try {assertLabel(cid,'unfiltered.drill',id);docker(['stop','--time','10',cid]);}catch{cleanup=false;}
    for(const project of [n.source,n.target]) {
      const ids=docker(['ps','--all','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}']).trim().split('\n').filter(Boolean);
      for(const cid of ids) try {assertLabel(cid,'com.docker.compose.project',project);docker(['stop','--time','30',cid]);}catch{cleanup=false;}
    }
    for(const project of [n.source,n.target]) if(docker(['ps','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}']).trim()) cleanup=false;
    if(docker(['ps','--filter',`label=unfiltered.drill=${id}`,'--format','{{.ID}}']).trim()) cleanup=false;
  };
  const assertLabel=(cid,key,value)=>{if(!/^[a-zA-Z0-9_.-]+$/.test(cid)||docker(['inspect','--format',`{{index .Config.Labels "${key}"}}`,cid]).trim()!==value)throw new Error('foreign-container-denied');};
  try {
    const activeNames=docker(['ps','--format','{{.Names}}']).trim().split('\n').filter(Boolean), observed=tools();
    const mem=docker(['stats','--no-stream','--format','{{.MemUsage}}','unfiltered-research-s4-backend-1']).trim().split('/')[0].trim(), m=mem.match(/^(\d+(?:\.\d+)?)(KiB|MiB|GiB)$/); if(!m)throw new Error('existing-memory-observation-invalid');
    capacity({...observed,activeNames,existingMiB:Number(m[1])*({KiB:1/1024,MiB:1,GiB:1024}[m[2]])});
    const profiles=run('colima',['list','--json']).trim().split('\n').map(row=>JSON.parse(row)), profile=profiles.find(v=>v.name==='unfiltered-s0');
    if(!profile || profile.status!=='Running'||profile.arch!=='aarch64'||profile.cpus!==2||profile.memory!==4294967296||profile.disk!==21474836480)throw new Error('existing-vm-profile-changed');
    const mountsNone=ssh(['sh','-c','test ! -e /Users && test ! -e /Volumes && echo mountnone']); if(mountsNone.trim()!=='mountnone')throw new Error('vm-host-mounts-present');
    for(const image of [NODE_IMAGE,...['server','postgres','redis'].map(k=>JSON.parse(readFileSync(join(ppath,'images.lock.json')))[k])]) if(docker(['image','inspect','--format','{{.Os}}/{{.Architecture}}',image]).trim()!=='linux/arm64')throw new Error('cached-exact-platform-required');
    for (const project of [n.source,n.target]) if(docker(['ps','--all','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}']).trim())throw new Error('fresh-project-namespace-required');
    const all=docker(['ps','--all','--format','{{.Names}}']).trim().split('\n'); if(all.some(v=>[n.control,n.client].includes(v)||v.startsWith(`${n.source}-`)||v.startsWith(`${n.target}-`)))throw new Error('fresh-container-namespace-required');
    const existing=docker(['volume','ls','--format','{{.Name}}']).trim().split('\n'); if(n.volumes.some(v=>existing.includes(v.name)))throw new Error('fresh-volume-namespace-required');
    await (dependencies.freePort??freePort)();
    // Intent is exclusive and precedes the first native mutation; never replay it.
    writeFileSync(`${rpath}.intent`,JSON.stringify({id,packageHash:PACKAGE_HASH,automaticRetry:false,scriptHashes:Object.fromEntries(scripts.map(s=>[s,sha(readFileSync(join(here,s)))]))}),{flag:'wx',mode:0o600}); admitted=true;
    const paths={}; for(const v of n.volumes){docker(['volume','create','--label',`unfiltered.drill=${id}`,'--label',`unfiltered.role=${v.role}`,v.name]); const actual=JSON.parse(docker(['volume','inspect',v.name])); if(actual.length!==1)throw new Error('volume-observation-invalid');paths[v.role]=ownedVolume(actual[0],v.name,v.role,id);}
    docker(controlArgs(n,paths)); controlCreated=true;
    for(const s of scripts)docker(['cp',join(here,s),`${n.control}:${paths.control}/${s}`]);
    const stage=mkdtempSync(join(dirname(rpath),'medplum-drill-public-'));
    for(const name of Object.keys(p.files))writeFileSync(join(stage,name),readFileSync(join(ppath,name)),{mode:0o600,flag:'wx'});
    writeFileSync(join(stage,'package.json'),JSON.stringify({schema:1,platform:p.platform,files:p.files,packageHash:p.packageHash,profileHash:p.profileHash,state:p.state}),{mode:0o600,flag:'wx'});
    docker(['cp',stage,`${n.control}:${paths.control}/package`]); // Copy only the explicit verified file map; never extra private-directory contents.
    // Interval pressure checks are read-only and scoped to this already-admitted native slot.
    timer=setInterval(()=>{try {const observation=tools();if(observation.availableMiB<256||observation.freeDiskMiB<1024){pressureFailed=true;docker(['stop','--time','10',n.control]);}}catch{pressureFailed=true;try{docker(['stop','--time','10',n.control]);}catch{}}},5000);
    const attach=dependencies.attach??((args)=>promisify(execFile)('docker',args,{env,timeout:600000,maxBuffer:65536,encoding:'utf8',signal:abort.signal}));
    let attachOk=true; try {await attach(['start','--attach',n.control]);}catch{attachOk=false;} clearInterval(timer); timer=undefined;
    // A nonzero process still may have written a valid failure observation; retain it once.
    const output=join(dirname(rpath),`medplum-drill-result-${id}.json`); docker(['cp',`${n.control}:${paths.control}/result.json`,output]); const info=lstatSync(output); if(!info.isFile()||info.size>65536)throw new Error('bounded-native-result-required');
    result=safeControlResult(JSON.parse(readFileSync(output)));
    if(result.state==='synthetic-package-checkpoint-restored'&&(!attachOk||pressureFailed))result={state:'failed-or-unknown',automaticRetry:false,trafficOpened:false,observedControlState:result.state,failureStep:pressureFailed?'pressure-stopped':'attach-nonzero'};
    result={...result,id,sourceProject:n.source,targetProject:n.target,retainedVolumes:n.volumes.map(v=>v.name),archiveKeyExported:false};
  } catch { result={state:'failed-or-unknown',id,automaticRetry:false,trafficOpened:false,pressureFailed}; }
  finally {
    clearInterval(timer); process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt); if(admitted) {try{stopOwned();}catch{cleanup=false;}
      if(!cleanup)result={...result,state:'failed-or-unknown',id,automaticRetry:false,cleanupVerified:false};
      writeFileSync(rpath,JSON.stringify({...result,cleanupVerified:cleanup},null,2)+'\n',{flag:'wx',mode:0o600});
    }
  }
  return {state:admitted?result.state:'preflight-rejected-zero-native-mutations',cleanupVerified:cleanup,receipt:admitted?rpath:undefined};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw new Error('explicit-argument-required');return args[i+1];};
    const out=await execute({packagePath:value('--package'),receipt:value('--receipt'),id:value('--id'),executeSyntheticOwned:args.includes('--execute-synthetic-owned')}); console.log(JSON.stringify(out)); if(out.state!=='synthetic-package-checkpoint-restored')process.exitCode=1;
  }catch{console.error('medplum-native-qualification-refused-or-unknown');process.exitCode=1;}
}
