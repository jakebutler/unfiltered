import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ClinicSessionView, StaffHandoffView, StaffIdentity, StaffRecoveryItem } from '../../../packages/clinic-contract/src/index';
import { RequestError } from '../src/api';
import { StaffApp, StaffActionForm, RecoveryQueue, StaffDeliverySummary } from '../src/StaffApp';
import { Delivery, PreviousDelivery } from '../src/PatientApp';
import { freezeStaffAction, reconcileStaffAction, StaffResponseScope } from '../src/staff-delivery-state';

const harness = vi.hoisted(() => ({ active: false, cursor: 0, values: [] as any[], effects: [] as (() => void)[], request: vi.fn() }));
vi.mock('../src/api', async original => ({ ...await original<any>(), request: harness.request }));
vi.mock('react', async original => {
  const react = await original<any>();
  return { ...react,
    useState(value: unknown) {
      if (!harness.active) return react.useState(value);
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = typeof value === 'function' ? value() : value;
      return [harness.values[index], (next: any) => { harness.values[index] = typeof next === 'function' ? next(harness.values[index]) : next; }];
    },
    useRef(value: unknown) {
      if (!harness.active) return react.useRef(value);
      const index = harness.cursor++;
      return harness.values[index] ??= { current: value };
    },
    useEffect(callback: () => void | (() => void), dependencies: unknown[]) {
      if (!harness.active) return react.useEffect(callback, dependencies);
      const index = harness.cursor++, previous = harness.values[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) harness.effects.push(() => {
        previous?.cleanup?.(); harness.values[index] = { dependencies, cleanup: callback() };
      });
    },
  };
});
const at = '2026-10-10T18:00:00Z';
const identity: StaffIdentity = { name: 'Synthetic clinician', role: 'physician' };
const actionId = '732f2eb0-7bf5-4ea4-90e1-a589db1f7393';
const topic = { id: 'clinical-topic', title: 'Synthetic medical detail', required: true, status: 'ready-for-review' as const, missingDetails: [], details: [{ id: 'detail', label: 'Clinical words', state: 'answered' as const, text: 'Synthetic clinical sentinel', sourceIds: ['source-1'] }] };
function handoff(overrides: Partial<StaffHandoffView> = {}): StaffHandoffView {
  return { id: 'confirmed-v1', patientName: 'Synthetic patient', title: 'Synthetic intake', version: 1, completeness: 'complete', deliveryState: 'incomplete', anchorsVerified: true, canResume: true, topics: [topic], sources: [{ id: 'source-1', role: 'patient', text: 'Synthetic clinical sentinel', at }], work: [
    { id: 'medical-work', title: 'Medical review', responsibility: 'medical', revision: 'opaque-original-revision', delivery: 'verified', status: 'received', history: [] },
    { id: 'nutrition-work', title: 'Nutrition review', responsibility: 'nutrition', revision: '', delivery: 'pending', status: 'pending', history: [] },
  ], allowedActions: [{ workId: 'medical-work', outcomes: ['reviewed'] }], ...overrides };
}
const recoveryItem = (id: string, anchorsVerified = false): StaffRecoveryItem => ({ id, patientName: 'Synthetic patient', scenarioTitle: 'Synthetic intake', deliveryState: 'incomplete', anchorsVerified, canResume: true });
function nodes(tree: unknown, predicate: (node: ReactElement<any>) => boolean): ReactElement<any>[] {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<any>;
  return [...(predicate(node) ? [node] : []), ...nodes(node.props.children, predicate), ...nodes(node.props.action, predicate)];
}
function component(tree: unknown, name: string) { const found = nodes(tree, node => typeof node.type === 'function' && node.type.name === name)[0]; if (!found) throw new Error(`Missing component ${name}`); return found; }
function button(tree: unknown, label: string) { const found = nodes(tree, node => node.props['aria-label'] === label || text(node.props.children) === label)[0]; if (!found) throw new Error(`Missing button ${label}`); return found; }
function text(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object' && 'props' in tree) return text((tree as ReactElement<any>).props.children);
  return '';
}
function render() {
  harness.cursor = 0; harness.effects = []; harness.active = true;
  const tree = StaffApp(); harness.active = false;
  for (const effect of harness.effects) effect();
  return tree;
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function boot(page = { items: [], recovery: [recoveryItem('confirmed-v1', true)] } as any) {
  harness.request.mockImplementation(async (path: string) => {
    if (path === '/api/staff/me') return identity;
    if (path.startsWith('/api/staff/queue')) return page;
    return handoff();
  });
  render(); await settle(); render(); await settle(); return render();
}
async function open() { component(render(), 'RecoveryQueue').props.onOpen('confirmed-v1'); await settle(); return render(); }
function html(tree = render()) { return renderToStaticMarkup(tree); }
beforeEach(() => {
  harness.active = false; harness.cursor = 0; harness.values = []; harness.effects = []; harness.request.mockReset();
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => actionId) });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { for (const value of harness.values) value?.cleanup?.(); vi.unstubAllGlobals(); });

