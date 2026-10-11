import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { useAuthToken } from '@convex-dev/auth/react';
import { z } from 'zod';
import { api } from '../../../convex/_generated/api';
import { checkSelections, type Selection } from '../../../packages/research-core/src/analysis';
import type { StudyReadinessScope } from '../../../packages/research-core/src/readiness';
import type { Id } from '../../../convex/_generated/dataModel';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const inputSchema = z.object({ scope: z.object({ clientId: id, projectId: id, studyId: id, studyVersion: z.number().int().positive() }).strict(), requestId: z.string().uuid(), selections: z.array(z.object({ sessionId: id, kind: z.enum(['self-report','dom-event','screen-observation','camera-observation','audio','capture-gap']), id, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()).min(1).max(24) }).strict();
const reservationSchema = z.object({ id: z.string().regex(/^study-analysis-[a-f0-9]{64}$/), model: z.enum(['qwen3.8-max','glm-5.3-flash']), maxInputBytes: z.number().int().positive().max(64000), maxOutputTokens: z.number().int().positive().max(4096), expiresAt: z.number().int().positive(), live: z.literal(true) }).strict();
const resultSchema = z.object({ analysisId: id, state: z.enum(['admitted','dispatching','unknown','ready','failed','invalidated']) }).strict();
const journalSchema = z.object({ input: inputSchema, reservation: reservationSchema.optional(), dispatched: z.boolean(), result: resultSchema.optional() }).strict();
type Input = z.infer<typeof inputSchema>; type Entry = z.infer<typeof journalSchema>;
type Journal = Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type AnalysisRequestState = { entry: Entry | null; busy: boolean; error: string; journalBlocked: boolean };
export type AnalysisRequestPost = (route: string, token: string, input: Input) => Promise<unknown>;
async function boundedAnalysisResponse(route: string, token: string, input?: Input): Promise<unknown> {
 const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
 let rejectAbort!: () => void;
 const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error('Analysis result unconfirmed')); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
 const timer = setTimeout(() => controller.abort(), route === '/api/research/analysis' ? 45000 : 15000);
 const receive = async () => {
  const response = await fetch(route,{method:input ? 'POST' : 'GET',headers:{Authorization:`Bearer ${token}`,...(input ? {'Content-Type':'application/json'} : {})},...(input ? {body:JSON.stringify(input)} : {}),credentials:'same-origin',cache:'no-store',referrerPolicy:'same-origin',signal:controller.signal});
  if(controller.signal.aborted || !response.ok || !response.body) { if(response.body)void response.body.cancel().catch(()=>{}); throw Error('Analysis result unconfirmed'); }
  reader=response.body.getReader(); const parts:Uint8Array[]=[];let bytes=0;
  for(;;){const next=await reader.read();controller.signal.throwIfAborted();if(next.done)break;bytes+=next.value.byteLength;if(bytes>65536)throw Error('Analysis result unconfirmed');parts.push(next.value);}
  const packet=new Uint8Array(bytes);let at=0;for(const part of parts){packet.set(part,at);at+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(packet));
 };
 try { return await Promise.race([receive(),aborted]); }
 finally {clearTimeout(timer);controller.signal.removeEventListener('abort',rejectAbort);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
}
export function studyAnalysisPost(route: string, token: string, input: Input) { return boundedAnalysisResponse(route, token, input); }
export async function analysisPolicyGet(token: string) {
 const value = await boundedAnalysisResponse('/api/research/analysis/readiness', token);
 return z.object({textOnly:z.boolean()}).parse(value).textOnly;
}
function sameScope(a: StudyReadinessScope,b: StudyReadinessScope) {return a.clientId===b.clientId&&a.projectId===b.projectId&&a.studyId===b.studyId&&a.studyVersion===b.studyVersion;}
/** Preparation consumes native call capacity once; unknown outcomes are read-only. */
export class StudyAnalysisController {
 state:AnalysisRequestState={entry:null,busy:false,error:'',journalBlocked:false};readonly key:string;
 constructor(readonly scope:StudyReadinessScope,private journal:Journal|null,private post:AnalysisRequestPost,private lookup:(input:Input)=>Promise<unknown>,private notify:(state:AnalysisRequestState)=>void=()=>{}){
  this.key=`corvo.research.study-analysis.v1.${scope.clientId}.${scope.projectId}.${scope.studyId}.${scope.studyVersion}`;
  try{const text=journal?.getItem(this.key);if(text){if(text.length>16384)throw Error();const entry=journalSchema.parse(JSON.parse(text));if(!sameScope(entry.input.scope,scope))throw Error();checkSelections(entry.input.selections);this.state.entry=entry;}if(!journal)this.state.journalBlocked=true;}catch{this.state.journalBlocked=true;}
 }
 private update(patch:Partial<AnalysisRequestState>){this.state={...this.state,...patch};try{this.notify(this.state);}catch{/* Diagnostics/rendering cannot change admission. */}}
 private store(entry:Entry){if(!this.journal)throw Error('Safe request journal unavailable');this.journal.setItem(this.key,JSON.stringify(entry));this.update({entry});}
 private acceptReservation(value:unknown,entry:Entry){const reservation=reservationSchema.parse(value);if(reservation.expiresAt<=Date.now())throw Error('Prepared allowance has expired');this.store({...entry,reservation});}
 async prepare(token:string|null,active:boolean,selections:Selection[],textOnly=false){
  if(!token||!active||this.state.busy||this.state.entry||this.state.journalBlocked)return;
  let input:Input;try{if(textOnly&&selections.some(s=>s.kind!=='self-report')){this.update({error:'This operating budget accepts participant text only. Remove other sources before preparing.'});return;}checkSelections(selections);if(selections.filter(s=>s.kind==='screen-observation'||s.kind==='camera-observation').length>1)throw Error('Current qualified runtime accepts one frame');input=inputSchema.parse({scope:this.scope,requestId:crypto.randomUUID(),selections});this.store({input,dispatched:false});}catch{this.update({error:'This selection or safe request journal is unavailable. No preparation was sent.'});return;}
  const entry=this.state.entry!;this.update({busy:true,error:''});
  try{this.acceptReservation(await this.post('/api/research/analysis/prepare',token,input),entry);}catch{this.update({error:'Preparation is unconfirmed. Check the original prepared allowance; do not prepare it again.'});}finally{this.update({busy:false});}
 }
 async checkPrepared(token:string|null){
  const entry=this.state.entry;if(!token||!entry||entry.dispatched||this.state.busy)return;this.update({busy:true,error:''});
  try{this.acceptReservation(await this.post('/api/research/analysis/prepare/receipt',token,entry.input),entry);}catch{this.update({error:'The original prepared allowance cannot be confirmed. No preparation was repeated.'});}finally{this.update({busy:false});}
 }
 async dispatch(token:string|null,active:boolean,textOnly=false){
  const entry=this.state.entry;if(!token||!active||!entry?.reservation||entry.dispatched||this.state.busy||entry.reservation.expiresAt<=Date.now())return;
  if(textOnly&&entry.input.selections.some(s=>s.kind!=='self-report')){this.update({error:'This operating budget accepts participant text only. The original prepared request remains retained.'});return;}
  try{this.store({...entry,dispatched:true});}catch{this.update({error:'The dispatch marker could not be saved. No model request was sent.'});return;}
  this.update({busy:true,error:''});
  try{const result=resultSchema.parse(await this.post('/api/research/analysis',token,entry.input));this.store({...entry,dispatched:true,result});}catch{this.update({error:'Analysis is unconfirmed. Check this original request; no second model request will run.'});}finally{this.update({busy:false});}
 }
 async checkDispatched(){
  const entry=this.state.entry;if(!entry?.dispatched||this.state.busy)return;this.update({busy:true,error:''});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{const value=await Promise.race([this.lookup(entry.input),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Original status unconfirmed')),10000);})]);if(value===null)throw Error();const result=resultSchema.parse(value);this.store({...entry,result});}catch{this.update({error:'No original analysis receipt is currently confirmed. Keep this request; do not dispatch it again.'});}finally{if(timer)clearTimeout(timer);this.update({busy:false});}
 }
 reset(){if(this.state.busy||!this.state.entry?.result||!['ready','failed','invalidated'].includes(this.state.entry.result.state))return;try{this.journal?.removeItem(this.key);this.update({entry:null,error:''});}catch{this.update({error:'The completed request journal could not be cleared.'});}}
}
export function StudyAnalysisRequest({scope,selections,active,onFrozen,onCreated}:{scope:StudyReadinessScope;selections:Selection[];active:boolean;onFrozen:(frozen:boolean)=>void;onCreated:(id:Id<'researchAnalyses'>)=>void}){
 const convex=useConvex(),token=useAuthToken();const[state,setState]=useState<AnalysisRequestState>({entry:null,busy:false,error:'',journalBlocked:false});
 const[controller]=useState(()=>{let journal:Journal|null=null;try{journal=sessionStorage;}catch{}return new StudyAnalysisController(scope,journal,studyAnalysisPost,input=>convex.query(api.researchAnalysis.requestStatus,{clientId:input.scope.clientId as Id<'researchClients'>,projectId:input.scope.projectId as Id<'researchProjects'>,requestId:input.requestId}),setState);});
 const[policy,setPolicy]=useState<boolean|null>(null),[policyError,setPolicyError]=useState(''),[policyCheck,setPolicyCheck]=useState(0);
 useEffect(()=>{let current=true;setPolicy(null);setPolicyError('');if(token)void analysisPolicyGet(token).then(value=>{if(current)setPolicy(value);}).catch(()=>{if(current)setPolicyError('Analysis source limits are unconfirmed. Check them before preparing or dispatching.');});return()=>{current=false;};},[token,policyCheck]);
 const current=state.entry?state:controller.state,entry=current.entry;const scopeMatches=sameScope(scope,controller.scope);const frozen=!!entry||current.journalBlocked;const unsupported=policy===true&&(entry?.input.selections??selections).some(s=>s.kind!=='self-report');
 useEffect(()=>{onFrozen(frozen);},[frozen,onFrozen]);
 return <section aria-label="Prepared study analysis"><p>Prepare the selected sources for this saved study version, then explicitly request one private draft. Preparation commits one analysis allowance; it does not call the model.</p>
  {policy===true&&<p>This operating budget accepts participant text only. Remove DOM, camera, screen, audio and gap sources before preparing.</p>}{policyError&&<p role="alert">{policyError} <button type="button" onClick={()=>setPolicyCheck(n=>n+1)}>Check analysis source limits</button></p>}{unsupported&&<p role="alert">Other source kinds are unavailable for this analysis budget.</p>}
  {entry?<><p>{entry.input.selections.length} sources fixed for study version {entry.input.scope.studyVersion}. Original request {entry.input.requestId} is retained.</p>{entry.reservation&&<p>Prepared limit: {entry.reservation.maxInputBytes} input bytes and {entry.reservation.maxOutputTokens} output tokens. Expires {new Date(entry.reservation.expiresAt).toLocaleString()}.</p>}</>:null}
  <div className="actions"><button className="secondary" disabled={!scopeMatches||!token||!active||current.busy||frozen||!selections.length||policy===null||unsupported} onClick={()=>void controller.prepare(token,active,selections,policy===true)}>Prepare selected study evidence</button>
  {entry&&!entry.dispatched&&<button className="secondary" disabled={!scopeMatches||!token||current.busy} onClick={()=>void controller.checkPrepared(token)}>Check prepared allowance</button>}
  {entry?.reservation&&!entry.dispatched&&<button disabled={!scopeMatches||!token||!active||current.busy||entry.reservation.expiresAt<=Date.now()||policy===null||unsupported} onClick={()=>void controller.dispatch(token,active,policy===true)}>Create private AI draft</button>}
  {entry?.dispatched&&<button className="secondary" disabled={!scopeMatches||!token||current.busy} onClick={()=>void controller.checkDispatched()}>Check original analysis</button>}
  {entry?.result&&<button className="secondary" disabled={!scopeMatches||!token} onClick={()=>onCreated(entry.result!.analysisId as Id<'researchAnalyses'>)}>Open original analysis · {entry.result.state}</button>}
  {entry?.result&&['ready','failed','invalidated'].includes(entry.result.state)&&<button className="text-button" disabled={current.busy} onClick={()=>controller.reset()}>Select evidence for another analysis</button>}</div>
  {current.busy&&<p role="status">Checking the original analysis operation…</p>}{current.journalBlocked&&<p role="alert">This tab cannot retain a safe analysis request. No preparation or model dispatch is permitted.</p>}{current.error&&<p role="alert">{current.error}</p>}
 </section>;
}
