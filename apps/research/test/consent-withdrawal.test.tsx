import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsentWithdrawal } from '../src/ConsentWithdrawal';
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[] }));
const mutation = vi.hoisted(() => vi.fn());
vi.mock('react', async original => ({ ...await original<any>(),
  useRef(value: unknown) { const index = hooks.cursor++; return hooks.values[index] ??= { current: value }; },
  useState(value: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof value === 'function' ? value() : value; return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }]; },
}));
vi.mock('convex/react', () => ({ useConvex: () => ({ mutation }) }));
function nodes(tree: unknown, type: string): ReactElement<any>[] {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<any>; return [...(node.type === type ? [node] : []), ...nodes(node.props.children, type)];
}
function fixture(state = 'completed') { return { token: 'private-token', session: { sessionId: 'session', revision: 15, state, consent: { version: 'research-consent-1', storage: true, analysis: true, microphone: true, camera: true, screen: true, dom: true, shareTranscript: true, shareAudio: true, shareCamera: true, shareScreen: true, shareDom: true, retainApprovedExcerpts: true } } as any, blocked: false, stop: vi.fn(async () => {}), onWithdrawn: vi.fn() }; }
function render(props: Parameters<typeof ConsentWithdrawal>[0]) { hooks.cursor = 0; return ConsentWithdrawal(props); }
async function review(props: ReturnType<typeof fixture>) { await nodes(render(props), 'button')[0].props.onClick(); nodes(render(props), 'input')[0].props.onChange({ target: { checked: true } }); }
const storage = new Map<string,string>();
beforeEach(() => { hooks.cursor = 0; hooks.values = []; mutation.mockReset(); storage.clear(); vi.stubGlobal('sessionStorage', { getItem: (k:string) => storage.get(k) ?? null, setItem: (k:string,v:string) => storage.set(k,v), removeItem: (k:string) => storage.delete(k) }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
test.each(['completed', 'partial', 'active'])('withdrawal remains available in %s and review stops devices without sending consent', async state => {
 const props=fixture(state); await review(props); expect(props.stop).toHaveBeenCalledOnce(); expect(mutation).not.toHaveBeenCalled();
 const html=renderToStaticMarkup(render(props)); expect(html).toContain('queued for permanent deletion'); expect(html).toContain('cannot be recalled');
 nodes(render(props),'button')[1].props.onClick(); expect(props.stop).toHaveBeenCalledOnce(); expect(mutation).not.toHaveBeenCalled();
});
test('deliberate confirmation sends original CAS exactly once, preserves version, and acknowledges only positive native result', async () => {
 const props=fixture(); await review(props); let done!:(value:number)=>void; mutation.mockImplementation(() => new Promise<number>(resolve => { done=resolve; }));
 const click=nodes(render(props),'button')[0].props.onClick; const pending=click(); await click(); expect(mutation).toHaveBeenCalledOnce(); expect(props.onWithdrawn).not.toHaveBeenCalled();
 expect(mutation.mock.calls[0][1]).toEqual({ token:props.token, expectedRevision:15, consent:Object.fromEntries(Object.keys(props.session.consent).map(key=>[key,key==='version'?'research-consent-1':false])) });
 done(16); await pending; expect(props.onWithdrawn).toHaveBeenCalledWith(16); expect(storage.get('corvo.research.withdrawal.session')).toBe('accepted:16');
});
test('changed revision blocks reviewed confirmation; native stale rejection never claims withdrawal', async () => {
 const props=fixture(); await review(props); props.session={...props.session,revision:16}; const tree=render(props); expect(nodes(tree,'button')[0].props.disabled).toBe(true); await nodes(tree,'button')[0].props.onClick(); expect(mutation).not.toHaveBeenCalled();
 props.session={...props.session,revision:15}; mutation.mockRejectedValue({data:'Stale revision'}); await nodes(render(props),'button')[0].props.onClick(); expect(props.onWithdrawn).not.toHaveBeenCalled(); expect(storage.size).toBe(0); expect(renderToStaticMarkup(render(props))).toContain('Stale revision');
});
test('unknown acknowledgement survives remount and cannot redispatch; finite wait does not infer deletion', async () => {
 vi.useFakeTimers(); const props=fixture(); await review(props); mutation.mockImplementation(() => new Promise(()=>{})); const click=nodes(render(props),'button')[0].props.onClick; const pending=click(); await vi.advanceTimersByTimeAsync(30_000); await pending; await click(); expect(mutation).toHaveBeenCalledOnce(); expect(props.onWithdrawn).not.toHaveBeenCalled(); expect(storage.size).toBe(1);
 hooks.values=[]; const tree=render(props); expect(nodes(tree,'button')[0].props.disabled).toBe(true); await nodes(tree,'button')[0].props.onClick(); expect(mutation).toHaveBeenCalledOnce(); expect(renderToStaticMarkup(tree)).toContain('already submitted');
});
test('failed local stop and unacknowledged confirmation send no withdrawal', async () => {
 const props=fixture(); props.stop.mockRejectedValue(new Error('failed')); await nodes(render(props),'button')[0].props.onClick(); expect(mutation).not.toHaveBeenCalled(); expect(renderToStaticMarkup(render(props))).toContain('No consent change was sent');
 props.stop.mockResolvedValue(); await nodes(render(props),'button')[0].props.onClick(); expect(nodes(render(props),'button')[0].props.disabled).toBe(true); await nodes(render(props),'button')[0].props.onClick(); expect(mutation).not.toHaveBeenCalled();
});

test('parent notification failure retains positive native receipt and cannot retry or become unknown', async () => {
 const props=fixture(); await review(props); mutation.mockResolvedValue(16); props.onWithdrawn.mockImplementation(() => { throw new Error('local notification failed'); });
 const click=nodes(render(props),'button')[0].props.onClick; await click(); await click(); expect(mutation).toHaveBeenCalledOnce(); expect(renderToStaticMarkup(render(props))).toContain('accepted at interview revision 16'); expect(renderToStaticMarkup(render(props))).not.toContain('unconfirmed'); expect(storage.get('corvo.research.withdrawal.session')).toBe('accepted:16');
 hooks.values=[]; expect(renderToStaticMarkup(render(props))).toContain('accepted at interview revision 16'); expect(nodes(render(props),'button')).toHaveLength(0);
});
