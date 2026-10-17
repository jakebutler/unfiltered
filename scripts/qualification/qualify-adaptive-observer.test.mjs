import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Evaluate only the actual observer and stop expression. Importing the CLI
// itself would execute its credential/ledger/receipt workflow.
const source = readFileSync(new URL('./qualify-adaptive.mjs', import.meta.url), 'utf8');
const maxCasesSource = source.slice(source.indexOf('function parseMaxCases(value)'), source.indexOf('const maxCases ='));
const parseMaxCases = vm.runInNewContext(`${maxCasesSource}\nparseMaxCases`, { assert });
test('case count accepts only explicit integers 1 through 8 and defaults to unchanged eight cases', () => {
  for (let count = 1; count <= 8; count++) assert.equal(parseMaxCases(String(count)), count);
  for (const invalid of [undefined, '', '0', '9', '1.5', 'NaN', 'Infinity', '-1', ' 1', '1e0']) assert.throws(() => parseMaxCases(invalid));
  assert(source.includes("parseMaxCases(process.argv.includes('--max-cases') ? arg('--max-cases') : '8')"));
  assert(source.includes('const selectedFixtures = fixtures.slice(0, maxCases);'));
  assert(source.includes('intendedCaseCount: selectedFixtures.length'));
  assert(source.includes('calls: preflightOnly ? 0 : selectedFixtures.length'));
  assert(source.includes('report.results.length === selectedFixtures.length'));
});
const observerSource = source.slice(source.indexOf('async function observeBody('), source.indexOf('const register ='));
assert(observerSource.startsWith('async function observeBody('));
const stopLine = source.split('\n').find(line => line.includes('if (!item.dispatchedAt') && line.includes('report.stoppedEarly'));
assert(stopLine);
const stopExpression = stopLine.slice(stopLine.indexOf('if (') + 4, stopLine.indexOf(') { report.stoppedEarly'));
class TransportError extends Error { constructor(code) { super(code); this.code = code; } }
const context = vm.createContext({ Buffer, TransportError });
const observeBody = vm.runInContext(`${observerSource}\nobserveBody`, context);
const mustStop = vm.runInContext(`item => (${stopExpression})`, context);

test('bounded observer preserves a complete synthetic JSON response', async () => {
  const observed = await observeBody(new Response(JSON.stringify({ id: 'synthetic', choices: [] })));
  assert.equal(observed.complete, true); assert.equal(observed.body.id, 'synthetic');
});

test('oversized observer stops after the bound without awaiting a teed cancellation', { timeout: 1000 }, async () => {
  let reads = 0, canceled = false, originalCanceled = false;
  const reader = { async read() { reads++; return { done: false, value: new Uint8Array(64000) }; }, cancel() { canceled = true; return new Promise(() => {}); } };
  const response = { clone: () => ({ body: { getReader: () => reader } }), body: { cancel() { originalCanceled = true; return new Promise(() => {}); } } };
  await assert.rejects(observeBody(response), error => error.code === 'response-too-large');
  assert.equal(reads, 5); assert.equal(canceled, true); assert.equal(originalCanceled, true);
});

test('completed observer never awaits teed cancellation and incomplete JSON is unobserved', { timeout: 1000 }, async () => {
  let done = false, canceled = false;
  const reader = { async read() { if (done) return { done: true }; done = true; return { done: false, value: Buffer.from('{') }; }, cancel() { canceled = true; return new Promise(() => {}); } };
  const observed = await observeBody({ clone: () => ({ body: { getReader: () => reader } }) });
  assert.equal(observed.complete, false); assert.equal(canceled, true);
});

test('observer preserves abort/timeout failures as incomplete outcomes', async () => {
  let canceled = false;
  const response = { clone: () => ({ body: { getReader: () => ({ read: async () => { throw new TransportError('timeout'); }, cancel: async () => { canceled = true; } }) } }) };
  await assert.rejects(observeBody(response), error => error.code === 'timeout'); assert.equal(canceled, true);
});

test('stop guard rejects unobserved/protocol/model/incomplete outcomes while retaining observed semantic trials', () => {
  const observed = { dispatchedAt: 'synthetic', httpStatus: 200, bodyObserved: true };
  for (const errorCode of ['timeout', 'network', 'response-too-large', 'invalid-inference-response', 'inference-model-mismatch', 'inference-incomplete-output', 'qualification-bound-exceeded']) assert.equal(mustStop({ ...observed, errorCode }), true, errorCode);
  assert.equal(mustStop({ ...observed, bodyObserved: false }), true);
  assert.equal(mustStop({ ...observed, httpStatus: 403 }), true);
  assert.equal(mustStop({ ...observed, dispatchedAt: undefined }), true);
  assert.equal(mustStop({ ...observed, errorCode: 'invalid-contextual-proposal' }), false);
  assert.equal(mustStop({ ...observed, errorCode: 'invalid-adaptive-json' }), false);
});