it('renders confirmed no-snapshot and verified zero-Task recovery even with an empty normal queue', async () => {
  await boot({ items: [], recovery: [recoveryItem('confirmed-v1'), recoveryItem('verified-zero-task', true)], recoveryCursor: 'recovery-next' });
  let markup = html();
  expect(markup).toContain('No assigned work yet'); expect(markup).toContain('Confirmation saved · metadata only');
  expect(markup).toContain('Verified answers available · routing pending'); expect(markup).toContain('Load more pending deliveries');
  harness.request.mockResolvedValue(handoff({ work: [], allowedActions: [] }));
  await open(); markup = html();
  expect(markup).toContain('Confirmed version 1'); expect(markup).not.toContain('Received version 1');
  expect(markup).toContain('Synthetic clinical sentinel'); expect(markup).toContain('Complete delivery pending');
});

it('keeps unverified recovery metadata only and renders confirmed sanitized admin logistics without source controls', async () => {
  await boot(); harness.request.mockResolvedValue(handoff({ anchorsVerified: false, work: [], allowedActions: [] }));
  await open(); let markup = html();
  expect(markup).toContain('Confirmed delivery metadata only'); expect(markup).not.toContain('Synthetic clinical sentinel');
  // A new authenticated identity gets a fresh scope; only the service-projected admin topic is used.
  for (const value of harness.values) value?.cleanup?.(); harness.values = [];
  harness.request.mockImplementation(async path => path === '/api/staff/me' ? { name: 'Synthetic admin', role: 'administrative' } : path.startsWith('/api/staff/queue') ? { items: [], recovery: [recoveryItem('confirmed-v1', true)] } : handoff({ topics: [{ id: 'logistics', title: 'Visit request', required: true, status: 'ready-for-review', missingDetails: [], details: [{ id: 'intent', label: 'Request', state: 'answered', text: 'request', sourceIds: [] }] }], sources: [], allowedActions: [] }));
  render(); await settle(); render(); await settle(); await open(); markup = html();
  expect(markup).toContain('Request a visit'); expect(markup).toContain('Administrative details only');
  expect(markup).not.toContain('Synthetic clinical sentinel'); expect(markup).not.toContain('Open source');
});

