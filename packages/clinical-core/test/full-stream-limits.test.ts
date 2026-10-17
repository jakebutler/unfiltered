import { expect,it } from 'vitest';
import { digitalOceanStream, fullStreamLimits } from '../src/digitalocean-stream.js';
const config={endpoint:'https://inference.do-ai.run' as const,model:'qwen3.8-max' as const,apiKey:'offline',timeoutMs:12000,maxOutputTokens:4096};
const event=(delta:object,finish_reason:string|null=null)=>`data: ${JSON.stringify({id:'offline-sizing',model:config.model,created:1,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`;
const terminal=event({},'stop')+`data: ${JSON.stringify({id:'offline-sizing',model:config.model,choices:[],usage:{prompt_tokens:1,completion_tokens:4096,total_tokens:4097}})}\n\n`+'data: [DONE]\n\n';
const response=(wire:string)=>new Response(wire,{headers:{'content-type':'text/event-stream'}});
it('measures4096 one-token events plus terminal allowance within the explicit full cap; legacy256k remains closed',async()=>{
  const wire=event({role:'assistant'})+event({content:'x'}).repeat(4096)+terminal,bounds=fullStreamLimits(4096);
  expect(Buffer.byteLength(wire)).toBeGreaterThan(256000);expect(Buffer.byteLength(wire)).toBeLessThan(bounds.maxWireBytes);expect(bounds.maxWireBytes).toBeLessThanOrEqual(2.5*1024*1024);
  const result=await digitalOceanStream(config,async()=>response(wire),undefined,bounds).generate([{role:'user',content:'Synthetic sizing'}],{onContent:()=>{}});
  expect(result.receipt).toMatchObject({wireBytes:Buffer.byteLength(wire),eventCount:4100,contentBytes:4096,reasoningBytes:0,providerExecution:'completed'});
  await expect(digitalOceanStream(config,async()=>response(wire)).generate([{role:'user',content:'Legacy cap'}],{onContent:()=>{}})).rejects.toMatchObject({code:'stream-response-too-large',receipt:{limits:{wireBytes:256000}}});
});
it('counts separate reasoning-only bytes and preserves fragmented UTF8 content',async()=>{
  const wire=event({reasoning_content:'reason α',content:null})+event({content:'β'})+terminal,bytes=new TextEncoder().encode(wire);
  const fragmented=new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(new Uint8Array([byte]));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  const result=await digitalOceanStream(config,async()=>fragmented,undefined,fullStreamLimits(4096)).generate([{role:'user',content:'UTF8 sizing'}],{onContent:()=>{}});
  expect(result.text).toBe('β');expect(result.receipt.reasoningBytes).toBe(Buffer.byteLength('reason α'));expect(result.receipt.contentBytes).toBe(2);expect(result.receipt.wireBytes).toBe(bytes.length);
});
it('bounds aggregate reasoning independently of visible content and wire size',async()=>{
  const wire=event({reasoning_content:'x'.repeat(16000)}).repeat(9);
  await expect(digitalOceanStream(config,async()=>response(wire),undefined,fullStreamLimits(4096)).generate([{role:'user',content:'Reasoning cap'}],{onContent:()=>{}})).rejects.toMatchObject({code:'stream-reasoning-too-large',receipt:{reasoningBytes:144000,contentBytes:0,providerExecution:'unknown',usage:'unknown'}});
});
it('rejects oversized single-event metadata despite a larger full-wire allowance',async()=>{
  const wire=event({content:'x'.repeat(64001)});
  await expect(digitalOceanStream(config,async()=>response(wire),undefined,fullStreamLimits(4096)).generate([{role:'user',content:'Single event cap'}],{onContent:()=>{}})).rejects.toMatchObject({code:'stream-line-too-large'});
});
it('cancellation retains measured bytes and unknown settlement without claiming termination',async()=>{
  const controller=new AbortController(),wire=event({content:'α'});
  await expect(digitalOceanStream(config,async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(wire));}}),{headers:{'content-type':'text/event-stream'}}),undefined,fullStreamLimits(4096)).generate([{role:'user',content:'Cancel'}],{signal:controller.signal,onContent:()=>controller.abort()})).rejects.toMatchObject({code:'stream-cancelled',receipt:{contentBytes:2,wireBytes:Buffer.byteLength(wire),providerExecution:'unknown',usage:'unknown',cleanup:{providerTermination:'unconfirmed'}}});
});
