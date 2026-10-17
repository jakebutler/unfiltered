import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsentSharing } from '../src/ConsentSharing';
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[], effects: [] as (() => void)[] }));
const calls = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn() }));
vi.mock('react', async original => ({ ...await original<any>(),
 useRef(value: unknown) { const index = hooks.cursor++; return hooks.values[index] ??= { current: value }; },
 useState(value: unknown) { const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]=typeof value==='function'?value():value;return[hooks.values[index],(next:any)=>{hooks.values[index]=typeof next==='function'?next(hooks.values[index]):next;}]; },
 useEffect(callback:()=>void,dependencies:unknown[]) {const index=hooks.cursor++;const prior=hooks.values[index];if(!prior||dependencies.some((value,n)=>value!==prior[n])){hooks.values[index]=dependencies;hooks.effects.push(callback);}},
}));
vi.mock('convex/react',()=>({useConvex:()=>calls}));
function nodes(tree:unknown,type:string):ReactElement<any>[] {if(Array.isArray(tree))return tree.flatMap(child=>nodes(child,type));if(!tree||typeof tree!=='object'||!('props'in tree))return[];const n=tree as ReactElement<any>;return[...(n.type===type?[n]:[]),...nodes(n.props.children,type)];}
function fixture() {return{token:'private-token',session:{sessionId:'session',revision:5,state:'active',consent:{version:'research-consent-1',storage:true,analysis:true,microphone:true,camera:false,screen:true,dom:true,shareTranscript:false,shareAudio:false,shareCamera:false,shareScreen:true,shareDom:false,retainApprovedExcerpts:false}}as any,blocked:false,refresh:vi.fn(),onPending:vi.fn()};}
function render(p:ReturnType<typeof fixture>) {hooks.cursor=0;hooks.effects=[];const tree=ConsentSharing(p);for(const effect of hooks.effects)effect();return tree;}
function choose(p:ReturnType<typeof fixture>,value=true) {nodes(render(p),'input')[0].props.onChange({target:{checked:value}});}
const storage=new Map<string,string>();
beforeEach(()=>{hooks.cursor=0;hooks.values=[];hooks.effects=[];storage.clear();calls.mutation.mockReset();calls.query.mockReset();vi.stubGlobal('sessionStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
test('explicit choice preserves all other consent fields and only acknowledges native revision',async()=>{
 const p=fixture();choose(p);let done!:(revision:number)=>void;calls.mutation.mockImplementation(()=>new Promise(resolve=>{done=resolve}));const click=nodes(render(p),'button')[0].props.onClick;const saving=click();await click();expect(calls.mutation).toHaveBeenCalledOnce();expect(calls.mutation.mock.calls[0][1]).toEqual({token:p.token,expectedRevision:5,consent:{...p.session.consent,shareTranscript:true}});expect(p.refresh).not.toHaveBeenCalled();expect(renderToStaticMarkup(render(p))).not.toContain('saved at interview');expect(p.onPending).toHaveBeenLastCalledWith(true);done(6);await saving;await click();expect(calls.mutation).toHaveBeenCalledOnce();expect(storage.size).toBe(0);expect(renderToStaticMarkup(render(p))).toContain('saved at interview revision 6');p.session={...p.session,revision:6,consent:{...p.session.consent,shareTranscript:true}};render(p);expect(p.onPending).toHaveBeenLastCalledWith(false);
});
test('stale review and parent activity block writes; checkbox alone sends nothing',async()=>{
 const p=fixture();choose(p);expect(calls.mutation).not.toHaveBeenCalled();p.session={...p.session,revision:6};expect(nodes(render(p),'button')[0].props.disabled).toBe(true);await nodes(render(p),'button')[0].props.onClick();expect(calls.mutation).not.toHaveBeenCalled();p.session={...p.session,revision:5};p.blocked=true;await nodes(render(p),'button')[0].props.onClick();expect(calls.mutation).not.toHaveBeenCalled();
});
test('unknown timeout survives remount and uses only exact revision/whole-consent readback',async()=>{
 vi.useFakeTimers();const p=fixture();choose(p);calls.mutation.mockImplementation(()=>new Promise(()=>{}));const click=nodes(render(p),'button')[0].props.onClick,saving=click();await vi.advanceTimersByTimeAsync(30000);await saving;await click();expect(calls.mutation).toHaveBeenCalledOnce();hooks.values=[];expect(nodes(render(p),'button')[0].props.disabled).toBe(true);calls.query.mockResolvedValue({...p.session,revision:6,consent:{...p.session.consent,shareTranscript:true}});await nodes(render(p),'button')[1].props.onClick();expect(calls.query).toHaveBeenCalledOnce();expect(calls.query.mock.calls[0][1]).toEqual({token:p.token});expect(calls.mutation).toHaveBeenCalledOnce();expect(storage.size).toBe(0);expect(renderToStaticMarkup(render(p))).toContain('saved at interview revision 6');
});
test.each(['different-consent','later-revision','wrong-session','unchanged'])('unconfirmed %s readback preserves original intent and never resubmits',async mode=>{
 const p=fixture();choose(p);calls.mutation.mockRejectedValue(new Error('network'));await nodes(render(p),'button')[0].props.onClick();const current={...p.session,revision:6,consent:{...p.session.consent,shareTranscript:true}};if(mode==='different-consent')current.consent.camera=true;if(mode==='later-revision')current.revision=7;if(mode==='wrong-session')current.sessionId='another';if(mode==='unchanged')current.revision=5;calls.query.mockResolvedValue(current);await nodes(render(p),'button')[1].props.onClick();expect(storage.size).toBe(1);expect(calls.mutation).toHaveBeenCalledOnce();expect(renderToStaticMarkup(render(p))).toContain('cannot be confirmed');expect(nodes(render(p),'button')[0].props.disabled).toBe(true);
});
test('definitive rejection clears pending and never claims sharing was saved',async()=>{
 const p=fixture();choose(p);calls.mutation.mockRejectedValue({data:'Stale revision'});await nodes(render(p),'button')[0].props.onClick();expect(storage.size).toBe(0);expect(renderToStaticMarkup(render(p))).toContain('Stale revision');expect(renderToStaticMarkup(render(p))).not.toContain('saved at interview');
});
test('storage failure and malformed retained intent deny new writes',async()=>{
 const p=fixture();storage.set('corvo.research.sharing.session','bad');expect(nodes(render(p),'button')[0].props.disabled).toBe(true);await nodes(render(p),'button')[1].props.onClick();expect(calls.mutation).not.toHaveBeenCalled();expect(calls.query).not.toHaveBeenCalled();hooks.values=[];storage.clear();vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:()=>{throw Error('storage disabled')},removeItem:()=>{}});choose(p);await nodes(render(p),'button')[0].props.onClick();expect(calls.mutation).not.toHaveBeenCalled();expect(renderToStaticMarkup(render(p))).toContain('No change was sent');
});
test('acknowledged consent remains positive if local refresh fails; copy and removal are explicit',async()=>{
 const p=fixture();p.session.consent.shareTranscript=true;choose(p,false);p.refresh.mockImplementation(()=>{throw Error('render')});calls.mutation.mockResolvedValue(6);await nodes(render(p),'button')[0].props.onClick();expect(calls.mutation.mock.calls[0][1].consent).toEqual({...p.session.consent,shareTranscript:false});const html=renderToStaticMarkup(render(p));expect(html).toContain('saved at interview revision 6');expect(html).toContain('cannot be recalled');expect(html).not.toContain('unconfirmed');
});
