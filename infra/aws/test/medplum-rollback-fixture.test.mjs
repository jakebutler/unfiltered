/** Offline execution of the actual current/historical fixture modules; no real fetch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CHECK_STAGES, safeChecks, safeControlResult } from '../medplum/qualify-boundaries.mjs';
const system = 'https://unfiltered.example/synthetic-restore-fixture';
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const resource = (type,n) => ({resourceType:type,id:id(n),meta:{versionId:id(n+20)}});
async function executeFixture({ historical=false, positiveMissing=false, rollbackPresent=false }={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'uf-rollback-fixture-'))), before={fetch:globalThis.fetch,args:process.argv,exit:process.exitCode}, events=[];
  const bytes='synthetic Binary bytes', patient={...resource('Patient',1),identifier:[{system,value:'positive-synthetic'}]},other=resource('Patient',2), document={...resource('DocumentReference',3),subject:{reference:`Patient/${patient.id}`}},binary=resource('Binary',4),ledger={...resource('DocumentReference',5),identifier:[{value:'synthetic-lifetime'}],content:[{attachment:{data:'private-ledger-marker'}}]};
  writeFileSync(join(root,'fixture.private.json'),JSON.stringify({setup:{id:id(9),secret:'private-unused-secret'},scopedToken:'synthetic-scoped',revokedToken:'synthetic-revoked',patient,other,document,binary,ledger,firstVersion:id(8),binaryHash:createHash('sha256').update(bytes).digest('hex'),project:{id:id(6)}}),{mode:0o600});
  const response=(v,status=200)=>new Response(typeof v==='string'?v:JSON.stringify(v),{status});
  globalThis.fetch=async(url,init)=>{
    const u=new URL(url),path=u.pathname,auth=init.headers.Authorization;events.push({url,method:init.method,body:init.body});
    if(path==='/oauth2/token')return response({access_token:'synthetic-setup'});
    if(path==='/fhir/R4' && init.method==='POST') {
      const bundle=JSON.parse(init.body);
      // Pinned repository rejects new-ID PUT by project clients before stale412.
      if(bundle.entry[0].request.method==='PUT')return response({},404);
      assert.equal(bundle.type,'transaction'); assert.equal(bundle.entry.length,2);
      assert.deepEqual(bundle.entry[0].request,{method:'POST',url:'Patient'});assert(!('id'in bundle.entry[0].resource));
      assert.equal(bundle.entry[0].resource.identifier[0].system,system);assert.match(bundle.entry[0].resource.identifier[0].value,/^rollback-[a-f0-9-]{36}$/);
      assert.equal(bundle.entry[1].request.method,'PUT');assert.equal(bundle.entry[1].request.url,`Patient/${patient.id}`);assert.equal(bundle.entry[1].request.ifMatch,`W/"${id(8)}"`);
      return response({},412);
    }
    if(path===`/fhir/R4/Patient/${patient.id}` && init.method==='PUT')return response({},412);
    if(path==='/fhir/R4/Patient' && u.searchParams.has('identifier')) {
      assert.equal(auth,'Bearer synthetic-setup');assert.equal(u.searchParams.get('_total'),'accurate');assert.equal(u.searchParams.get('_count'),'2');
      if(u.searchParams.get('identifier')===`${system}|positive-synthetic`)return response({resourceType:'Bundle',total:positiveMissing?0:1,entry:positiveMissing?[]:[{resource:patient}]});
      assert(u.searchParams.get('identifier').startsWith(`${system}|rollback-`));return response({resourceType:'Bundle',total:rollbackPresent?1:0,entry:rollbackPresent?[{resource:patient}]:[]});
    }
    if(path===`/fhir/R4/Patient/${patient.id}/_history`)return response({entry:[{},{}]});
    if(path===`/fhir/R4/Patient/${patient.id}/_history/${id(8)}`)return response({name:[{family:'SyntheticBefore'}]});
    if(path===`/fhir/R4/Patient/${patient.id}`)return response(patient, !auth || auth==='Bearer synthetic-revoked'?403:200);
    if(path===`/fhir/R4/Patient/${other.id}`)return response(other,auth==='Bearer synthetic-scoped'?404:200);
    if(path===`/fhir/R4/DocumentReference/${document.id}`)return response(document);
    if(path===`/fhir/R4/DocumentReference/${ledger.id}`)return response(ledger);
    if(path===`/fhir/R4/Binary/${binary.id}`)return response(init.headers.Accept==='text/plain'?bytes:{securityContext:{reference:`DocumentReference/${document.id}`}});
    throw new Error('offline-unexpected-request');
  };
  try {
    process.argv=[before.args[0],'offline-native-client','verify',root];process.exitCode=undefined;
    const path=historical?new URL('../.private/medplum-qualifier-q1-source/qualify-client.mjs',import.meta.url):new URL('../medplum/qualify-client.mjs',import.meta.url);
    await import(`${pathToFileURL(path.pathname).href}?case=${Date.now()}-${Math.random()}`);
    return {events,proof:existsSync(join(root,'verify.proof.json')),exit:process.exitCode,checks:existsSync(join(root,'verify.checks.json'))?JSON.parse(readFileSync(join(root,'verify.checks.json'))):undefined};
  } finally {globalThis.fetch=before.fetch;process.argv=before.args;process.exitCode=before.exit;rmSync(root,{recursive:true,force:true});}
}
test('historical actual client reproduces project new-ID PUT404 instead of expected412',async()=>{
  const r=await executeFixture({historical:true});assert.equal(r.proof,false);assert.equal(r.exit,1);
  const e=r.events.find(e=>new URL(e.url).pathname==='/fhir/R4');assert(e);assert.equal(JSON.parse(e.body).entry[0].request.method,'PUT');
});
test('current client proves exact positive search, POST/stalePUT and absence, preserving setup authority',async()=>{
  const r=await executeFixture();assert.equal(r.proof,true);assert.notEqual(r.exit,1);assert.equal(r.checks.state,'checks-passed');assert.deepEqual(r.checks.rows.map(r=>r.stage),CHECK_STAGES);
  const search=r.events.filter(e=>new URL(e.url).pathname==='/fhir/R4/Patient'),transaction=r.events.findIndex(e=>new URL(e.url).pathname==='/fhir/R4');
  assert.equal(search.length,2);assert(r.events.indexOf(search[0])<transaction && r.events.indexOf(search[1])>transaction);
  assert.equal(r.events.filter(e=>new URL(e.url).pathname==='/oauth2/token').length,1);
});
test('missing positive search control prevents every mutation check',async()=>{
  const r=await executeFixture({positiveMissing:true});assert.equal(r.proof,false);assert.equal(r.checks.rows.at(-1).stage,'identifier-positive-control');assert.equal(r.checks.rows.at(-1).outcome,'expectation-failed');
  assert(!r.events.some(e=>e.method==='PUT'||new URL(e.url).pathname==='/fhir/R4'));
});
test('nonempty rollback search produces fixed failed stage and no successful proof',async()=>{
  const r=await executeFixture({rollbackPresent:true});assert.equal(r.proof,false);assert.deepEqual(r.checks.rows.at(-1),{stage:'rollback-absence',status:200,outcome:'expectation-failed'});
  assert(!JSON.stringify(r.checks).includes('private-ledger-marker'));assert(!JSON.stringify(r.checks).includes('private-unused-secret'));
});
test('control result retains sanitized failure checks but strips private extra strings',()=>{
  const checks={state:'checks-failed-or-unknown',rows:[{stage:'setup-token',status:401,outcome:'expectation-failed',raw:'private-marker'}]};
  const r=safeControlResult({state:'failed-or-unknown',failureStep:'source-fixture',checks:{seed:checks},raw:'private-marker'});
  assert.deepEqual(r.checks.seed.rows,[{stage:'setup-token',status:401,outcome:'expectation-failed'}]);assert(!JSON.stringify(r).includes('private-marker'));
  assert.throws(()=>safeChecks({state:'checks-passed',rows:[]}));assert.throws(()=>safeChecks({state:'checks-failed-or-unknown',rows:[{stage:'untrusted-private-string',status:200,outcome:'pass'}]}));
});
