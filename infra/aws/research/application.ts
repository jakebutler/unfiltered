import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHostedResearchHandler, type HostedResearchConfig, type HostedResearchInjection, type ResearchIdentityBinding } from '../../../apps/research-server/src/hosted-runtime';
import type { ResearchSpeechRuntime } from '../../../apps/research-server/src/server';
import { convexInterviewAuthority } from '../../../apps/research-server/src/interview-authority';
import type { InterviewAuthority,InterviewRuntime } from '../../../apps/research-server/src/interview';
import { researchInterviewGateway } from '../../../apps/research-server/src/interview-gateway';
import { studyReadinessGateway, studyRuntimeFacts } from '../../../apps/research-server/src/study-readiness';
import { loadClinicAssets, type ClinicAssets } from '../../cloud/vercel/static-assets';
export { loadClinicAssets as loadResearchAssets };
export function researchHeaders(binding: ResearchIdentityBinding) {
  return { 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY', 'Permissions-Policy':'microphone=(self), camera=(self), display-capture=(self)', 'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${binding.canonicalOrigin.replace('https:','wss:')} ${binding.deployment} ${binding.deployment!.replace('https:','wss:')} ${binding.convexSite}; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` };
}
export function createAwsResearchServer(config: HostedResearchConfig, binding: ResearchIdentityBinding, assets: ClinicAssets, injection: HostedResearchInjection, speech?: ResearchSpeechRuntime, interviewRuntime:InterviewRuntime={enabled:false}, interviewFactory?:(token:string,signal:AbortSignal)=>InterviewAuthority) {
  // Every deployed analysis uses its source-bound native study reservation.
  // Keep the caller's separately assembled local runtime unchanged.
  const analysisRuntime=injection.analysisRuntime?{...injection.analysisRuntime,preparedOnly:true}:undefined;
  const readinessFacts=injection.readinessFacts??studyRuntimeFacts(config,{interview:interviewRuntime,analysis:analysisRuntime,speechEnabled:()=>speech?.readinessEnabled?.()===true,speechConfiguration:()=>speech?.readinessConfiguration()??''});
  const readiness=studyReadinessGateway({...config,analysisTextOnly:analysisRuntime?.textOnly===true},readinessFacts);
  const factory=interviewFactory??((token:string,signal:AbortSignal)=>convexInterviewAuthority(config.deployment,config.gatewaySecret,token,signal,readinessFacts));
  const gateway=createHostedResearchHandler(config,binding,{...injection,analysisRuntime,readinessFacts,requestGateway:async(request,context)=>{
    if(new URL(request.url).pathname!=='/api/research/interview')return undefined;
    const guardedFactory=(token:string,signal:AbortSignal)=>new Proxy(factory(token,signal),{get(authority,key){const value=Reflect.get(authority,key);return typeof value==='function'?(...args:unknown[])=>context.call(()=>Promise.resolve(value.apply(authority,args))):value;}});
    const provider=interviewRuntime.provider;
    const runtime=provider?{...interviewRuntime,provider:{model:provider.model,prepare:(...args:Parameters<typeof provider.prepare>)=>context.call(()=>provider.prepare(...args)),generate:(...args:Parameters<typeof provider.generate>)=>context.call(()=>provider.generate(...args))}}:interviewRuntime;
    return researchInterviewGateway(config,runtime,guardedFactory)(request);
  }}),headers=researchHeaders(binding);
  let closing=false;
  const handle = async (request: Request) => {
    const u=new URL(request.url);
    if (u.origin!==binding.canonicalOrigin || request.headers.get('Host')!==u.host) return new Response('Access unavailable',{status:403,headers});
    if (u.pathname.startsWith('/api/research') || u.pathname.startsWith('/capture/')) return await speech?.handle(request) ?? await readiness(request) ?? gateway(request);
    if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers});
    const shell=['/','/participate','/participate/'].includes(u.pathname)||/^\/report\/[a-zA-Z0-9_-]{1,128}$/.test(u.pathname);
    const asset=assets.get(shell?'/index.html':u.pathname);
    if(!asset)return new Response('Not found',{status:404,headers});
    return new Response(request.method==='HEAD'?null:new Uint8Array(asset.body),{headers:{...headers,'Content-Type':asset.contentType,'Content-Length':String(asset.body.byteLength),ETag:`"${asset.digest}"`}});
  };
  const server=createServer({maxHeaderSize:16384},async(req,res)=>{
    const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),180000), disconnect=()=>{if(!res.writableFinished)abort.abort();}, cancel=()=>res.destroy();
    req.once('aborted',disconnect);req.once('error',disconnect);res.once('close',disconnect);abort.signal.addEventListener('abort',cancel);
    try{
      if(!closing&&req.method==='GET'&&req.url==='/capture/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"state":"ready"}');return;}
      if(closing||req.headers.host!==new URL(binding.canonicalOrigin).host||!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))throw new Error('Origin unavailable');
      const h=new Headers();for(const[k,v]of Object.entries(req.headers))if(v!==undefined)h.set(k,Array.isArray(v)?v.join(','):v);
      // A bodyless DELETE remains bodyless; framed bodies stay visible to admission.
      const emptyDelete=req.method==='DELETE'&&!h.has('Transfer-Encoding')&&(!h.has('Content-Length')||h.get('Content-Length')==='0');
      const response=await handle(new Request(new URL(req.url,binding.canonicalOrigin),{method:req.method,headers:h,signal:abort.signal,...(!['GET','HEAD'].includes(req.method??'')&&!emptyDelete?{body:Readable.toWeb(req),duplex:'half'}:{})}as RequestInit));
      if(abort.signal.aborted){await response.body?.cancel();return;}
      const out=new Headers(response.headers);for(const[k,v]of Object.entries(headers))out.set(k,v);
      res.writeHead(response.status,Object.fromEntries(out));if(response.body)await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),res,{signal:abort.signal});else res.end();
    }catch{if(res.headersSent||res.destroyed)res.destroy();else{res.writeHead(409,headers);res.end('Operation unavailable or unresolved');}}
    finally{clearTimeout(timer);req.off('aborted',disconnect);req.off('error',disconnect);res.off('close',disconnect);abort.signal.removeEventListener('abort',cancel);}
  });
  server.on('upgrade',(req,socket,head)=>{if(closing||!speech)socket.destroy();else void speech.upgrade(req,socket,head).catch(()=>socket.destroy());});server.on('clientError',(_e,socket)=>socket.destroy());
  server.headersTimeout=10000;server.requestTimeout=180000;server.keepAliveTimeout=5000;
  return{server,handle,async close(){closing=true;speech?.close();server.closeIdleConnections();const force=setTimeout(()=>server.closeAllConnections(),5000);try{await new Promise<void>(resolve=>server.close(()=>resolve()));}finally{clearTimeout(force);}}};
}