it('continues both snapshot and draft namespaces from recovery, merging mixed pages without duplicates', async () => {
  const assigned = { id: 'assigned', patientName: 'Assigned patient', scenarioTitle: 'Visit', completeness: 'complete', status: 'received', responsibility: 'medical' };
  await boot({ items: [assigned], recovery: [recoveryItem('confirmed-v1')], nextCursor: '5', recoveryCursor: '10' });
  harness.request.mockImplementation(async path => {
    if (path === '/api/staff/queue?cursor=5') return { items: [assigned, { ...assigned, id: 'second-assigned', patientName: 'Second assigned' }], recovery: [recoveryItem('confirmed-v1'), recoveryItem('snapshot-page-two')], recoveryCursor: '5' };
    if (path === '/api/staff/queue?recoveryCursor=10') return { items: [assigned], recovery: [recoveryItem('confirmed-v1'), recoveryItem('draft-page-three')], nextCursor: '5', recoveryCursor: '15' };
    if (path === '/api/staff/queue?recoveryCursor=15') return { items: [assigned], recovery: [recoveryItem('draft-page-three'), recoveryItem('draft-page-four')] };
    throw new Error(`Unexpected request ${path}`);
  });
  component(render(), 'RecoveryQueue').props.onMore(); await settle();
  let tree = render();
  expect(harness.request).toHaveBeenLastCalledWith('/api/staff/queue?cursor=5');
  expect(component(tree, 'RecoveryQueue').props.cursor).toBe('10');
  expect(html(tree)).toContain('Second assigned'); expect(html(tree)).not.toContain('Load more work');
  expect(nodes(tree, node => node.type === 'button' && text(node.props.children).includes('Assigned patient'))).toHaveLength(1);
  component(tree, 'RecoveryQueue').props.onMore(); await settle(); tree = render();
  expect(harness.request).toHaveBeenLastCalledWith('/api/staff/queue?recoveryCursor=10');
  expect(component(tree, 'RecoveryQueue').props.cursor).toBe('15');
  expect(html(tree)).toContain('Assigned patient'); expect(html(tree)).toContain('Second assigned');
  expect(html(tree)).not.toContain('Load more work');
  component(tree, 'RecoveryQueue').props.onMore(); await settle(); tree = render();
  expect(harness.request).toHaveBeenLastCalledWith('/api/staff/queue?recoveryCursor=15');
  expect(component(tree, 'RecoveryQueue').props.items.map((item: StaffRecoveryItem) => item.id)).toEqual(['confirmed-v1', 'snapshot-page-two', 'draft-page-three', 'draft-page-four']);
  expect(component(tree, 'RecoveryQueue').props.cursor).toBeUndefined();
});

it('preserves pending sixth snapshots when paging ordinary work, including with empty assignments', async () => {
  await boot({ items: [], recovery: [], nextCursor: '5' });
  harness.request.mockResolvedValue({ items: [], recovery: [recoveryItem('sixth-pending-snapshot', true)] });
  await button(render(), 'Load more work').props.onClick(); await settle();
  const tree = render();
  expect(harness.request).toHaveBeenLastCalledWith('/api/staff/queue?cursor=5');
  expect(component(tree, 'RecoveryQueue').props.items.map((item: StaffRecoveryItem) => item.id)).toEqual(['sixth-pending-snapshot']);
  expect(component(tree, 'RecoveryQueue').props.cursor).toBeUndefined();
});

it('preserves both continuations on page errors and source selection/focus through mixed-page loading', async () => {
  await boot({ items: [], recovery: [recoveryItem('confirmed-v1', true)], nextCursor: '5', recoveryCursor: '10' });
  await open();
  const trigger = { focus: vi.fn() };
  component(render(), 'TopicContent').props.onSource({ topicId: topic.id, title: 'Original words', ids: ['source-1'] }, trigger);
  let reject!: (error: unknown) => void;
  harness.request.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  component(render(), 'RecoveryQueue').props.onMore(); await settle();
  let tree = render();
  expect(component(tree, 'RecoveryQueue').props.loading).toBe(true);
  expect(component(tree, 'RecoveryQueue').props.disabled).toBe(true);
  expect(component(tree, 'SourceInspector').props.ids).toEqual(['source-1']);
  reject(new RequestError('Page unavailable', 503, 'queue-unavailable', true)); await settle(); tree = render();
  expect(component(tree, 'RecoveryQueue').props.loading).toBe(false);
  expect(component(tree, 'RecoveryQueue').props.error).toBe(true);
  expect(component(tree, 'RecoveryQueue').props.cursor).toBe('5');
  expect(component(tree, 'RecoveryQueue').props.items).toHaveLength(1);
  // The visible read-only refresh clears the page error without resetting source selection.
  harness.request.mockImplementation(async path => path.startsWith('/api/staff/queue') ? { items: [], recovery: [recoveryItem('confirmed-v1', true)], nextCursor: '5', recoveryCursor: '10' } : handoff());
  await component(tree, 'RecoveryQueue').props.onRefresh(); await settle(); tree = render();
  expect(component(tree, 'RecoveryQueue').props.error).toBe(false);
  expect(component(tree, 'SourceInspector').props.ids).toEqual(['source-1']);
  harness.request.mockResolvedValue({ items: [], recovery: [recoveryItem('snapshot-page-two')], recoveryCursor: '5' });
  component(tree, 'RecoveryQueue').props.onMore(); await settle(); tree = render();
  expect(component(tree, 'RecoveryQueue').props.error).toBe(false);
  expect(component(tree, 'RecoveryQueue').props.cursor).toBe('10');
  expect(component(tree, 'SourceInspector').props.ids).toEqual(['source-1']);
  component(tree, 'SourceInspector').props.onClose(); expect(trigger.focus).toHaveBeenCalledOnce();
});

