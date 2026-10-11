/** AF71/72/73 only. Offline by default; exact source, review and allocation precede secrets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,existsSync,lstatSync,mkdirSync,realpathSync } from 'node:fs';
import { resolve,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { validateFullDevelopmentAllocation } from './adaptive-full-reservation.mjs';
export const extractionCandidate='3554c43c77acaab9ec6f858557ba69ba20abb9d9f2fa7aaa8a11b08ea7f732b0';
export const operations=[{id:'DO-AF71',caseId:'G3',maximumOutputTokens:2048},{id:'DO-AF72',caseId:'P1',maximumOutputTokens:2048},{id:'DO-AF73',caseId:'G7',maximumOutputTokens:2048}];
const sha=b=>createHash('sha256').update(b).digest('hex'), evidence='docs/implementation/evidence/';
const pinsPath=evidence+'S3-EXTRACTION-SPARSE-V2-PINS.json',packetPath=evidence+'S3-EXTRACTION-SPARSE-V2-AUTHORED-PACKET.json',harnessPath=evidence+'S3-EXTRACTION-SPARSE-V2-FLASH-LOW-HARNESS.json';
export function verifyPins(pins,read=readFileSync){assert(Array.isArray(pins)&&pins.length>0&&pins.length<1000);for(const p of pins)assert.equal(sha(read(p.path)),p.sha256,'source/emission drift: '+p.path);}
export function verifyInstalledRuntimeDependencies(inventoryBytes,expectedSha256,workspace){
 assert.equal(sha(inventoryBytes),expectedSha256,'accepted dependency inventory drift');
 const selected=JSON.parse(inventoryBytes).files.filter(p=>p.path.startsWith('node_modules/zod/')||p.path.startsWith('node_modules/ws/'));
 assert(selected.length>0&&selected.length<1000,'bounded accepted runtime dependency set');
 for(const p of selected){assert(p.path.split('/').every(part=>part&&part!=='.'&&part!=='..'),'dependency path');const absolute=resolve(workspace,p.path),stat=lstatSync(absolute);assert(stat.isFile()&&!stat.isSymbolicLink()&&realpathSync(absolute)===absolute,'regular exact installed dependency');assert.equal(sha(readFileSync(absolute)),p.sha256,'installed runtime dependency drift: '+p.path);}
 return selected.length;
}
function verifyCandidate(){
 assert.equal(sha(readFileSync(pinsPath)),'a9f5875479057dc3576b73f1ad16be41aef08e6dc8e3fbce70cfc9e5df66a714');
 assert.equal(sha(readFileSync(packetPath)),'1d3df35af46f16542040d97e442263a088adfe4c63128d9ecc17c457ab834600');
 const pins=JSON.parse(readFileSync(pinsPath)),packet=JSON.parse(readFileSync(packetPath)),harness=JSON.parse(readFileSync(harnessPath));
 assert.equal(pins.candidateSha256,extractionCandidate);assert.equal(packet.candidateSha256,extractionCandidate);
 verifyPins(pins.pairs.flatMap(p=>[{path:p.source,sha256:p.sourceSha256},{path:p.emitted,sha256:p.emittedSha256}]));verifyPins(pins.authoredPins);
 verifyPins([{path:pins.runtimePath,sha256:pins.runtimeSha256}]);
 const runtimeManifest=JSON.parse(readFileSync(pins.runtimePath)),dependencyPath=resolve(pins.runtimePath,'../DEPENDENCIES-MANIFEST.json');
 verifyInstalledRuntimeDependencies(readFileSync(dependencyPath),runtimeManifest.inventories['DEPENDENCIES-MANIFEST.json'].sha256,resolve(process.cwd()));
 // Check the actual resolver used by emitted modules; a build-local/NODE_PATH alternative is not issued.
 const emittedRequire=createRequire(resolve('.extraction-sparse-v2-build/packages/clinical-core/src/digitalocean.js'));
 for(const name of ['zod','ws'])assert(emittedRequire.resolve(name).startsWith(resolve('node_modules',name)+'/'),'unissued runtime dependency resolution');
 assert.equal(harness.bindings.extractionCandidateSha256,extractionCandidate);assert.equal(harness.candidateSha256,sha(JSON.stringify(harness.bindings)));verifyPins(harness.bindings.files);
 assert.equal(packet.threeCaseUsefulBehaviorAcceptance,false);assert.equal(packet.cases.find(c=>c.caseId==='P1').readback.usefulBehaviorPass,false);
 const flashPath=evidence+'S3-EXTRACTION-SPARSE-V2-FLASH-LOW-REQUESTS.json';assert.equal(sha(readFileSync(flashPath)),'4f8855a76eb82306221fcfe50a2ab492a61708145149c5ad0471477414b5bb89');const flash=JSON.parse(readFileSync(flashPath));assert.equal(flash.extractionCandidateSha256,extractionCandidate);return{pins,packet,harness,flash};
}
export function validateBatchAllocation(raw,preflights,now=Date.now()){
 assert.equal(preflights.length,3);assert.equal(raw.operations?.length,3,'exactly three issued operations');assert(raw.creditsCap<=3,'max three existing credits');
 assert(Date.parse(raw.expiresAt)-Date.parse(raw.issuedAt)<=3600000,'max one hour authority');
 const reservations=preflights.map((p,i)=>{assert.equal(raw.operations[i].id,p.id,'ordered operations');assert.equal(raw.operations[i].caseId,p.caseId);assert(raw.operations[i].creditsCap<=1);return validateFullDevelopmentAllocation(raw,p,now);});
 assert.equal(raw.operations.reduce((n,p)=>n+p.creditsCap,0),raw.creditsCap,'no unassigned allowance');return reservations;
}
export function oneOperationFetch(fetcher,requestHash){let calls=0;return{count:()=>calls,fetcher:async(url,init)=>{
 assert.equal(String(url),'https://inference.do-ai.run/v1/chat/completions');assert.equal(init?.method,'POST');assert.equal(typeof init?.body,'string');assert.equal(sha(init.body),requestHash,'exact request required');assert.equal(calls,0,'no retry/fallback');calls++;return fetcher(url,{...init,redirect:'error'});
}};}
export async function runFiniteBatch(entries,execute){const results=[];let stopped=false;for(const entry of entries){if(stopped){results.push({id:entry.id,caseId:entry.caseId,state:'not-dispatched-after-prior-transport-or-schema-failure',callCount:0});continue;}const result=await execute(entry);results.push(result);if(!result.schemaCompatibilityObserved)stopped=true;}return results;}
function privateFile(p,max){assert(p&&isAbsolute(p),'absolute private file');const stat=lstatSync(p);assert(stat.isFile()&&!stat.isSymbolicLink()&&realpathSync(p)===p&&stat.size<=max&&!(stat.mode&0o077),'bounded mode0600 regular private file');}
async function preflight(){
 const{packet,harness,flash}=verifyCandidate();
 const build='../../.extraction-sparse-v2-build/';
 const[stream,codec,fixture,domain,compact,diagnostics]=await Promise.all([import('./digitalocean-flash-low.mjs'),import(build+'scripts/qualification/extraction-sparse-v2-manifest.js'),import(build+'scripts/qualification/fixtures/adaptive-extraction-sparse-v2-readback.js'),import(build+'packages/clinical-core/src/domain.js'),import(build+'packages/clinic-api/src/adaptive-reply-compact.js'),import('../../.extraction-grouped-diagnostic-build/packages/clinical-core/src/http-rejection-diagnostics.js')]);
 const entries=[];
 for(const op of operations){const authored=packet.cases.find(c=>c.caseId===op.caseId),context=fixture.sparseCaseContext(op.caseId),manifest=await codec.createSparseManifest(context);assert.deepEqual(manifest,authored.manifest,'exact manifest/context/source/schema/messages');const config={endpoint:'https://inference.do-ai.run',model:'glm-5.3-flash',timeoutMs:30000,maxOutputTokens:op.maximumOutputTokens,maxRequestBytes:131072,responseFormat:{type:'json-schema',name:codec.sparseSchemaName,schema:manifest.jsonSchema}};const request=await stream.prepareDigitalOceanStreamRequest({...config,apiKey:'offline-preflight-only'},[...manifest.messages]);const pinned=flash.cases.find(r=>r.caseId===op.caseId&&r.model==='glm-5.3-flash');assert.equal(request.body,pinned.body);assert.equal(sha(request.body),pinned.sha256);assert.equal(config.maxOutputTokens,pinned.maxOutputTokens);
 const p={...op,developmentCaseIds:['G3','P1','G7'],candidateSha256:harness.candidateSha256,extractionCandidateSha256:extractionCandidate,model:config.model,reasoningEffortSent:'low',reasoningControlHonored:false,requestBodySha256:sha(request.body),requestBytes:request.requestBytes,manifestSha256:manifest.sha256,contextSha256:manifest.contextSha256,nativeDefinition:manifest.nativeDefinition,timeoutMs:30000,maximumCalls:1,creditsCap:1,cashCap:0,streamLimits:stream.fullStreamLimits(op.maximumOutputTokens),P1UsefulBehaviorPass:false,threeCaseUsefulBehaviorAcceptance:false,nativeMappingQualified:false};entries.push({...p,manifest,context,authored,config});}
 return{entries,stream,codec,fixture,domain,compact,diagnostics,harness};
}
async function main(){
 const args=new Map(),allowed=new Set(['--live','--reservation','--env','--review']);for(let i=2;i<process.argv.length;i++){const key=process.argv[i];assert(allowed.has(key)&&!args.has(key));args.set(key,key==='--live'?true:process.argv[++i]);assert(args.get(key));}
 const live=args.has('--live');assert(live||args.size===0,'offline reads no authority/secrets');assert(!live||args.size===4,'all three private authority/env files required');
 const workspace=resolve(fileURLToPath(new URL('../../',import.meta.url)));assert.equal(resolve(process.cwd()),workspace,'exact workspace required');
 const prep=await preflight();const summaries=prep.entries.map(({manifest,context,authored,config,...p})=>p);
 if(!live){console.log(JSON.stringify({schema:1,state:'offline-preflight-only',candidateSha256:prep.harness.candidateSha256,extractionCandidateSha256:extractionCandidate,operations:summaries,totalMaximumCalls:3,totalCreditCap:3,cashCap:0,allowance:false,callCount:0,stopAfterTransportOrSchemaFailure:true}));return;}
 privateFile(args.get('--reservation'),16384);let reservations=validateBatchAllocation(JSON.parse(readFileSync(args.get('--reservation'))),summaries);
 privateFile(args.get('--review'),8192);const review=JSON.parse(readFileSync(args.get('--review')));
 assert.deepEqual(Object.keys(review).sort(),['candidateSha256','decision','extractionCandidateSha256','harnessSha256','reviewer','schema']);assert.equal(review.schema,1);assert.equal(review.decision,'accepted-for-root-allocation');assert.equal(review.reviewer,'sol_native_questionnaire_review');assert.equal(review.candidateSha256,prep.harness.candidateSha256);assert.equal(review.extractionCandidateSha256,extractionCandidate);assert.equal(review.harnessSha256,sha(readFileSync(fileURLToPath(import.meta.url))));
 const ledger=readFileSync('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md','utf8'),allocation=reservations[0];const rows=ledger.split('\n').filter(r=>r.startsWith('| '+allocation.allocationId+' /'));
 assert(rows.length===1&&operations.every(p=>rows[0].includes(p.id.replace('DO-','')))&&rows[0].includes(prep.harness.candidateSha256)&&rows[0].includes('existing-credit')&&rows[0].includes('cash0')&&rows[0].includes(allocation.expiresAt),'exact root existing-credit cash0 ledger allocation required');
 for(const op of operations)for(const p of [evidence+op.id+'-INTENT.json',evidence+op.id+'.json',evidence+'SPARSE-'+prep.harness.candidateSha256+'-'+op.caseId+'-INTENT.json',resolve(workspace,'infra/cloud/.private',op.id+'-PREFIX.json'),resolve(workspace,'infra/cloud/.private',op.id+'-HTTP-DIAGNOSTIC.json')])assert(!existsSync(p),'preserve prior intent/result; never retry');
 const batchPath=evidence+'S3-EXTRACTION-SPARSE-'+prep.harness.candidateSha256+'-BATCH.json';assert(!existsSync(batchPath),'batch evidence already exists');
 privateFile(args.get('--env'),65536);loadEnvFile(args.get('--env'));const apiKey=process.env.DIGITALOCEAN_MODEL_ACCESS_KEY||process.env.DIGITALOCEAN_MODEL_ACESS_KEY;assert(apiKey,'missing model key');mkdirSync(resolve(workspace,'infra/cloud/.private'),{recursive:true});
 const results=await runFiniteBatch(prep.entries,async entry=>{
  // Every dispatch rechecks finite authority, immutable source and prior intent.
  reservations=validateBatchAllocation(JSON.parse(readFileSync(args.get('--reservation'))),summaries);verifyCandidate();const p=summaries.find(p=>p.id===entry.id),reservation=reservations.find(r=>r.selected.id===entry.id),prefix=evidence+entry.id,privatePrefix=resolve(workspace,'infra/cloud/.private',entry.id);
  const intent={...p,state:'dispatch-intent',outcome:'unknown',reservation,reviewSha256:sha(readFileSync(args.get('--review'))),at:new Date().toISOString()};writeFileSync(evidence+'SPARSE-'+prep.harness.candidateSha256+'-'+entry.caseId+'-INTENT.json',JSON.stringify(intent,null,2)+'\n',{flag:'wx'});writeFileSync(prefix+'-INTENT.json',JSON.stringify(intent,null,2)+'\n',{flag:'wx'});
  const one=oneOperationFetch(fetch,p.requestBodySha256),diagnostic=prep.diagnostics.diagnosticFetch(one.fetcher,Date.now()+30000),partial=prep.compact.createSyntheticPartialCapture();let result,compiled,raw,errorCode,appReadback;
  try{result=await prep.stream.digitalOceanStream({...entry.config,apiKey},diagnostic.fetcher,()=>performance.now(),p.streamLimits).generate([...entry.manifest.messages],{onContent:t=>partial.append(t)});raw=JSON.parse(result.text);compiled=prep.codec.decodeSparseExtraction(raw,entry.manifest);}catch(error){errorCode=typeof error?.code==='string'&&/^[a-z][a-z0-9-]{0,79}$/.test(error.code)?error.code:'sparse-qualification-failed';if(!result&&error?.receipt)result={receipt:error.receipt};}
  try{appReadback=await prep.fixture.sparseCaseReadback(entry.caseId,{...(compiled?{raw}:{}),receipt:result?.receipt,errorCode});}catch{appReadback={state:'readback-failed',offlineResponseReplay:true,usefulBehaviorPass:false};}
  writeFileSync(privatePrefix+'-PREFIX.json',JSON.stringify({id:entry.id,candidateSha256:prep.harness.candidateSha256,partial:partial.snapshot()},null,2)+'\n',{flag:'wx',mode:0o600});const httpDiagnostic=diagnostic.snapshot();if(httpDiagnostic)writeFileSync(privatePrefix+'-HTTP-DIAGNOSTIC.json',JSON.stringify(httpDiagnostic,null,2)+'\n',{flag:'wx',mode:0o600});
  const observedUseful=Boolean(compiled&&appReadback?.timings?.nextQuestionSavedMs!=null),receipt={...p,state:compiled?'output-decoded-awaiting-semantic-review':'qualification-failed',callCount:one.count(),providerReceipt:result?.receipt??{outcome:'unknown',providerExecution:'unknown',usage:'unknown'},...(errorCode?{errorCode}:{}),...(compiled?{rawOutput:raw,draft:compiled.draft,normalizedCapture:compiled.capture}:{}),appReadback,httpDiagnostic,partialContentEvidence:{...partial.snapshot(),utf8:undefined,privateSha256:sha(readFileSync(privatePrefix+'-PREFIX.json'))},reservation:{...reservation,consumed:true,refund:false},schemaCompatibilityObserved:Boolean(compiled),authoredTypedDraftExact:Boolean(compiled&&sha(prep.domain.canonicalJson(compiled.draft))===entry.authored.authored.typedDraftSha256),observedUsefulContinuation:observedUseful,usefulBehaviorPass:entry.caseId==='P1'?false:observedUseful,P1UsefulBehaviorPass:false,threeCaseUsefulBehaviorAcceptance:false,observedResultRequiresHumanSemanticReview:true,semanticQualification:false,latencyQualified:false,nativeMappingQualified:false,holdoutRead:false,defaultEnabled:false,note:'One issued request only; no retry/fallback. Unknown charges consumed. Historical P1 useful=false retained; local replay does not qualify hosted/native delivery.'};writeFileSync(prefix+'.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({id:entry.id,state:receipt.state,callCount:one.count(),receipt:prefix+'.json',semanticQualification:false}));return receipt;
 });
 writeFileSync(batchPath,JSON.stringify({schema:1,candidateSha256:prep.harness.candidateSha256,extractionCandidateSha256:extractionCandidate,operations:results.map(r=>({id:r.id,caseId:r.caseId,state:r.state,callCount:r.callCount,schemaCompatibilityObserved:r.schemaCompatibilityObserved??false})),callCount:results.reduce((n,r)=>n+r.callCount,0),stopAfterTransportOrSchemaFailure:true,cashCap:0,semanticQualification:false,threeCaseUsefulBehaviorAcceptance:false,P1UsefulBehaviorPass:false,nativeMappingQualified:false,holdoutRead:false,defaultEnabled:false},null,2)+'\n',{flag:'wx'});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Sparse batch blocked or failed. Preserve every intent/receipt and consumed unknown allowance; no retry.');process.exitCode=1;});
