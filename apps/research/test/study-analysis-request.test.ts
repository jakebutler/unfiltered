import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StudyAnalysisController, studyAnalysisPost, analysisPolicyGet } from '../src/StudyAnalysisRequest';
const scope={clientId:'client',projectId:'project',studyId:'study',studyVersion:2},selection={sessionId:'session',kind:'self-report' as const,id:'source',start:0,end:62};
const reservation=()=>({id:'study-analysis-'+ 'a'.repeat(64),model:'qwen3.8-max',maxInputBytes:64000,maxOutputTokens:512,expiresAt:Date.now()+45000,live:true});
let values:Map<string,string>;const journal={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)};
beforeEach(()=>{values=new Map();});afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
test('prepare stores exact immutable selection before capacity request and explicit dispatch reuses it once',async()=>{
 const post=vi.fn().mockImplementationOnce(async(route,token,input)=>{expect(values.size).toBe(1);expect(JSON.parse([...values.values()][0]).input).toEqual(input);return reservation();}).mockResolvedValueOnce({analysisId:'analysis',state:'ready'}),lookup=vi.fn(),c=new StudyAnalysisController(scope,journal,post,lookup);const sources=[{...selection}];await c.prepare('operator',true,sources);expect(post).toHaveBeenCalledOnce();const input=post.mock.calls[0][2];sources[0].end=61;expect(c.state.entry?.input.selections[0].end).toBe(62);expect(c.state.entry?.dispatched).toBe(false);await c.dispatch('operator',true);await c.dispatch('operator',true);expect(post).toHaveBeenCalledTimes(2);expect(post.mock.calls[1]).toEqual(['/api/research/analysis','operator',input]);expect(c.state.entry?.result).toEqual({analysisId:'analysis',state:'ready'});expect(lookup).not.toHaveBeenCalled();
});
test('unknown preparation survives reload; only original receipt lookup is sent',async()=>{
 const post=vi.fn().mockRejectedValueOnce(Error('lost ACK')).mockResolvedValueOnce(reservation()),c=new StudyAnalysisController(scope,journal,post,vi.fn());await c.prepare('operator',true,[selection]);await c.prepare('operator',true,[selection]);expect(post).toHaveBeenCalledOnce();const original=post.mock.calls[0][2],restored=new StudyAnalysisController(scope,journal,post,vi.fn());await restored.prepare('operator',true,[selection]);await restored.checkPrepared('operator');expect(post).toHaveBeenCalledTimes(2);expect(post.mock.calls[1]).toEqual(['/api/research/analysis/prepare/receipt','operator',original]);expect(restored.state.entry?.reservation?.id).toBe(reservation().id);
});
test('unknown dispatch survives reload, cannot reset/repost and reconciles through native original status',async()=>{
 const post=vi.fn().mockResolvedValueOnce(reservation()).mockRejectedValueOnce(Error('lost ACK')),lookup=vi.fn().mockResolvedValue({analysisId:'analysis',state:'unknown'}),c=new StudyAnalysisController(scope,journal,post,lookup);await c.prepare('operator',true,[selection]);await c.dispatch('operator',true);const restored=new StudyAnalysisController(scope,journal,post,lookup);restored.reset();await restored.dispatch('operator',true);await restored.checkPrepared('operator');expect(post).toHaveBeenCalledTimes(2);await restored.checkDispatched();expect(lookup).toHaveBeenCalledWith(post.mock.calls[0][2]);restored.reset();expect(values.size).toBe(1);expect(restored.state.entry?.result?.state).toBe('unknown');
});
test('busy action refuses duplicates while native response is pending',async()=>{
 let done!:(value:unknown)=>void;const post=vi.fn(()=>new Promise(resolve=>{done=resolve})),c=new StudyAnalysisController(scope,journal,post,vi.fn());const running=c.prepare('operator',true,[selection]);await c.prepare('operator',true,[selection]);await c.checkPrepared('operator');expect(post).toHaveBeenCalledOnce();done(reservation());await running;
});
test('auth/archive/expiry guards prevent preparation and dispatch without extending native deadline',async()=>{
 vi.useFakeTimers();const post=vi.fn().mockResolvedValue(reservation()),c=new StudyAnalysisController(scope,journal,post,vi.fn());await c.prepare(null,true,[selection]);await c.prepare('operator',false,[selection]);expect(post).not.toHaveBeenCalled();await c.prepare('operator',true,[selection]);await c.dispatch(null,true);await c.dispatch('operator',false);vi.advanceTimersByTime(45000);await c.dispatch('operator',true);expect(post).toHaveBeenCalledOnce();expect(c.state.entry?.dispatched).toBe(false);
});
test('storage failure or malformed/cross-scope journals never admit a new operation',async()=>{
 const post=vi.fn(),broken={...journal,setItem:()=>{throw Error('full')}};const c=new StudyAnalysisController(scope,broken,post,vi.fn());await c.prepare('operator',true,[selection]);expect(post).not.toHaveBeenCalled();values.set(c.key,JSON.stringify({input:{scope:{...scope,studyId:'other'},requestId:crypto.randomUUID(),selections:[selection]},dispatched:false}));const restored=new StudyAnalysisController(scope,journal,post,vi.fn());expect(restored.state.journalBlocked).toBe(true);await restored.prepare('operator',true,[selection]);expect(post).not.toHaveBeenCalled();
});
test('accepted native preparation with failed journal update remains original-only after remount',async()=>{
 let count=0;const flaky={...journal,setItem:(k:string,v:string)=>{if(++count===2)throw Error('full');journal.setItem(k,v);}},post=vi.fn().mockResolvedValue(reservation()),c=new StudyAnalysisController(scope,flaky,post,vi.fn());await c.prepare('operator',true,[selection]);expect(c.state.entry?.reservation).toBeUndefined();const restored=new StudyAnalysisController(scope,journal,post,vi.fn());await restored.prepare('operator',true,[selection]);expect(post).toHaveBeenCalledOnce();await restored.checkPrepared('operator');expect(post.mock.calls[1][0]).toBe('/api/research/analysis/prepare/receipt');
});
test('invalid selections/reservation and excessive frame count cannot dispatch',async()=>{
 const post=vi.fn().mockResolvedValue({...reservation(),live:false}),c=new StudyAnalysisController(scope,journal,post,vi.fn());await c.prepare('operator',true,[{...selection,end:0}]);expect(post).not.toHaveBeenCalled();await c.prepare('operator',true,[{...selection,kind:'screen-observation'},{...selection,id:'other',kind:'camera-observation'}]);expect(post).not.toHaveBeenCalled();await c.prepare('operator',true,[selection]);await c.dispatch('operator',true);expect(post).toHaveBeenCalledOnce();expect(c.state.entry?.reservation).toBeUndefined();
});
test('observer error cannot change native return semantics or cause a repeat',async()=>{
 const post=vi.fn().mockResolvedValueOnce(reservation()).mockResolvedValueOnce({analysisId:'analysis',state:'ready'}),c=new StudyAnalysisController(scope,journal,post,vi.fn(),()=>{throw Error('observer')});await c.prepare('operator',true,[selection]);await c.dispatch('operator',true);expect(c.state.entry?.result?.state).toBe('ready');expect(post).toHaveBeenCalledTimes(2);c.reset();expect(values.size).toBe(0);
});
test('HTTP helper sends exact scoped POST with same-origin referrer and no legacy reservationId',async()=>{
 const input={scope,requestId:crypto.randomUUID(),selections:[selection]},fetcher=vi.fn().mockResolvedValue(Response.json(reservation()));vi.stubGlobal('fetch',fetcher);await studyAnalysisPost('/api/research/analysis/prepare','operator',input);const[url,options]=fetcher.mock.calls[0];expect(url).toBe('/api/research/analysis/prepare');expect(JSON.parse(options.body)).toEqual(input);expect(options.referrerPolicy).toBe('same-origin');expect(options.credentials).toBe('same-origin');expect(options.signal.aborted).toBe(true);expect(JSON.parse(options.body).reservationId).toBeUndefined();
});

