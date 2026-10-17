import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewInterviewRun } from '../src/NewInterviewRun';
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[], effects: [] as (() => void)[] }));
const calls = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn() }));
vi.mock('react', async original => ({ ...await original<any>(),
  useRef(value: unknown) { const i = hooks.cursor++; return hooks.values[i] ??= { current: value }; },
  useState(value: unknown) { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof value === 'function' ? value() : value; return [hooks.values[i], (next: any) => { hooks.values[i] = typeof next === 'function' ? next(hooks.values[i]) : next; }]; },
  useEffect(callback: () => void, deps: unknown[]) { const i = hooks.cursor++, prior = hooks.values[i]; if (!prior || deps.some((v, n) => v !== prior[n])) { prior?.cleanup?.(); const value: any = [...deps]; hooks.values[i] = value; hooks.effects.push(() => { value.cleanup = callback(); }); } },
}));
vi.mock('convex/react', () => ({ useConvex: () => calls }));
function nodes(tree: unknown, type: string): ReactElement<any>[] { if (Array.isArray(tree)) return tree.flatMap(x => nodes(x, type)); if (!tree || typeof tree !== 'object' || !('props' in tree)) return []; const n = tree as ReactElement<any>; return [...(n.type === type ? [n] : []), ...nodes(n.props.children, type)]; }
function fixture() { return { scope: { clientId: 'client', projectId: 'project' } as any, sourceVersion: 2, definition: { title: 'Synthetic study', introduction: 'Synthetic only', goals: ['Checkout'], script: [{ id: 'q1', question: 'What did you notice?' }], prototypeUrl: 'https://example.test/prototype', repository: null } as any, project: { revision: 8, latestStudyVersion: 4 }, active: true, allowNavigation: vi.fn(() => true), onSaved: vi.fn(), onPending: vi.fn() }; }
type Props = ReturnType<typeof fixture>;
function render(p: Props) { hooks.cursor = 0; hooks.effects = []; const tree = NewInterviewRun(p); for (const effect of hooks.effects) effect(); return tree; }
function button(p: Props, text: string) { return nodes(render(p), 'button').find(n => n.props.children === text)!; }
async function create(p: Props) { button(p, 'Start a new interview run').props.onClick(); return button(p, 'Create new run').props.onClick(); }
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
const storage = new Map<string, string>();
beforeEach(() => { hooks.cursor = 0; hooks.values = []; hooks.effects = []; storage.clear(); calls.mutation.mockReset(); calls.query.mockReset(); vi.stubGlobal('sessionStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) }); });
afterEach(() => { for (const v of hooks.values) v?.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });
test('copies the selected saved definition once with exact project CAS, then selects only the acknowledged new version', async () => {
  const p = fixture(), frozen = structuredClone(p.definition); let deliver!: (x: any) => void;
  calls.mutation.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  await create(p); expect(calls.mutation).toHaveBeenCalledOnce(); expect(calls.mutation.mock.calls[0][1]).toEqual({ ...p.scope, expectedRevision: 8, definition: frozen });
  p.definition.script[0].question = 'Changed later'; expect(calls.mutation.mock.calls[0][1].definition).toEqual(frozen); expect(p.onSaved).not.toHaveBeenCalled();
  expect(button(p, 'Start a new interview run').props.disabled).toBe(true); expect(p.onPending).toHaveBeenLastCalledWith(true);
  deliver({ studyId: 'new-study', version: 5, projectRevision: 9 }); await settle(); expect(p.onSaved).toHaveBeenCalledWith(5); expect(storage.size).toBe(0);
  expect(renderToStaticMarkup(render(p))).toContain('Create new invitations and authorize its prototype');
});
test('unknown save survives remount and unchanged project remains blocked without resubmission', async () => {
  const p = fixture(); calls.mutation.mockRejectedValue(new Error('network')); await create(p); await settle(); hooks.values = [];
  expect(button(p, 'Start a new interview run').props.disabled).toBe(true); calls.query.mockResolvedValue({ client: { _id: 'client' }, project: { _id: 'project', revision: 8, latestStudyVersion: 4 } });
  await button(p, 'Check unfinished run').props.onClick(); await settle(); expect(storage.size).toBe(1); expect(calls.mutation).toHaveBeenCalledOnce(); expect(p.onSaved).not.toHaveBeenCalled();
  expect(renderToStaticMarkup(render(p))).toContain('cannot be confirmed yet');
});
test('advanced native project CAS allows explicit latest-version review without attributing an unknown save or creating a replacement', async () => {
  const p = fixture(); calls.mutation.mockRejectedValue(new Error('network')); await create(p); await settle();
  calls.query.mockResolvedValue({ client: { _id: 'client' }, project: { _id: 'project', revision: 10, latestStudyVersion: 6 } });
  await button(p, 'Check unfinished run').props.onClick(); await settle(); expect(storage.size).toBe(1); expect(p.onSaved).not.toHaveBeenCalled(); expect(renderToStaticMarkup(render(p))).not.toContain('New interview run saved');
  button(p, 'Review latest saved version').props.onClick(); expect(p.onSaved).toHaveBeenCalledWith(6); expect(storage.size).toBe(0); expect(calls.mutation).toHaveBeenCalledOnce();
});
test('late positive acknowledgement is retained after timeout and remount, never submitted again', async () => {
  vi.useFakeTimers(); const p = fixture(); let deliver!: (x: any) => void; calls.mutation.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  await create(p); await vi.advanceTimersByTimeAsync(30000); await settle(); for (const v of hooks.values) v?.cleanup?.(); hooks.values = [];
  render(p); deliver({ studyId: 'new-study', version: 5, projectRevision: 9 }); await settle(); await button(p, 'Check unfinished run').props.onClick(); await settle();
  expect(calls.query).not.toHaveBeenCalled(); expect(calls.mutation).toHaveBeenCalledOnce(); button(p, 'Open new run').props.onClick(); expect(p.onSaved).toHaveBeenCalledWith(5); expect(storage.size).toBe(0);
});
test('late old acknowledgement cannot overwrite a newer deliberate run after CAS reconciliation', async () => {
  vi.useFakeTimers(); const p = fixture(); let first!: (x: any) => void; calls.mutation.mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockImplementationOnce(() => new Promise(() => {}));
  await create(p); await vi.advanceTimersByTimeAsync(30000); await settle(); calls.query.mockResolvedValue({ client: { _id: 'client' }, project: { _id: 'project', revision: 9, latestStudyVersion: 5 } });
  await button(p, 'Check unfinished run').props.onClick(); await settle(); button(p, 'Review latest saved version').props.onClick(); p.project = { revision: 9, latestStudyVersion: 5 }; p.sourceVersion = 5;
  await create(p); first({ studyId: 'first-study', version: 5, projectRevision: 9 }); await settle(); expect(JSON.parse([...storage.values()][0])).toMatchObject({ expectedRevision: 9, expectedVersion: 6 }); expect(calls.mutation).toHaveBeenCalledTimes(2);
});
test.each(['wrong-project', 'wrong-client', 'older-version'])('mismatched %s project read cannot clear original intent', async mode => {
  const p = fixture(); calls.mutation.mockRejectedValue(new Error('network')); await create(p); await settle(); const current = { client: { _id: 'client' }, project: { _id: 'project', revision: 9, latestStudyVersion: 5 } };
  if (mode === 'wrong-project') current.project._id = 'other'; if (mode === 'wrong-client') current.client._id = 'other'; if (mode === 'older-version') current.project.latestStudyVersion = 3;
  calls.query.mockResolvedValue(current); await button(p, 'Check unfinished run').props.onClick(); await settle(); expect(storage.size).toBe(1); expect(p.onSaved).not.toHaveBeenCalled(); expect(calls.mutation).toHaveBeenCalledOnce();
});
test('archive, navigation refusal and unavailable journal prevent new writes', async () => {
  const p = fixture(); p.active = false; expect(button(p, 'Start a new interview run').props.disabled).toBe(true); p.active = true; p.allowNavigation.mockReturnValue(false); button(p, 'Start a new interview run').props.onClick(); expect(nodes(render(p), 'button').some(n => n.props.children === 'Create new run')).toBe(false);
  p.allowNavigation.mockReturnValue(true); vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => { throw new Error('disabled'); }, removeItem: () => {} }); await create(p); await settle(); expect(calls.mutation).not.toHaveBeenCalled(); expect(renderToStaticMarkup(render(p))).toContain('No new run was sent');
});
test('positive server save stays positive if selecting its new version fails locally', async () => {
  const p = fixture(); p.onSaved.mockImplementation(() => { throw new Error('view'); }); calls.mutation.mockResolvedValue({ studyId: 'new-study', version: 5, projectRevision: 9 }); await create(p); await settle();
  expect(storage.size).toBe(1); expect(renderToStaticMarkup(render(p))).toContain('New interview run saved as version 5'); expect(button(p, 'Open new run')).toBeTruthy(); expect(calls.mutation).toHaveBeenCalledOnce();
});
