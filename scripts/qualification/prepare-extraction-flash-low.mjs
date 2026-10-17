/** Exact request preparation only. Reuse the accepted sparse V2 packet without regenerating it. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareDigitalOceanStreamRequest } from './digitalocean-flash-low.mjs';
assert.equal(process.argv.length,2,'offline only');
const sha=b=>createHash('sha256').update(b).digest('hex');
const source='docs/implementation/evidence/S3-EXTRACTION-SPARSE-V2-AUTHORED-PACKET.json',bytes=readFileSync(source);
assert.equal(sha(bytes),'1d3df35af46f16542040d97e442263a088adfe4c63128d9ecc17c457ab834600');
const packet=JSON.parse(bytes),cases=[];
for(const c of packet.cases){
 const request=await prepareDigitalOceanStreamRequest({endpoint:'https://inference.do-ai.run',model:'glm-5.3-flash',apiKey:'offline-preflight-only',timeoutMs:30000,maxOutputTokens:2048,maxRequestBytes:131072,responseFormat:{type:'json-schema',name:'adaptive_extraction_sparse_v2',schema:c.manifest.jsonSchema}},c.manifest.messages);
 const body=JSON.parse(request.body);assert.equal(body.reasoning_effort,'low');assert.equal(body.max_tokens,2048);
 assert.deepEqual(body.messages,c.manifest.messages);assert.deepEqual(body.response_format.json_schema.schema,c.manifest.jsonSchema);
 cases.push({caseId:c.caseId,model:'glm-5.3-flash',body:request.body,sha256:sha(request.body),bytes:request.requestBytes,maxOutputTokens:2048,manifestSha256:c.manifest.sha256,reasoningEffortSent:'low',reasoningControlHonored:false});
}
const output='docs/implementation/evidence/S3-EXTRACTION-SPARSE-V2-FLASH-LOW-REQUESTS.json';assert(!existsSync(output),'preserve exact request evidence');
writeFileSync(output,JSON.stringify({schema:1,extractionCandidateSha256:packet.candidateSha256,sourcePacketSha256:sha(bytes),cases,providerCalls:0,allowance:false,holdoutRead:false,defaultEnabled:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,sha256:sha(readFileSync(output)),cases:cases.map(({body,...c})=>c),providerCalls:0}));