it('omits clinical completeness copy from administrative detail and queue', async () => {
  harness.request.mockImplementation(async path => path === '/api/staff/me' ? { name:'Synthetic admin', role:'administrative' } : path.startsWith('/api/staff/queue') ? { items:[{ id:'confirmed-v1', patientName:'Assigned admin patient', scenarioTitle:'Administrative assistance', responsibility:'administrative', status:'received' }], recovery:[] } : handoff({ completeness:undefined, topics:[], sources:[], allowedActions:[] }));
  render(); await settle(); render(); await settle(); let tree=render();
  await nodes(tree, node => node.type === 'button' && text(node.props.children).includes('Assigned admin patient'))[0].props.onClick(); await settle();
  const markup=html();
  expect(markup).toContain('Administrative details only');
  expect(markup).not.toContain('Partial handoff'); expect(markup).not.toContain('Required details recorded'); expect(markup).not.toContain(' · Partial');
});

it('shows received own work and pending sibling without inventing a global receipt', async () => {
  await boot(); await open(); const markup = html();
  expect(markup).toContain('Work received'); expect(markup).toContain('Work delivery pending');
  expect(markup).toContain('Delivery of all required work is still pending'); expect(markup).not.toContain('Received version 1');
  expect(component(render(), 'StaffActionForm').props.disabled).toBe(false);
});

it('retains an unknown action, requires readback, replays original bytes and reconciles earlier authenticated history despite later external edits', async () => {
  await boot(); await open();
  harness.request.mockRejectedValueOnce(new RequestError('Response lost', 0, 'connection-interrupted', true));
  await component(render(), 'StaffActionForm').props.onRecord('medical-work', 'reviewed', 'Original synthetic note');
  const original = harness.request.mock.calls.at(-1)![1];
  expect(original).toMatchObject({ actionId, expectedWorkVersion: 'opaque-original-revision', note: 'Original synthetic note' });
  expect(html()).toContain('The result of your last action is unconfirmed'); expect(html()).not.toContain('Retry original action');
  expect(component(render(), 'StaffActionForm').props.disabled).toBe(true);
  // Refresh never submits an action and does not adopt a newer CAS revision for replay.
  const changed = handoff({ work: [{ ...handoff().work[0], revision: 'newer-opaque-revision' }, handoff().work[1]] });
  harness.request.mockImplementation(async path => path.startsWith('/api/staff/queue') ? { items: [], recovery: [] } : changed);
  await button(render(), 'Refresh work queue').props.onClick(); await settle();
  expect(html()).toContain('Retry original action');
  expect(harness.request.mock.calls.filter(call => call[0].endsWith('/actions'))).toHaveLength(1);
  const recorded = handoff({ work: [{ ...changed.work[0], status: 'external-change', outcome: 'Do not attribute as current', history: [{ actionId, fingerprint: 'server-verified-fingerprint', outcome: 'reviewed', author: identity.name, at, note: original.note }] }, changed.work[1]] });
  harness.request.mockImplementation(async path => path.endsWith('/actions') ? recorded : { items: [], recovery: [] });
  await button(render(), 'Retry original action').props.onClick(); await settle();
  const actions = harness.request.mock.calls.filter(call => call[0].endsWith('/actions'));
  expect(actions[1][1]).toBe(original); expect(JSON.stringify(actions[1][1])).toBe(JSON.stringify(original));
  const markup = html(); expect(markup).not.toContain('The result of your last action is unconfirmed');
  expect(markup).toContain('Changed outside clinic action'); expect(markup).toContain('Original synthetic note');
  expect(markup).not.toContain('Do not attribute as current'); expect(markup).toContain('Review the current answers');
});

