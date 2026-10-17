import { expect, it, vi } from 'vitest';
import { digitalOceanStream, fullStreamLimits, prepareDigitalOceanStreamRequest } from '../src/digitalocean-stream.js';
import type { Fetch } from '../src/transport.js';
const messages = [{ role: 'user' as const, content: 'synthetic only' }];
const schema = {type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false};
it.each(['kimi-k3','deepseek-v4.1-flash'] as const)('keeps %s schema and reasoning stream bounded, validates model identity without fallback', async model => {
  const config = {endpoint:'https://inference.do-ai.run' as const,apiKey:'offline-only',model,timeoutMs:1000,maxOutputTokens:4096,
    responseFormat:{type:'json-schema' as const,name:'comparison',schema}};
  const prepared=await prepareDigitalOceanStreamRequest(config,messages), body=JSON.parse(prepared.body);
  expect(body).toMatchObject({model,reasoning_effort:'low',stream:true,stream_options:{include_usage:true},response_format:{type:'json_schema',json_schema:{strict:true,schema}}});
  expect(body[model==='kimi-k3'?'max_completion_tokens':'max_tokens']).toBe(4096);
  const event=(delta:object,finish_reason:string|null=null,identity=model)=>`data: ${JSON.stringify({id:'one',model:identity,choices:[{index:0,delta,finish_reason}]})}\n\n`;
  const response=(wire:string)=>new Response(wire,{headers:{'Content-Type':'text/event-stream'}});
  const fetcher=vi.fn<Fetch>().mockResolvedValue(response(event({reasoning_content:'bounded thinking'})+event({content:'{"answer":"x"}'})+event({},'stop')+'data: [DONE]\n\n'));
  await expect(digitalOceanStream(config,fetcher,undefined,fullStreamLimits(4096)).generate(messages,{onContent:()=>{}})).resolves.toMatchObject({text:'{"answer":"x"}',receipt:{model,reasoningBytes:16,usage:'unknown'}});
  expect(fetcher).toHaveBeenCalledTimes(1);
  const substituted=vi.fn<Fetch>().mockResolvedValue(response(event({content:'{}'},null,'unrequested' as typeof model)));
  await expect(digitalOceanStream(config,substituted).generate(messages,{onContent:()=>{}})).rejects.toMatchObject({code:'inference-model-mismatch'});
  expect(substituted).toHaveBeenCalledTimes(1);
  const rejected=vi.fn<Fetch>().mockResolvedValue(new Response('unsupported schema',{status:400}));
  await expect(digitalOceanStream(config,rejected).generate(messages,{onContent:()=>{}})).rejects.toMatchObject({code:'stream-http'});
  expect(rejected).toHaveBeenCalledTimes(1);
});