test('HTTP error JSON retains sanitized error detail and safe request identity without exposing keys', async () => {
  const secret = 'mock-key-do-not-retain';
  const response = new Response(JSON.stringify({ error: { code: 'schema_compile', message: `failed native grammar with ${secret}`, apiKey: 'other-key', authorization: 'Bearer unknown-token' }, request_id: 'synthetic-request' }), {status:500,headers:{'content-type':'application/json','x-request-id':'synthetic-header'}});
  const observed = await observeBody(response,{secrets:[secret]});
  assert.equal(observed.complete,true);assert.equal(observed.diagnostic.status,500);assert.equal(observed.diagnostic.bodyComplete,true);assert.equal(observed.diagnostic.jsonComplete,true);
  assert.equal(observed.diagnostic.requestId,'synthetic-header');
  const text=JSON.stringify(observed.diagnostic);
  assert.match(text,/schema_compile/);assert.match(text,/synthetic-request/);
  for(const key of [secret,'other-key','unknown-token'])assert.equal(text.includes(key),false);
  // The harness diagnostic does not rewrite the transport's original response.
  assert.equal((await response.json()).error.apiKey,'other-key');
});

test('non-JSON body evidence remains bounded, redacts credentials before clipping, and preserves Unicode boundaries', async () => {
  const secret='secret-cut-across-retention-boundary';
  const observed=await observeBody(new Response('upstream failure '+ 'x'.repeat(8150) +secret+'界'.repeat(400),{status:502,headers:{'content-type':'text/html'}}),{secrets:[secret]});
  assert.equal(observed.complete,false);assert.equal(observed.diagnostic.bodyComplete,true);assert.equal(observed.diagnostic.jsonComplete,false);assert.equal(observed.diagnostic.truncated,true);
  assert.ok(Buffer.byteLength(observed.diagnostic.bodyPrefix)<=8192);assert.equal(observed.diagnostic.bodyPrefix.includes('secret-cut'),false);assert.equal(observed.diagnostic.bodyPrefix.includes('\ufffd'),false);
  const html=await observeBody(new Response('<h1>failed</h1> Authorization: Bearer unknown-provider-key\napi_key=another-private-key',{status:500}));
  assert.match(html.diagnostic.bodyPrefix,/failed/);assert.doesNotMatch(html.diagnostic.bodyPrefix,/unknown-provider-key|another-private-key/);
});

test('partial body failure records sanitized evidence before preserving timeout and canceling both branches', async () => {
  let reads=0,originalCanceled=false,readerCanceled=false,recorded;
  const reader={async read(){if(reads++===0)return {done:false,value:Buffer.from('{"error":"partial upstream", "api_key":"mock-sensitive"')};throw new TransportError('timeout');},cancel(){readerCanceled=true;return new Promise(()=>{});}};
  const response={status:500,clone:()=>({body:{getReader:()=>reader}}),body:{cancel(){originalCanceled=true;return new Promise(()=>{});}}};
  await assert.rejects(observeBody(response,{secrets:['mock-sensitive'],record:value=>{recorded=value;}}),error=>error.code==='timeout');
  assert.equal(recorded.bodyComplete,false);assert.equal(recorded.jsonComplete,false);assert.equal(recorded.observationError,'timeout');assert.match(recorded.bodyPrefix,/partial upstream/);assert.equal(JSON.stringify(recorded).includes('mock-sensitive'),false);
  assert.equal(originalCanceled,true);assert.equal(readerCanceled,true);
});

test('oversized error persists only capped sanitized evidence without swallowing the bound failure', async () => {
  let recorded,reads=0;
  const reader={async read(){reads++;return {done:false,value:Buffer.from('x'.repeat(64000))};},cancel(){return new Promise(()=>{});}};
  const response={status:500,clone:()=>({body:{getReader:()=>reader}}),body:{cancel(){return new Promise(()=>{});}}};
  await assert.rejects(observeBody(response,{record:value=>{recorded=value;}}),error=>error.code==='response-too-large');
  assert.equal(reads,5);assert.equal(recorded.bytesRead,320000);assert.equal(recorded.truncated,true);assert.equal(recorded.bodyComplete,false);assert.equal(recorded.observationError,'response-too-large');assert.ok(Buffer.byteLength(recorded.bodyPrefix)<=8192);
});
