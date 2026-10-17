/** Prospective ONE-call compatibility probe. No default live execution, retry, sweep or fallback. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDigitalOceanStreamRequest, fullStreamLimits } from '../../.stream-full-build/packages/clinical-core/src/digitalocean-stream.js';
import { createFullReplyManifest, prepareFullCapture } from '../../.stream-full-build/packages/clinic-api/src/adaptive-reply-full.js';
import { createFullCompactManifest, consumeFullCompactStream as consumeReplyDraftStream, fullCompactProtocol as replyDraftProtocol, fullCompactSchemaName as replyDraftSchemaName, fullCompactValidationRevision as replyDraftValidationRevision, encodeFullCompactDraft } from '../../.stream-full-build/packages/clinic-api/src/adaptive-reply-full-compact.js';
import { createSyntheticPartialCapture } from '../../.stream-full-build/packages/clinic-api/src/adaptive-reply-compact.js';
import { fullDevelopmentContext, fullDevelopmentLabels, representativeFullDraft } from '../../.stream-full-build/scripts/qualification/fixtures/adaptive-full-development.js';
import { fullCaseContext, fullCaseLabels, fullCaseIds, representativeCaseDraft } from '../../.stream-full-build/scripts/qualification/fixtures/adaptive-full-cases.js';
import { fullCaseReadback } from '../../.stream-full-build/scripts/qualification/fixtures/adaptive-full-readback.js';
import { validateFullDevelopmentAllocation } from './adaptive-full-reservation.mjs';
const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const allowed = new Set(['--id', '--env', '--live', '--output-tokens', '--case', '--reservation']);
for (let i = 2; i < process.argv.length; i++) { assert(allowed.has(process.argv[i]), 'unsupported argument'); if (process.argv[i] !== '--live') { assert(process.argv[++i], 'missing argument'); } }
const id = argument('--id'), live = process.argv.includes('--live'), envPath = argument('--env'),caseId=argument('--case'),reservationPath=argument('--reservation');
assert(/^DO-AF[1-9][0-9]*$/.test(id ?? ''), 'explicit unique DO-AF operation required');
assert(live || !envPath, 'offline preflight must not load an environment');
assert(live || !reservationPath,'offline preflight does not consume a reservation');
assert(!caseId||fullCaseIds.includes(caseId),'explicit issued development case required; no batch/sweep selector');
const workspace = resolve(fileURLToPath(new URL('../../', import.meta.url)));
assert(resolve(process.cwd()) === workspace, 'run in this implementation workspace');
const prefix = `docs/implementation/evidence/${id}`;
for (const suffix of ['-INTENT.json', '.json']) assert(!existsSync(prefix + suffix), 'prior dispatch/result evidence exists; never overwrite/retry it');
if (!live) assert(!existsSync(prefix + '-PREFLIGHT.json'), 'preflight evidence already exists');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const buildDirectory = resolve('.stream-full-build');
const compiled = readdirSync(buildDirectory, { recursive: true }).filter(path => typeof path === 'string' && path.endsWith('.js')).sort();
assert(compiled.length > 0 && compiled.length < 150, 'bounded separate fresh full build required');
const fingerprints = compiled.map(file => {
  const dispatched = resolve(buildDirectory, file), source = resolve(file.slice(0,-3)+'.ts');
  assert(existsSync(source) && statSync(dispatched).mtimeMs >= statSync(source).mtimeMs, 'fresh root-reviewed full build required');
  return { source: { path: relative(workspace,source), sha256:sha(readFileSync(source)) }, dispatched: { path:relative(workspace,dispatched),sha256:sha(readFileSync(dispatched)) } };
});
for (const file of ['scripts/qualification/qualify-adaptive-full.mjs','scripts/qualification/adaptive-full-reservation.mjs','tsconfig.stream-full.json','tsconfig.foundation.json']) fingerprints.push({ source:{path:file,sha256:sha(readFileSync(file))},dispatched:{path:file,sha256:sha(readFileSync(file))} });
// Fixed prospective authored development input and labels, no holdout reader.
const context = caseId?fullCaseContext(caseId):fullDevelopmentContext(), source = context.source,labels=caseId?fullCaseLabels(caseId):fullDevelopmentLabels;
const allLabels=fullCaseIds.map(fullCaseLabels),candidateSha256=sha(JSON.stringify(fingerprints));
const fullManifest = createFullReplyManifest(context), manifest = createFullCompactManifest(fullManifest);
const maxOutputTokens = Number(argument('--output-tokens') ?? '4096');
assert(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 1 && maxOutputTokens <= 4096, 'candidate output ceiling4096; root selects exact live budget');
const baseConfig = { endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',timeoutMs:30000,maxOutputTokens,maxRequestBytes:131072 };
const prepare = manifest => prepareDigitalOceanStreamRequest({ ...baseConfig,apiKey:'offline-preflight-only',responseFormat:{type:'json-schema',name:replyDraftSchemaName,schema:manifest.jsonSchema} },[...manifest.messages]);
const prepared = await prepare(manifest), requestSizes = {};
for (const scenario of ['first-intake','pre-visit','non-visit','post-visit','billing','scheduling','refill']) requestSizes[scenario] = (await prepare(createFullCompactManifest(createFullReplyManifest(fullDevelopmentContext(scenario))))).requestBytes;
const developmentSizes={};
for(const selected of fullCaseIds){const full=createFullReplyManifest(fullCaseContext(selected)),draft=representativeCaseDraft(selected,full),advance={manifestId:full.id,actionId:full.actions.at(-1).id,controls:[],defer:[]},outputBytes=Buffer.byteLength(JSON.stringify({advance,draft:encodeFullCompactDraft(draft)}));developmentSizes[selected]={requestBytes:(await prepare(createFullCompactManifest(full))).requestBytes,authoredOutputBytes:outputBytes,estimatedOutputTokensFourBytesEach:Math.ceil(outputBytes/4),actualTokenizerUsed:false,liveObserved:false};}
const representative = representativeFullDraft(createFullReplyManifest(fullDevelopmentContext())), expandedBytes=Buffer.byteLength(JSON.stringify(representative)),compactBytes=Buffer.byteLength(JSON.stringify(encodeFullCompactDraft(representative)));
const preflight = { id, purpose: 'single-full-stream-development-compatibility-and-labelled-capture-probe', syntheticOnly: true, protocol: replyDraftProtocol, validationRevision: replyDraftValidationRevision,
  model: baseConfig.model, callCount: 0, maximumCalls: 1, maximumOutputTokens: baseConfig.maxOutputTokens, requestBytes: prepared.requestBytes,
  ...(caseId?{caseId,candidateSha256,developmentCaseIds:fullCaseIds,developmentSetSha256:sha(JSON.stringify(allLabels)),developmentSizes}:{}),
  sourceSha256: sha(source.text), labelsSha256:sha(JSON.stringify(labels)), requestBodySha256:sha(prepared.body), scenarioRequestBytes:requestSizes, representative:{expandedBytes,compactBytes,estimatedTokensFourBytesEach:Math.ceil(compactBytes/4),actualTokenizerUsed:false}, timeoutMs:baseConfig.timeoutMs, maxRequestBytes:baseConfig.maxRequestBytes, streamLimits:fullStreamLimits(maxOutputTokens),manifest: { id: manifest.id, sha256: manifest.sha256 }, responseSchema: prepared.responseSchema, implementationFingerprints: fingerprints,
  semanticsQualified: false, latencyQualified: false, defaultEnabled: false };
if (!live) {
  if(caseId) {
    const folder=`docs/implementation/evidence/FULL-DEVELOPMENT-CANDIDATE-${candidateSha256}`,pinMap=new Map(fingerprints.flatMap(pin=>[pin.source,pin.dispatched]).map(pin=>[pin.path,pin.sha256]));
    if(!existsSync(folder)) {
      mkdirSync(folder);
      for(const [path,digest] of pinMap) {const dest=resolve(folder,'files',path);mkdirSync(resolve(dest,'..'),{recursive:true});copyFileSync(path,dest);assert(sha(readFileSync(dest))===digest,'candidate archive mismatch');chmodSync(dest,0o444);}
      writeFileSync(`${folder}/LABELS.json`,JSON.stringify(allLabels,null,2)+'\n',{flag:'wx'});chmodSync(`${folder}/LABELS.json`,0o444);
      writeFileSync(`${folder}/SNAPSHOT.json`,JSON.stringify({candidateSha256,developmentSetSha256:preflight.developmentSetSha256,files:[...pinMap].map(([path,sha256])=>({path,sha256}))},null,2)+'\n',{flag:'wx'});chmodSync(`${folder}/SNAPSHOT.json`,0o444);
    } else {
      const snapshot=JSON.parse(readFileSync(`${folder}/SNAPSHOT.json`,'utf8'));assert(snapshot.candidateSha256===candidateSha256&&snapshot.developmentSetSha256===preflight.developmentSetSha256,'existing candidate archive mismatch');
      for(const pin of snapshot.files)assert(sha(readFileSync(resolve(folder,'files',pin.path)))===pin.sha256,'preserved candidate archive mismatch');
      assert(sha(JSON.stringify(JSON.parse(readFileSync(`${folder}/LABELS.json`,'utf8'))))===preflight.developmentSetSha256,'preserved labels mismatch');
    }
  }
  writeFileSync(prefix + '-PREFLIGHT.json', JSON.stringify(preflight, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ id, state: 'offline-preflight-only', callCount: 0, requestBytes: prepared.requestBytes, receipt: prefix + '-PREFLIGHT.json' }));
} else {
  assert(existsSync(prefix + '-PREFLIGHT.json'), 'reviewed offline preflight required before live');
  assert(JSON.stringify(JSON.parse(readFileSync(prefix + '-PREFLIGHT.json', 'utf8'))) === JSON.stringify(preflight), 'preflight/source/build changed; do not dispatch');
  let reservation;
  if(caseId) {
    assert(reservationPath&&isAbsolute(reservationPath)&&statSync(reservationPath).size<=16384&&!(statSync(reservationPath).mode&0o077),'private bounded root allocation required');
    reservation=validateFullDevelopmentAllocation(JSON.parse(readFileSync(reservationPath,'utf8')),preflight);
  }
  // Explicit --live is insufficient alone: root must reserve this exact id first.
  assert(envPath && isAbsolute(envPath) && !(statSync(envPath).mode & 0o077), 'private absolute environment file required for separately authorized live execution');
  const ledger = readFileSync('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md', 'utf8');
  assert(ledger.includes(`| ${reservation?.allocationId ?? id} /`), 'root must reserve this exact development allocation/compatibility operation in the shared ledger first');
  loadEnvFile(envPath);
  const apiKey = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY;
  assert(apiKey, 'missing model access key');
  const started = performance.now(), advances = [];
  const partial = createSyntheticPartialCapture();
  const retainSyntheticContent = text => partial.append(text), partialEvidence = () => partial.snapshot();
  let calls = 0;
  const intent={ ...preflight, ...(reservation?{reservation}:{}),state: 'dispatch-intent', outcome: 'unknown', at: new Date().toISOString() };
  if(caseId)writeFileSync(`docs/implementation/evidence/FULL-DEVELOPMENT-${candidateSha256}-${caseId}-INTENT.json`,JSON.stringify(intent,null,2)+'\n',{flag:'wx'});
  writeFileSync(prefix + '-INTENT.json', JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' });
  const fetcher = async (url, init) => { assert(++calls === 1, 'one-call limit'); return fetch(url, init); };
  let evidence;
  try {
    const result = await consumeReplyDraftStream({ ...baseConfig, apiKey }, manifest, { fetcher, onSyntheticContent: retainSyntheticContent, onAdvance: packet => { advances.push({ observedAfterDispatchMs: performance.now() - started, packet, durable: false, audible: false }); } });
    evidence = { ...preflight, state: 'compatibility-observed', callCount: calls, providerReceipt: result.receipt, advances, partialContentEvidence: partialEvidence(), rawOutput:result.rawOutput,draft: result.draft, admission: result.admission, normalizedCapture:prepareFullCapture(result.draft,fullManifest), authoredLabels:labels, observedResultRequiresHumanSemanticReview:true,
      note: 'A complete packet is not semantic qualification, a durable app reply or whole-voice latency evidence.' };
  } catch (error) {
    evidence = { ...preflight, state: 'compatibility-failed', callCount: calls, advances, partialContentEvidence: partialEvidence(),
      errorCode: typeof error?.code === 'string' ? error.code : 'stream-probe-failed', ...(error?.receipt ? { providerReceipt: error.receipt } : {}),
      note: 'Unknown provider/billing outcomes retain the reservation; do not retry or fall back.' };
  }
  if(caseId)try {evidence.appReadback=await fullCaseReadback(caseId,{draft:evidence.draft,advance:advances[0]?.packet,receipt:evidence.providerReceipt,errorCode:evidence.errorCode});}catch(error){evidence.appReadback={offlineResponseReplay:true,state:'readback-failed',errorCode:typeof error?.code==='string'?error.code:'readback-failed'};}
  if(reservation)evidence.reservation={...reservation,consumed:true,refund:false};
  writeFileSync(prefix + '.json', JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ id, state: evidence.state, callCount: calls, receipt: prefix + '.json', semanticsQualified: false, latencyQualified: false }));
}
