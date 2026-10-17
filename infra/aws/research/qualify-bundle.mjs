/** Exact bundled-server acceptance with synthetic finite transport; no cloud/VM/provider work. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFileSync,writeFileSync,lstatSync,realpathSync } from 'node:fs';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { newPrivateOutput } from '../io.mjs';
const root=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'../../..'));
const arg=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error('explicit-bundle-qualification-arguments-required');return process.argv[i+1];};
if(process.versions.node!=='22.22.3')throw Error('pinned-node-required');
const directory=realpathSync(resolve(arg('--package'))),output=newPrivateOutput(root,arg('--receipt'));
if(dirname(directory)!==join(root,'infra/aws/.private')||lstatSync(directory).isSymbolicLink())throw Error('owned-package-required');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const packageReceipt=JSON.parse(readFileSync(join(directory,'package-receipt.json')));
assert.equal(packageReceipt.state,'packaged-container-unbuilt');
const verify=()=>{for(const row of packageReceipt.files){assert(!row.path.startsWith('/')&&!row.path.split('/').includes('..'));const path=join(directory,row.path);assert(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink());assert.equal(sha(readFileSync(path)),row.sha256);}};
verify();
const receipt={schema:1,state:'started',packageArtifactHash:packageReceipt.artifactHash,serverSha256:sha(readFileSync(join(directory,'server.cjs'))),startedAt:new Date().toISOString(),mode:'bundled-node-http-modeled-native-transport',cloudCalls:0,providerCalls:0,checks:{},transportCalls:[],cleanup:false};
const save=()=>writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
const nativeFetch=globalThis.fetch;
let app,speech,leases=new Map(),generation=0,operationCount=0,logoutCount=0,currentCommand;
try{
  const bundled=createRequire(import.meta.url)(join(directory,'server.cjs'));
  for(const name of['awsResearchConfig','createAwsResearchServer','loadResearchAssets','assembleAwsProviders','startAwsResearchApplication'])assert.equal(typeof bundled[name],'function');
  const manifest=JSON.parse(readFileSync(join(directory,'deployment-manifest.json'))),binary=JSON.parse(readFileSync(join(directory,'ffmpeg-manifest.json')));
  const runtime={gatewaySecret:'a'.repeat(64),allocationId:'bundle-acceptance-allocation',credentialSource:'ec2-imdsv2',s3:{bucket:'synthetic-bundle-bucket',region:'us-east-1',accountId:'123456789012',namespace:manifest.authority.objectNamespace,kmsKeyArn:'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc'},recovery:{state:'fresh-or-reconciled',identity:'b'.repeat(64)},maxSegmentBytes:4000000,maxResponseBytes:4000000,liveProvidersEnabled:false};
  const settings=bundled.awsResearchConfig(manifest,runtime,binary,join(directory,'bin/ffmpeg'));
  // Explicit finite in-memory admission; production authority code below still
  // serializes/sends signed requests through the intercepted HTTP transport.
  const authority={
    async acquire(input){assert(generation<8);const row={...input,leaseId:'bundle-lease-'+(++generation),generation,allocationId:settings.config.allocationId,bodyDeadlineAt:Date.now()+8000,responseDeadlineAt:Date.now()+30000,expiresAt:Date.now()+45000};leases.set(row.leaseId,row);return row;},
    async inspect(input){return leases.get(input.leaseId)??null;},async beginWork(input){return leases.has(input.leaseId);},async release(input){return leases.delete(input.leaseId);},
    async reserveOperation(input){assert(leases.has(input.leaseId));assert(++operationCount<=16);return true;},async claimCleanup(){throw Error('cleanup-unissued');},async finishCleanup(){throw Error('cleanup-unissued');},
  };
  const adapters=bundled.assembleAwsProviders(settings,authority);speech=adapters.speech;
  const facts=adapters.readinessFacts();assert.equal(facts.capture.gatewayAllocationId,settings.config.allocationId);assert.equal(facts.analysis.qualified,false);assert.equal(adapters.analysisRuntime.preparedOnly,true);
  globalThis.fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,settings.config.deployment);assert(['/api/query','/api/mutation'].includes(url.pathname));assert(receipt.transportCalls.length<16);
    const body=JSON.parse(init.body),args=Array.isArray(body.args)?body.args[0]:body.args;const path=body.path;
    if(args.runtime){assert.equal(args.runtime.configurationDigest,facts.configurationDigest);assert.equal(args.runtime.capture.gatewayAllocationId,settings.config.allocationId);}
    // Retain operation names/counts only; no capability, signing proof or row JSON.
    receipt.transportCalls.push({path,method:url.pathname.slice(5),factsBound:!!args.runtime});
    let value;
    if(path==='researchReadiness:snapshot')value={state:'offline-modeled',scope:args.scope,runtime:args.runtime};
    else if(path==='researchReadiness:command'){currentCommand=args.command;value={state:'applied',requestId:currentCommand.requestId};}
    else if(path==='researchReadiness:receipt'){assert.deepEqual(args.command,currentCommand);value={state:'applied',requestId:currentCommand.requestId};}
    else if(path==='researchCaptureTests:preview')value={state:'offline-modeled',scope:args.scope};
    else if(path==='researchStudyAnalysis:prepare')value={state:'prepared',requestId:args.requestId,sourceBinding:'c'.repeat(64)};
    else if(path==='researchStudyAnalysis:readPrepared')value={state:'prepared',requestId:args.requestId,sourceBinding:'c'.repeat(64)};
    else if(path==='research:me')value={id:'synthetic-operator'};
    else if(path==='researchPortal:logout'){assert.equal(args.token,'b'.repeat(64));logoutCount++;value=null;}
    else throw Error('unissued-modeled-operation');
    return Response.json({status:'success',value});
  };
  const store={async head(){throw Error('storage-unissued');},async read(){throw Error('storage-unissued');},async putIfAbsent(){throw Error('storage-unissued');},async retire(){throw Error('storage-unissued');}};
  app=bundled.createAwsResearchServer(settings.config,settings.binding,bundled.loadResearchAssets(join(directory,'site-assets')),{store,hostedAuthority:authority,analysisRuntime:adapters.analysisRuntime,readinessFacts:adapters.readinessFacts},speech,adapters.interviewRuntime);
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const address=app.server.address();assert(address&&typeof address!=='string');
  const call=(path,{method='GET',body,headers={}}={})=>new Promise((resolveCall,reject)=>{
    const text=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
    const req=httpRequest({host:'127.0.0.1',port:address.port,path,method,headers:{Host:new URL(settings.config.publicOrigin).host,Origin:settings.config.publicOrigin,Authorization:'Bearer synthetic-bundle-operator',...(text===undefined?{}:{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(text))}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>resolveCall({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));});req.setTimeout(5000,()=>req.destroy(Error('local-http-deadline')));req.once('error',reject);req.end(text);
  });
  const scope={clientId:'client',projectId:'project',studyId:'study',studyVersion:6};
  const page=await call('/');assert.equal(page.status,200);assert(page.text.includes('<html'));assert(page.headers['content-security-policy'].includes(settings.config.deployment));assert(!page.headers['content-security-policy'].includes('elegant-crane'));receipt.checks.hashedActualSiteAndIndependentCsp=true;
  const snapshot=await call('/api/research/study-readiness?'+new URLSearchParams({...scope,studyVersion:String(scope.studyVersion)}));assert.equal(snapshot.status,200);assert.equal(JSON.parse(snapshot.text).runtime.configurationDigest,facts.configurationDigest);receipt.checks.sameConfigAllocationAndFacts=true;
  const command={scope,expectedRevision:'d'.repeat(64),capability:'scripted-text',enabled:true,requestId:'bundle-command-request'};
  for(const path of['/api/research/study-readiness/command','/api/research/study-readiness/receipt'])assert.equal((await call(path,{method:'POST',body:command})).status,200);
  receipt.checks.ordinaryCommandAndReceipt=true;
  assert.equal((await call('/api/research/study-welcome',{method:'POST',body:{scope}})).status,200);receipt.checks.ordinaryWelcomeRoute=true;
  const preparation={scope,requestId:'bundle-analysis-preparation',selections:[{sessionId:'session',kind:'self-report',id:'source',start:0,end:4}]};
  for(const path of['/api/research/analysis/prepare','/api/research/analysis/prepare/receipt'])assert.equal((await call(path,{method:'POST',body:preparation})).status,200);
  receipt.checks.ordinaryPreparationAndReceipt=true;
  const rejected=await call('/api/research/analysis',{method:'POST',body:{clientId:'client',projectId:'project',requestId:'bundle-static-request',reservationId:'static-unprepared',selections:preparation.selections}});assert.equal(rejected.status,409);assert(!receipt.transportCalls.some(row=>row.path==='researchAnalysis:admit'));receipt.checks.unpreparedDispatchDenied=true;
  const logoutHeaders={Cookie:'research_viewer='+'b'.repeat(64)};
  for(const headers of[logoutHeaders,{...logoutHeaders,'Content-Length':'0'}])assert.equal((await call('/api/research/portal/session',{method:'DELETE',headers})).status,204);
  assert.equal(logoutCount,2);
  assert.equal((await call('/api/research/portal/session',{method:'DELETE',body:'x',headers:logoutHeaders})).status,413);
  assert.equal((await call('/api/research/portal/session',{method:'DELETE',headers:{...logoutHeaders,'Transfer-Encoding':'chunked'}})).status,413);
  assert.equal((await call('/api/research/portal/session',{method:'DELETE',headers:{...logoutHeaders,Origin:'https://foreign.invalid'}})).status,403);assert.equal(logoutCount,2);receipt.checks.actualNodeBodylessLogoutAndFramedDenials=true;
  assert.equal((await call('/api/research/study-welcome',{method:'POST',body:{scope},headers:{Authorization:''}})).status,403);receipt.checks.ordinaryUnauthenticatedDenied=true;
  assert.equal(leases.size,0);receipt.checks.noUnsettledModeledLeases=true;
  verify();receipt.checks.packageFilesUnchanged=true;receipt.state='passed-bundled-offline-modeled-transport';
}catch{receipt.state='failed-retained-no-retry';process.exitCode=1;}
finally{globalThis.fetch=nativeFetch;if(app)await app.close();speech?.close();receipt.cleanup=leases.size===0;receipt.modeledOperations=operationCount;receipt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({state:receipt.state,receipt:output,checks:receipt.checks,cloudCalls:0,providerCalls:0,cleanup:receipt.cleanup}));}
