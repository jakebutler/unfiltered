import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { expect, test, vi } from 'vitest';
import { createHostedResearchServer } from '../application';
import { createResearchSpeechTransport } from '../../../../../apps/research-server/src/research-speech';
import { fakeHostedAuthority } from '../../../../../apps/research-server/test/hosted-test-authority';
import { HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE, type HostedResearchConfig } from '../../../../../apps/research-server/src/hosted-runtime';
import type { InterviewAuthority, InterviewRuntime } from '../../../../../apps/research-server/src/interview';
import type { InterviewContext } from '../../../../../packages/research-core/src/interview';
const origin = 'https://review.example.test';
const scope = { sessionId: 'independent-session', promptId: 'q1', expectedRevision: 1, answerSourceId: 'answer-source', requestId: 'independent-turn' };
function fixture(runtime?: InterviewRuntime) {
  const context: InterviewContext = { sessionId: scope.sessionId, revision: 1, consentEpoch: 1, retainUntil: Date.now()+60000, goals: ['Understand delivery'], script: [{id:'q1',question:'What happened?'},{id:'q2',question:'What would help?'}], scriptIndex:0, currentPrompt:{id:'q1',scriptQuestionId:'q1',kind:'script',question:'What happened?',followUpNumber:0}, followUps:[], answer:{sourceId:scope.answerSourceId,promptId:'q1',text:'Delivery was confusing.',channel:'text',intent:'answer'} };
  const authority: InterviewAuthority = {inspect:vi.fn(async()=>context),advance:vi.fn(async()=>{}),admit:vi.fn(async()=>({attemptId:'review-attempt',state:'reserved' as const,reservation:{id:'review-reservation',model:'qwen3.8-max' as const,maxInputBytes:64000,maxOutputTokens:512,expiresAt:Date.now()+60000}})),begin:vi.fn(async()=>true),finish:vi.fn(async()=>{})};
  const native=fakeHostedAuthority();
  const config: HostedResearchConfig={mode:'hosted',deployment:HOSTED_DEPLOYMENT,convexSite:HOSTED_CONVEX_SITE,publicOrigin:origin,gatewaySecret:'a'.repeat(64),maxSegmentBytes:4000000,maxResponseBytes:4000000,cleanupMode:'durable'};
  const speech=createResearchSpeechTransport({origin,enabled:false,authority:{} as any});
  const app=createHostedResearchServer({config,assets:new Map(),injection:{store:{head:vi.fn(),read:vi.fn(),putIfAbsent:vi.fn(),retire:vi.fn()},hostedAuthority:native},speech,interviewRuntime:runtime,interviewFactory:()=>authority});
  return {app,native,authority};
}
function request(signal?:AbortSignal) { const body=JSON.stringify(scope); return new Request(origin+'/api/research/interview',{method:'POST',headers:{Host:new URL(origin).host,Origin:origin,'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),'X-Research-Participant':'a'.repeat(64)},body,signal}); }

test('platform request error cancellation is consumed on a GET before body conversion',async()=>{
  const f=fixture(),socket=new Socket(),req=new IncomingMessage(socket),res=new ServerResponse(req);
  req.method='GET';req.url='/api/research/unavailable';req.headers={host:new URL(origin).host,origin};
  let resolve!: (value:null)=>void;
  vi.mocked(f.native.acquire).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const handler=f.app.server.listeners('request')[0] as (req:IncomingMessage,res:ServerResponse)=>Promise<void>;
  const running=handler(req,res);
  try { expect(req.listenerCount('error')).toBeGreaterThan(0); expect(()=>req.emit('error',new Error('aborted'))).not.toThrow(); }
  finally { req.emit('aborted');resolve?.(null);await running;res.destroy();socket.destroy();f.app.close(); }
});

test('disconnect during uncancellable interview preparation retains the lease until actual settlement',async()=>{
  let complete!: (value:any)=>void,started!:()=>void;
  const preparationStarted=new Promise<void>(r=>{started=r;});
  const provider={model:'qwen3.8-max' as const,prepare:vi.fn(()=>{started();return new Promise<any>(r=>{complete=r;});}),generate:vi.fn()};
  const f=fixture({enabled:true,provider}),abort=new AbortController();
  try {
    const pending=f.app.handle(request(abort.signal));await preparationStarted;abort.abort();
    expect((await pending).status).toBe(409);expect(f.native.leases.size).toBe(1);expect(f.native.release).not.toHaveBeenCalled();
    expect(f.authority.begin).not.toHaveBeenCalled();expect(provider.generate).not.toHaveBeenCalled();
    complete({inputHash:'1'.repeat(64),requestBytes:100,maxOutputTokens:512});
    await new Promise<void>(r=>setImmediate(r));expect(f.native.leases.size).toBe(0);expect(f.native.release).toHaveBeenCalledOnce();
    expect(f.authority.begin).not.toHaveBeenCalled();expect(provider.generate).not.toHaveBeenCalled();
  } finally {f.app.close();}
});

test('authority operation exhaustion prevents interview inspection and provider admission',async()=>{
  const f=fixture();f.native.reserveOperation=vi.fn(async()=>false);
  try {const response=await f.app.handle(request());expect(response.status).toBe(409);expect(f.authority.inspect).not.toHaveBeenCalled();expect(f.authority.admit).not.toHaveBeenCalled();await response.text().catch(()=>undefined);await new Promise<void>(r=>setImmediate(r));expect(f.native.release).toHaveBeenCalledOnce();expect(f.native.leases.size).toBe(0);}
  finally {f.app.close();}
});