test('HTTP deadline settles an ignored cancellation with no second dispatch',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockImplementation(()=>new Promise(()=>{}));vi.stubGlobal('fetch',fetcher);const pending=studyAnalysisPost('/api/research/analysis','operator',{scope,requestId:crypto.randomUUID(),selections:[selection]});const result=expect(pending).rejects.toThrow('unconfirmed');await vi.advanceTimersByTimeAsync(45000);await result;expect(fetcher).toHaveBeenCalledOnce();
});

test('text-only policy denies unsupported preparation before creating a journal or sending capacity request',async()=>{
 const post=vi.fn(),c=new StudyAnalysisController(scope,journal,post,vi.fn());
 for(const kind of ['dom-event','screen-observation','camera-observation','audio','capture-gap'] as const) await c.prepare('operator',true,[{...selection,kind}],true);
 expect(post).not.toHaveBeenCalled();expect(values.size).toBe(0);expect(c.state.error).toContain('participant text only');
});
test('a newly narrowed text-only policy retains an older prepared media request without dispatch or reset',async()=>{
 const post=vi.fn().mockResolvedValue(reservation()),c=new StudyAnalysisController(scope,journal,post,vi.fn());await c.prepare('operator',true,[{...selection,kind:'camera-observation'}]);await c.dispatch('operator',true,true);
 expect(post).toHaveBeenCalledOnce();expect(c.state.entry?.dispatched).toBe(false);expect(c.state.entry?.input.selections[0].kind).toBe('camera-observation');expect(c.state.error).toContain('original prepared request remains retained');
});
test('policy read is authenticated and bounded, and never sends a mutation or accepts missing policy',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({textOnly:true})).mockResolvedValueOnce(Response.json({state:'disabled'}));vi.stubGlobal('fetch',fetcher);
 expect(await analysisPolicyGet('operator')).toBe(true);const[url,options]=fetcher.mock.calls[0];expect(url).toBe('/api/research/analysis/readiness');expect(options.method).toBe('GET');expect(options.body).toBeUndefined();expect(options.headers.Authorization).toBe('Bearer operator');
 await expect(analysisPolicyGet('operator')).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
});
