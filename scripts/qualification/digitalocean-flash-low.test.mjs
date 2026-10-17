import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDigitalOceanStreamRequest as stablePrepare } from '../../.extraction-sparse-v2-build/packages/clinical-core/src/digitalocean-stream.js';
import { prepareDigitalOceanStreamRequest, digitalOceanStream, fullStreamLimits } from './digitalocean-flash-low.mjs';
const config={endpoint:'https://inference.do-ai.run',model:'glm-5.3-flash',apiKey:'synthetic-offline-only',timeoutMs:1000,maxOutputTokens:2048,maxRequestBytes:131072,responseFormat:{type:'json-schema',name:'synthetic',schema:{type:'object',additionalProperties:false,properties:{},required:[]}}};
const messages=[{role:'user',content:'Synthetic request identity only.'}];
test('Flash-low body differs only by explicit root effort and preserves exact request accounting',async()=>{
 const stable=await stablePrepare(config,messages),issued=await prepareDigitalOceanStreamRequest(config,messages),body=JSON.parse(issued.body);
 assert.equal(body.reasoning_effort,'low');delete body.reasoning_effort;assert.deepEqual(body,JSON.parse(stable.body));
 assert.equal(issued.requestBytes,Buffer.byteLength(issued.body));assert.deepEqual(issued.responseSchema,stable.responseSchema);assert(!issued.body.includes(config.apiKey));
 await assert.rejects(prepareDigitalOceanStreamRequest({...config,model:'qwen3.8-max'},messages));
 await assert.rejects(prepareDigitalOceanStreamRequest({...config,maxRequestBytes:stable.requestBytes},messages),/inference-input-too-large/);
});
test('actual fetch receives the exact explicit-low body while stable SSE checks count reasoning separately',async()=>{
 const issued=await prepareDigitalOceanStreamRequest(config,messages);let calls=0;
 const event=(choices,usage)=>'data: '+JSON.stringify({id:'synthetic',model:config.model,choices,...(usage?{usage}:{})})+'\n\n';
 const sse=event([{index:0,delta:{reasoning_content:'synthetic reasoning',content:'{}'},finish_reason:null}])+event([{index:0,delta:{},finish_reason:'stop'}])+event([],{prompt_tokens:3,completion_tokens:5,total_tokens:8,completion_tokens_details:{reasoning_tokens:3}})+'data: [DONE]\n\n';
 const result=await digitalOceanStream(config,async(_url,init)=>{calls++;assert.equal(init.body,issued.body);return new Response(sse,{headers:{'content-type':'text/event-stream'}});},()=>performance.now(),fullStreamLimits(2048)).generate(messages,{onContent:()=>{}});
 assert.equal(calls,1);assert.equal(result.text,'{}');assert.equal(result.receipt.requestBytes,issued.requestBytes);assert.equal(result.receipt.reasoningBytes,Buffer.byteLength('synthetic reasoning'));assert.equal(result.receipt.usage.completion_tokens_details.reasoning_tokens,3);
});
test('unknown failure retains exact attempted-low bytes without retry or control-honored inference',async()=>{
 const issued=await prepareDigitalOceanStreamRequest(config,messages);let calls=0;
 await assert.rejects(digitalOceanStream(config,async(_url,init)=>{calls++;assert.equal(init.body,issued.body);throw Error('synthetic network loss');}).generate(messages,{onContent:()=>{}}),e=>e.receipt.requestBytes===issued.requestBytes&&e.receipt.outcome==='unknown'&&e.receipt.providerExecution==='unknown');
 assert.equal(calls,1);
});