it('readback reconciles an earlier action followed by another authenticated action without replay', async () => {
  await boot(); await open(); harness.request.mockRejectedValueOnce(new RequestError('Response lost', 503, 'read-unavailable', true));
  await component(render(), 'StaffActionForm').props.onRecord('medical-work', 'reviewed', 'Earlier synthetic note');
  const next = handoff({ work: [{ ...handoff().work[0], status: 'resolved', history: [
    { actionId, fingerprint: 'authenticated-one', outcome: 'reviewed', author: identity.name, at, note: 'Earlier synthetic note' },
    { actionId: 'later-id', fingerprint: 'authenticated-two', outcome: 'resolved', author: 'Another clinician', at, note: 'Later synthetic note' },
  ] }, handoff().work[1]] });
  harness.request.mockImplementation(async path => path.startsWith('/api/staff/queue') ? { items: [], recovery: [] } : next);
  await button(render(), 'Refresh work queue').props.onClick(); await settle();
  const markup = html(); expect(markup).toContain('Your earlier outcome is confirmed'); expect(markup).toContain('Earlier synthetic note'); expect(markup).toContain('Later synthetic note');
  expect(component(render(), 'StaffActionForm').props.recordedActionId).toBe(actionId);
  expect(harness.request.mock.calls.filter(call => call[0].endsWith('/actions'))).toHaveLength(1);
});

it('preserves source selection through readback and returns focus to its original trigger', async () => {
  await boot(); await open();
  const trigger = { focus: vi.fn() } as unknown as HTMLButtonElement;
  component(render(), 'TopicContent').props.onSource({ topicId: topic.id, title: 'Clinical words', ids: ['source-1'] }, trigger);
  expect(component(render(), 'SourceInspector').props.ids).toEqual(['source-1']);
  harness.request.mockImplementation(async path => path.startsWith('/api/staff/queue') ? { items: [], recovery: [] } : handoff());
  await button(render(), 'Refresh work queue').props.onClick(); await settle();
  expect(component(render(), 'SourceInspector').props.ids).toEqual(['source-1']);
  component(render(), 'SourceInspector').props.onClose();
  expect(trigger.focus).toHaveBeenCalledOnce();
});

it('keeps the editor note and selection across unknown save and refreshed revisions, clearing only after authenticated acknowledgement', async () => {
  const onRecord = vi.fn().mockResolvedValue(false), onDraftChange = vi.fn();
  const props = { handoff: handoff(), identity, disabled: false, onRecord, onDraftChange };
  const editor = (extra: Partial<Parameters<typeof StaffActionForm>[0]> = {}) => {
    harness.active = true; harness.cursor = 0; harness.effects = [];
    const tree = StaffActionForm({ ...props, ...extra }); harness.active = false;
    for (const effect of harness.effects) effect();
    return tree;
  };
  nodes(editor(), node => node.type === 'select' && node.props.id === 'outcome')[0].props.onChange({ target: { value: 'reviewed' } });
  nodes(editor(), node => node.type === 'textarea')[0].props.onChange({ target: { value: 'Keep my synthetic note' } });
  await nodes(editor(), node => node.type === 'form')[0].props.onSubmit({ preventDefault: vi.fn() });
  const refreshed = editor({ disabled: true, handoff: handoff({ work: [{ ...handoff().work[0], revision: 'later-version' }] }) });
  expect(nodes(refreshed, node => node.type === 'textarea')[0].props.value).toBe('Keep my synthetic note');
  expect(nodes(refreshed, node => node.type === 'select' && node.props.id === 'work-item')[0].props.value).toBe('medical-work');
  editor({ recordedActionId: actionId });
  expect(nodes(editor({ recordedActionId: actionId }), node => node.type === 'textarea')[0].props.value).toBe('');
});

it('scope loss clears clinical data and pending requests immediately and ignores late successful readback', async () => {
  await boot(); await open();
  let finish!: (value: StaffHandoffView) => void;
  harness.request.mockImplementation(path => path.startsWith('/api/staff/queue') ? Promise.reject(new RequestError('Scope removed', 403, 'not-authorized', false)) : new Promise(resolve => { finish = resolve; }));
  const refreshing = button(render(), 'Refresh work queue').props.onClick(); await settle();
  expect(html()).toContain('Staff sign in'); expect(html()).not.toContain('Synthetic clinical sentinel');
  finish(handoff()); await refreshing; await settle();
  expect(html()).toContain('Staff sign in'); expect(html()).not.toContain('Synthetic clinical sentinel');
});

it('resume is one explicit scoped pass and refresh is read-only', async () => {
  await boot(); await open();
  harness.request.mockImplementation(async path => path.startsWith('/api/staff/queue') ? { items: [], recovery: [] } : handoff());
  await component(render(), 'StaffDeliverySummary').props.onResume(); await settle();
  expect(harness.request.mock.calls.filter(call => call[0].endsWith('/resume'))).toEqual([['/api/staff/handoffs/confirmed-v1/resume', {}]]);
  await button(render(), 'Refresh work queue').props.onClick(); await settle();
  expect(harness.request.mock.calls.filter(call => call[0].endsWith('/resume'))).toHaveLength(1);
});

it('patient copy completes the same saved version, separates work delivery and retains previous-version outcomes', () => {
  const session: ClinicSessionView = { id: 'session', scenario: 'first-intake', title: 'Intake', persona: { displayName: 'Patient', description: 'Synthetic' }, phase: 'confirmed', revision: 1, savedAt: at, completeness: 'complete', topics: [], turns: [], delivery: { state: 'incomplete', reference: 'stable-reference-v1', version: 1, canRetryDelivery: true, work: handoff().work } };
  const markup = renderToStaticMarkup(createElement(Delivery, { session, uncertain: false, busy: false, onCheck: vi.fn(), onRetry: vi.fn(), onChange: vi.fn() }));
  expect(markup).toContain('Complete delivery of saved answers'); expect(markup).toContain('Already saved parts keep the same reference');
  expect(markup).not.toContain('found no receipt'); expect(markup).not.toContain('Received by Corvo Clinic'); expect(markup).toContain('Work received'); expect(markup).toContain('Work delivery pending');
  const previous = renderToStaticMarkup(createElement(PreviousDelivery, { delivery: { ...session.delivery!, state: 'received', receivedAt: at }, currentState: 'draft', busy: false, checking: false, saveUnconfirmed: false, onCheck: vi.fn() }));
  expect(previous).toContain('Earlier confirmed version 1'); expect(previous).toContain('editing an update that has not been sent'); expect(previous).toContain('stable-reference-v1');
});

describe('action proof and response scope', () => {
  it('never treats status, duplicate IDs, changed note or other scope as authenticated proof', () => {
    const original = freezeStaffAction(handoff(), identity, { actionId, workId: 'medical-work', expectedVersion: 1, expectedWorkVersion: 'opaque-version', outcome: 'reviewed', note: 'Frozen note' });
    expect(Object.isFrozen(original.request)).toBe(true); expect(original.fingerprint).toBe(JSON.stringify(original.request));
    const entry = { actionId, fingerprint: 'authenticated-fingerprint', outcome: 'reviewed', author: identity.name, at, note: 'Frozen note' };
    expect(reconcileStaffAction(original, handoff({ work: [{ ...handoff().work[0], status: 'reviewed' }] }))).toBe('unconfirmed');
    expect(reconcileStaffAction(original, handoff({ work: [{ ...handoff().work[0], history: [entry] }] }))).toBe('recorded');
    for (const history of [[{ ...entry, note: 'Different note' }], [{ ...entry, author: 'Other actor' }], [entry, entry]]) expect(reconcileStaffAction(original, handoff({ work: [{ ...handoff().work[0], history }] }))).toBe('conflict');
    expect(reconcileStaffAction(original, handoff({ id: 'another-version' }))).toBe('conflict');
    const scope = new StaffResponseScope(), old = scope.capture(); scope.invalidate(); expect(scope.accepts(old)).toBe(false); expect(scope.accepts(scope.capture())).toBe(true);
  });
});
