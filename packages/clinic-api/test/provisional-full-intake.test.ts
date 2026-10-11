import { expect, it, vi } from 'vitest';
import { conversation } from '../src/conversation.js';
import { adaptiveSession } from '../src/adaptive-session.js';
import { createFullReplyManifest, prepareFullCapture, fullReplyTargets, type FullReplyDraft, type FullReplyManifest } from '../src/adaptive-reply-full.js';
import { projectProvisional, fullPolicyRevision } from '../src/provisional-projection.js';
import { adaptiveSourceSegments } from '../src/adaptive-source.js';
import { document, readDraft, DRAFT_SYSTEM } from '../src/store.js';
import { ApiFailure, type ClinicApiConfig, type Draft, type StoredDraft } from '../src/types.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
import type { AdaptiveStreamProposer } from '../src/adaptive-stream-session.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import { scenarios } from '../../clinical-core/src/domain.js';
import type { SlotDefinition } from '../../clinic-content/src/index.js';

// Synthetic constructor authority to exercise the qualification gate. This is
// not a real empirical qualification receipt or production activation.
const testQualification = { ...fullPolicyRevision, status: 'qualified' as const, evidenceDigest: 'f'.repeat(64) };
function config(): ClinicApiConfig {
  const patient = { reference: 'Patient/test', displayName: 'Synthetic patient', description: 'Offline fixture', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
  return { mentalHealth: 'phq4', patients: Object.fromEntries(scenarios.map(id => [id, patient])) } as ClinicApiConfig;
}
function fresh(scenario: Draft['scenario'] = 'first-intake'): Draft {
  const now = new Date().toISOString();
  return { schema: 1, id: crypto.randomUUID(), patient: 'Patient/test', scenario, revision: 0, createdAt: now, savedAt: now, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
}
function fixture(scenario: Draft['scenario'], qualified = true, holdFirstTail = false) {
  const content = conversation(config(), qualified ? { provisionalQualification: testQualification } : {});
  let makeDraft: (context: AdaptiveContext, manifest: FullReplyManifest) => FullReplyDraft = () => { throw Error('unconfigured synthetic proposal'); };
  let releaseTail!: () => void, notifyReply!: (draft: Draft) => void;
  const tail = new Promise<void>(resolve => { releaseTail = resolve; }), reply = new Promise<Draft>(resolve => { notifyReply = resolve; });
  const propose = vi.fn<AdaptiveStreamProposer['propose']>(async (context, candidate, options) => {
    if (candidate.protocol !== 'adaptive-reply-full-v2') throw Error('full manifest expected');
    const draft = makeDraft(context, candidate);
    await options.onAdvance({ manifestId: candidate.id, actionId: candidate.actions.filter(action => action.kind !== 'instrument').at(-1)!.id, controls: [], defer: [] });
    if (holdFirstTail && propose.mock.calls.length === 1) await tail;
    return { draft };
  });
  const api = adaptiveSession(content, undefined, { fullCapture: true, streamProposer: { propose }, timeoutMs: 1000, onReplySaved: notifyReply });
  const initial = api.initialize(fresh(scenario));
  let stored: StoredDraft = { draft: initial, versionId: '1', resource: { ...document(DRAFT_SYSTEM, initial.id, initial.patient, initial), id: 'offline-record', meta: { versionId: '1' } } };
  const client = { request: async () => ({ body: { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: structuredClone(stored.resource) }] } }) } as unknown as MedplumClient;
  const store = { read: () => readDraft(client, initial.id, initial.patient), save: async (previous: StoredDraft, next: Draft) => {
    if (previous.versionId !== stored.versionId) throw new ApiFailure('stale-session', 409);
    const versionId = String(Number(stored.versionId) + 1);
    stored = { draft: structuredClone(next), versionId, resource: { ...document(DRAFT_SYSTEM, initial.id, initial.patient, next), id: 'offline-record', meta: { versionId } } };
    return readDraft(client, initial.id, initial.patient);
  } };
  const send = async (text: string, build: typeof makeDraft) => { makeDraft = build; const accepted = await api.accept(store, { requestId: crypto.randomUUID(), expectedRevision: stored.draft.revision, text, channel: 'text' }); return api.interpret(store, accepted.operation.id); };
  const configure = (build: typeof makeDraft) => { makeDraft = build; };
  const accept = (text: string) => api.accept(store, { requestId: crypto.randomUUID(), expectedRevision: stored.draft.revision, text, channel: 'text' });
  return { content, api, store, send, propose, configure, accept, releaseTail, reply };
}
function blank(manifest: FullReplyManifest): FullReplyDraft { return { manifestId: manifest.id, claims: [], items: [], closures: [], acts: [], residual: [], sourceDisposition: 'represented' }; }
function address(context: AdaptiveContext, quote: string) {
  const segment = adaptiveSourceSegments(context).find(segment => segment.kind === 'sentence' && segment.text.includes(quote));
  if (!segment) throw Error(`fixture quote missing: ${quote}`);
  return { statementId: segment.id, quote };
}
function known(context: AdaptiveContext, manifest: FullReplyManifest, topicId: string, path: string, value: string | number, quote: string, itemKey: string | null = null, correctsSourceIds: string[] = []) {
  const target = manifest.targets.find(target => target.topicId === topicId && target.path === path);
  if (!target) throw Error(`fixture target missing: ${topicId}:${path}`);
  const ev = address(context, quote);
  return { targetId: target.id, itemKey, state: 'known' as const, value, valueEvidence: ev, evidence: [ev], scope: { subject: 'patient' as const, entity: null, period: null, predicate: ev }, correctsSourceIds };
}
const valueFor = (slot: SlotDefinition): string | number => {
  if (slot.id === 'serviceDate' || slot.id === 'requestedDate') return '2026-10-12';
  if (slot.id === 'height.value') return 170;
  if (slot.id === 'height.unit') return 'cm';
  if (slot.id === 'lastMeasuredWeight.value') return 80;
  if (slot.id === 'lastMeasuredWeight.unit' || slot.id === 'currentWeightEstimate.unit') return 'kg';
  if (slot.id === 'lastMeasuredWeight.measuredWhen') return 'August 12';
  if (slot.id === 'lastMeasuredWeight.datePrecision') return 'exact';
  if (slot.id === 'lastMeasuredWeight.representsCurrent') return 'true';
  if (slot.kind === 'positive-number') return 1;
  if (slot.kind === 'choice') return String(slot.choices![0]);
  return ({ reason: 'I want help with my health', priority: 'Walking comfortably', childhood: 'Steady growth as a child', teenage: 'Gained weight as a teenager', afterSchool: 'Weight increased after school', lastFiveYears: 'Weight has been stable for five years', past18Months: 'Stable over the past eighteen months', day: 'Yesterday', time: 'Breakfast at eight', foods: 'Two slices of toast', foodAmounts: 'Two slices', drinks: 'Water', drinkAmounts: 'One cup', drinkAdditions: 'Nothing added', otherIntake: 'An apple at night', typicality: 'This was a usual day', name: 'Vitamin C', strength: '100 mg', labelDirections: 'One tablet daily', actualUse: 'One tablet daily', concern: 'Knee discomfort', help: 'Please contact me', appointmentContext: 'Please check my appointment record', planContext: 'Please review the authored plan in my record', reference: 'Invoice A42', pharmacy: 'The pharmacy on Main Street', remaining: 'Seven tablets', medicine: 'Vitamin C' } as Record<string, string>)[slot.id] ?? 'No current difficulty';
};
function topicFixture(topic: { id: string; slots: readonly SlotDefinition[] }) {
  const entries: { path: string; value?: string | number; state: 'known' | 'negative'; itemKey: string | null; quote: string }[] = [];
  const lists: { path: string; key: string; entity: string; quote: string }[] = [];
  for (const slot of topic.slots) {
    if (slot.optional || slot.kind === 'configuration' || /^MH0[1-4]$/.test(slot.id) || slot.id === 'currentWeightEstimate.statedAt' || slot.id.startsWith('currentWeightEstimate.')) continue;
    if (slot.when && (slot.when.condition === 'uncertain' || topic.slots.find(anchor => anchor.id === slot.when!.slotId)?.kind === 'presence')) continue;
    if (slot.kind === 'presence') { const quote = `${slot.label}: none`; entries.push({ path: slot.id, state: 'negative', itemKey: null, quote }); continue; }
    if (slot.kind === 'collection') {
      if (slot.acceptsNegative && !['medicines', 'occasions'].includes(slot.id)) { entries.push({ path: slot.id, state: 'negative', itemKey: null, quote: `${slot.label}: none` }); continue; }
      const key = `item${lists.length}`, entity = slot.id === 'medicines' ? 'Vitamin C' : 'Breakfast';
      lists.push({ path: slot.id, key, entity, quote: `This is everything in my ${slot.label} list` });
      for (const field of slot.fields ?? []) { const value = valueFor(field); entries.push({ path: `${slot.id}[new].${field.id}`, value, state: 'known', itemKey: key, quote: `${field.label}: ${value}` }); }
      continue;
    }
    const value = valueFor(slot); entries.push({ path: slot.id, value, state: 'known', itemKey: null, quote: `${slot.label}: ${value}` });
  }
  const text = [...entries.map(entry => entry.quote), ...lists.map(list => list.quote)].join('\n');
  return { text, build: (context: AdaptiveContext, manifest: FullReplyManifest) => {
    const result = blank(manifest);
    result.claims = entries.map(entry => entry.state === 'known' ? known(context, manifest, topic.id, entry.path, entry.value!, entry.quote, entry.itemKey) : {
      ...known(context, manifest, topic.id, entry.path, 'none', entry.quote), state: 'negative', value: null, valueEvidence: null,
    });
    result.items = lists.map(list => ({ collectionId: manifest.targets.find(target => target.topicId === topic.id && target.path === list.path)!.id, key: list.key, entity: list.entity, evidence: [address(context, list.quote)] }));
    result.closures = lists.map(list => ({ collectionId: manifest.targets.find(target => target.topicId === topic.id && target.path === list.path)!.id, evidence: [address(context, list.quote)] }));
    return result;
  } };
}

it.each(scenarios)('%s projects sufficient self-report into one frozen review/handoff without changing a spoken early question', async scenario => {
  const f = fixture(scenario);
  // First intake PHQ is four direct exact choices, never model extraction.
  if (scenario === 'first-intake') {
    const before = await f.store.read(), sourceId = crypto.randomUUID(), at = new Date().toISOString();
    const draft = structuredClone(before.draft); draft.turns.push({ id: sourceId, role: 'patient', text: 'Exact PHQ option: Not at all for each displayed item', at, channel: 'text' });
    draft.topics.Q16 = { presented: true, answers: Object.fromEntries(['MH01', 'MH02', 'MH03', 'MH04'].map(id => [id, { state: 'known', value: 0, sourceIds: [sourceId] }])) };
    await f.store.save(before, { ...draft, revision: draft.revision + 1 });
  }
  const definitions = f.content.definitions((await f.store.read()).draft).filter(topic => topic.presentation !== 'O');
  for (const topic of definitions) { const synthetic = topicFixture(topic); const result = await f.send(synthetic.text, synthetic.build); expect(result.operation.status).toBe('applied'); }
  const saved = (await f.store.read()).draft, view = f.content.view(saved, true, true), exchange = structuredClone(saved.adaptive!.exchange);
  expect(view.completeness).toBe('complete');
  expect(view.topics.some(topic => topic.id.startsWith('provisional:'))).toBe(false);
  const preview = await f.content.preview(saved); expect(preview.confirmation.submission.completeness).toBe('complete');
  expect(preview.confirmation.submission.sources.length).toBeGreaterThan(0);
  expect(preview.confirmation.submission.answers.some(answer => answer.text?.includes('Proposed patient report'))).toBe(true);
  expect(saved.adaptive!.exchange).toEqual(exchange);
  const review = { ...saved, phase: 'review' as const, preview }; const final = await f.content.finalize(review);
  expect(final.topics).toEqual(preview.topics); expect(final.previewDigest).toBe(preview.digest);
  if (scenario === 'first-intake') expect(view.topics.find(topic => topic.id === 'Q16')!.screening?.scores).toEqual({ gad2: 0, phq2: 0, phq4: 0 });
});

it.each(scenarios)('%s preserves partial unknown source and allows explicit Stop/review recovery without retry', async scenario => {
  const f = fixture(scenario);
  const result = await f.send("I don't know, and I'd rather move on.", (context, manifest) => {
    // A new-item target requires its own item key; this partial-unknown probe uses a scalar text target.
    const draft = blank(manifest), target = manifest.targets.find(target => target.kind === 'text' && !target.newItem)!, ev = address(context, context.source.text);
    draft.claims = [{ targetId: target.id, itemKey: null, state: 'unknown', value: null, valueEvidence: null, evidence: [ev], scope: { subject: 'patient', entity: null, period: null, predicate: ev }, correctsSourceIds: [] }];
    draft.acts = [{ kind: 'move-on', targetTopicId: target.topicId, replyId: null, evidence: [ev] }]; return draft;
  });
  expect(result.operation.status).toBe('applied'); expect(f.propose).toHaveBeenCalledTimes(1);
  expect((await f.api.interpret(f.store, result.operation.id)).operation.status).toBe('applied'); expect(f.propose).toHaveBeenCalledTimes(1);
  const preview = await f.content.preview((await f.store.read()).draft); expect(preview.confirmation.submission.completeness).toBe('partial');
  expect(preview.confirmation.submission.sources.at(-1)!.text).toBe("I don't know, and I'd rather move on.");
  const topic = preview.topics.find(topic => topic.details?.some(detail => detail.state === 'unknown')); expect(topic).toBeTruthy();
});

it('unqualified proposals display in their clinical section but earn no readiness or branch credit; narrative PHQ cannot enter the schema', async () => {
  const f = fixture('first-intake', false);
  await f.send('I have diabetes.', (context, manifest) => { const result = blank(manifest); result.claims = [known(context, manifest, 'Q06', 'conditions.diabetes', 'true', context.source.text)]; return result; });
  const saved = (await f.store.read()).draft;
  expect(f.content.view(saved, true, true).topics.find(topic => topic.id === 'Q06')!.details!.find(detail => detail.id === 'conditions.diabetes')).toMatchObject({ state: 'answered', interpretation: { qualified: false } });
  expect(f.content.definitions(saved).some(topic => topic.id === 'DM')).toBe(false);
  expect(f.content.effective(saved, true).responses.Q06).toBeUndefined();
  const source = saved.turns.find(turn => turn.role === 'patient')!, ctx: AdaptiveContext = { binding: saved.adaptive!.operations[saved.adaptive!.activeOperationId!].binding, source, sources: saved.turns.filter(turn => turn.role === 'patient'), topics: f.content.captureDefinitions(saved), responses: saved.topics };
  expect(fullReplyTargets(ctx).some(target => /^MH0[1-4]$/.test(target.path))).toBe(false);
  expect(f.content.view(saved).topics.find(topic => topic.id === 'Q16')!.screening?.status).toBe('incomplete');
  expect((await f.content.preview(saved)).confirmation.submission.completeness).toBe('partial');
});

it('qualified positive condition activates DM, uncertainty does not, and word-number interpretation remains provisional self-report', async () => {
  const f = fixture('first-intake');
  await f.send('I have diabetes. I weigh eighty kilograms.', (context, manifest) => { const result = blank(manifest); result.claims = [known(context, manifest, 'Q06', 'conditions.diabetes', 'true', 'I have diabetes.'), known(context, manifest, 'Q04', 'lastMeasuredWeight.value', 80, 'I weigh eighty kilograms.'), known(context, manifest, 'Q04', 'lastMeasuredWeight.unit', 'kg', 'I weigh eighty kilograms.')]; return result; });
  const saved = (await f.store.read()).draft;
  expect(f.content.definitions(saved).some(topic => topic.id === 'DM')).toBe(true);
  expect(f.content.effective(saved).claims.find(claim => claim.path === 'lastMeasuredWeight.value')!.fidelity).toBe('model-interpreted');
  const other = fixture('first-intake'); await other.send("I'm not sure I have diabetes.", (context, manifest) => { const result = blank(manifest), target = manifest.targets.find(target => target.path === 'conditions.diabetes')!, ev = address(context, context.source.text); result.claims = [{ targetId: target.id, itemKey: null, state: 'uncertain', value: null, valueEvidence: null, evidence: [ev], scope: { subject: 'patient', entity: null, period: null, predicate: ev }, correctsSourceIds: [] }]; return result; });
  expect(other.content.definitions((await other.store.read()).draft).some(topic => topic.id === 'DM')).toBe(false);
});

it('unlinked changed values conflict, explicit source-linked correction supersedes, and direct correction wins without laundering other fields', async () => {
  const f = fixture('non-visit');
  const first = await f.send('I want help with walking.', (context, manifest) => { const draft = blank(manifest); draft.claims = [known(context, manifest, 'W03', 'help', 'walking', context.source.text)]; return draft; });
  await f.send('I want help with sleeping.', (context, manifest) => { const draft = blank(manifest); draft.claims = [known(context, manifest, 'W03', 'help', 'sleeping', context.source.text)]; return draft; });
  let saved = (await f.store.read()).draft; expect(f.content.effective(saved).responses.W03.answers.help!.state).toBe('conflicting');
  const beforeSources = saved.turns.filter(turn => turn.role === 'patient').map(turn => turn.id);
  await f.send('Correction: I want help with eating.', (context, manifest) => { const draft = blank(manifest); draft.claims = [known(context, manifest, 'W03', 'help', 'eating', context.source.text, null, beforeSources)]; return draft; });
  saved = (await f.store.read()).draft; expect(f.content.effective(saved).responses.W03.answers.help).toMatchObject({ state: 'known', value: 'eating' });
  const selected = f.content.select(saved, 'W03', 'help'); const corrected = f.content.turn(selected, { requestId: crypto.randomUUID(), expectedRevision: selected.revision, promptId: 'W03:help', action: 'answer', text: 'Please contact me about transport', channel: 'text' });
  expect(f.content.effective(corrected).responses.W03.answers.help).toMatchObject({ state: 'known', value: 'Please contact me about transport' });
  expect(corrected.turns.at(-1)!.corrects).toBeTruthy(); expect(corrected.turns.some(turn => turn.id === first.operation.sourceId)).toBe(true);
});

it('server-stable list items stay open without closure, expose coordinated unknown fields, and direct nested edits retain unrelated proposals', async () => {
  const f = fixture('first-intake'), source = 'At breakfast I had toast and coffee. I do not know the amounts of either.';
  const result = await f.send(source, (context, manifest) => {
    const draft = blank(manifest), collection = manifest.targets.find(target => target.topicId === 'Q11' && target.path === 'occasions')!, ev = address(context, 'At breakfast I had toast and coffee.');
    draft.items = [{ collectionId: collection.id, key: 'breakfast', entity: 'Breakfast', evidence: [ev] }];
    draft.claims = [known(context, manifest, 'Q11', 'occasions[new].foods', 'toast', 'At breakfast I had toast and coffee.', 'breakfast'), known(context, manifest, 'Q11', 'occasions[new].drinks', 'coffee', 'At breakfast I had toast and coffee.', 'breakfast')];
    for (const path of ['foodAmounts', 'drinkAmounts']) draft.claims.push({ ...known(context, manifest, 'Q11', `occasions[new].${path}`, 'unused', 'I do not know the amounts of either.', 'breakfast'), state: 'unknown', value: null, valueEvidence: null }); return draft;
  });
  const saved = (await f.store.read()).draft, projected = f.content.effective(saved), list = projected.responses.Q11.answers.occasions!;
  expect(list).toMatchObject({ state: 'known', complete: false }); if (list.state !== 'known' || !list.items) throw Error('list fixture');
  const item = list.items[0]; expect(item.id).toMatch(/^p[a-f0-9]{24}$/); expect(item.answers.foodAmounts!.state).toBe('unknown'); expect(item.answers.drinkAmounts!.state).toBe('unknown');
  const capture = saved.adaptive!.operations[result.operation.id].stream!.provisional!;
  expect(capture.items![0].id).toBe(item.id);
  const selected = f.content.select(saved, 'Q11', `occasions[${item.id}].foodAmounts`);
  const corrected = f.content.turn(selected, { requestId: crypto.randomUUID(), expectedRevision: selected.revision, promptId: `Q11:occasions[${item.id}].foodAmounts`, action: 'answer', text: 'Two slices', channel: 'text' });
  const after = f.content.effective(corrected).responses.Q11.answers.occasions!; if (after.state !== 'known' || !after.items) throw Error('list correction fixture');
  expect(after.items[0].answers.foodAmounts).toMatchObject({ state: 'known', value: 'Two slices' }); expect(after.items[0].answers.drinks).toMatchObject({ state: 'known', value: 'coffee' });
});

it('wrong subject and cropped temporal value stay rejected in the sole review even after final confirmation', async () => {
  const f = fixture('first-intake');
  await f.send('My mother weighs 80 kg. My last weight was measured August 12.', (context, manifest) => {
    const draft = blank(manifest), wrong = known(context, manifest, 'Q04', 'lastMeasuredWeight.value', 80, 'My mother weighs 80 kg.'); wrong.scope.subject = 'other' as any;
    draft.claims = [wrong, known(context, manifest, 'Q04', 'lastMeasuredWeight.measuredWhen', '12', 'My last weight was measured August 12.')]; return draft;
  });
  const saved = (await f.store.read()).draft, preview = await f.content.preview(saved);
  expect(preview.confirmation.submission.completeness).toBe('partial');
  expect(preview.topics.find(topic => topic.id === 'interpretation')!.interpretationGaps!.map(gap => gap.reason)).toEqual(expect.arrayContaining(['ownership', 'temporal-crop']));
  const final = await f.content.finalize({ ...saved, phase: 'review', preview }); expect(final.topics).toEqual(preview.topics);
  expect(final.confirmation.submission.answers.find(answer => answer.questionId === 'Q04')!.text ?? '').not.toContain('80');
});

it('full queued admission reads back and its first dispatch can use predecessor projected metadata without stale binding or replay', async () => {
  const f = fixture('non-visit', true, true);
  f.configure((context, manifest) => { const draft = blank(manifest); draft.claims = [known(context, manifest, 'W03', 'help', 'walking', context.source.text)]; return draft; });
  const parent = await f.accept('I want help with walking.'), running = f.api.interpret(f.store, parent.operation.id); await f.reply;
  const child = await f.accept('The update started last week.'); expect(child.operation.queuedWaiting).toBe(true);
  expect((await f.api.interpret(f.store, child.operation.id)).operation.status).toBe('accepted'); expect(f.propose).toHaveBeenCalledTimes(1);
  f.releaseTail(); await running;
  const ready = await f.store.read(); expect(ready.draft.adaptive!.operations[child.operation.id].queuedWaiting).toBe(false);
  f.configure((context, manifest) => { const draft = blank(manifest); expect(context.responses.W03?.answers.help).toMatchObject({ state: 'known', value: 'walking' }); draft.claims = [known(context, manifest, 'W03', 'timing', 'last week', context.source.text)]; return draft; });
  const result = await f.api.interpret(f.store, child.operation.id); expect(result.operation.status).toBe('applied');
  expect(f.propose).toHaveBeenCalledTimes(2); expect((await f.api.interpret(f.store, child.operation.id)).operation.status).toBe('applied'); expect(f.propose).toHaveBeenCalledTimes(2);
  expect((await f.store.read()).draft.turns.filter(turn => turn.role === 'patient').map(turn => turn.text)).toEqual(['I want help with walking.', 'The update started last week.']);
});

it('direct correction during full pending tail wins and tail cannot replace the already saved question or direct generation', async () => {
  const f = fixture('non-visit', true, true);
  f.configure((context, manifest) => { const draft = blank(manifest); draft.claims = [known(context, manifest, 'W03', 'help', 'walking', context.source.text)]; return draft; });
  const parent = await f.accept('I want help with walking.'), running = f.api.interpret(f.store, parent.operation.id); await f.reply;
  const before = await f.store.read(), selected = f.content.select(before.draft, 'W03', 'help');
  const edited = f.content.turn(selected, { requestId: crypto.randomUUID(), expectedRevision: selected.revision, promptId: 'W03:help', action: 'answer', text: 'Please arrange transport', channel: 'text' });
  edited.adaptive!.targetGenerations = { ...edited.adaptive!.targetGenerations, 'W03:help': 1 };
  const exchange = structuredClone(edited.adaptive!.exchange); await f.store.save(before, { ...edited, revision: before.draft.revision + 1 });
  f.releaseTail(); await running; const saved = (await f.store.read()).draft;
  expect(saved.adaptive!.exchange).toEqual(exchange); expect(saved.adaptive!.targetGenerations!['W03:help']).toBe(1);
  expect(f.content.effective(saved).responses.W03.answers.help).toMatchObject({ state: 'known', value: 'Please arrange transport' });
  expect(saved.adaptive!.operations[parent.operation.id].stream!.provisional!.claims[0].status).toBe('superseded');
});

it('unqualified existing collection item can receive a linked natural correction without gaining readiness, and adding another item reopens a prior closed list', async () => {
  const f = fixture('first-intake', false);
  const makeMedicine = (name: string, close: boolean) => (context: AdaptiveContext, manifest: FullReplyManifest) => {
    const draft = blank(manifest), ev = address(context, context.source.text), collectionId = manifest.targets.find(target => target.topicId === 'Q08' && target.path === 'medicines')!.id;
    draft.items = [{ collectionId, key: 'medicine', entity: name, evidence: [ev] }]; draft.claims = [known(context, manifest, 'Q08', 'medicines[new].name', name, context.source.text, 'medicine')];
    if (close) draft.closures = [{ collectionId, evidence: [ev] }]; return draft;
  };
  const first = await f.send('I take Vitamin C and this is my whole list.', makeMedicine('Vitamin C', true));
  let saved = (await f.store.read()).draft, list = f.content.effective(saved).responses.Q08.answers.medicines!;
  if (list.state !== 'known' || !list.items) throw Error('medicine list'); const itemId = list.items[0].id; expect(list.complete).toBe(true);
  await f.send('Correction: the name is Vitamin D.', (context, manifest) => { const draft = blank(manifest); draft.claims = [known(context, manifest, 'Q08', `medicines[${itemId}].name`, 'Vitamin D', context.source.text, null, [first.operation.sourceId])]; return draft; });
  saved = (await f.store.read()).draft; list = f.content.effective(saved).responses.Q08.answers.medicines!;
  if (list.state !== 'known' || !list.items) throw Error('corrected list'); expect(list.items[0].answers.name).toMatchObject({ state: 'known', value: 'Vitamin D' });
  expect(f.content.effective(saved, true).responses.Q08).toBeUndefined();
  const detail = f.content.view(saved).topics.find(topic => topic.id === 'Q08')!.details!.find(detail => detail.id === `medicines[${itemId}].name`)!;
  expect(detail.sourceIds).toContain(first.operation.sourceId); expect(detail.provenance!.some(span => span.transform === 'superseded-patient-report')).toBe(true);
  await f.send('I also take Zinc.', makeMedicine('Zinc', false));
  list = f.content.effective((await f.store.read()).draft).responses.Q08.answers.medicines!; expect(list).toMatchObject({ state: 'known', complete: false });
  if (list.state !== 'known' || !list.items) throw Error('reopened list'); expect(list.items).toHaveLength(2);
});

it('exact PHQ direct choices are the only scoring path and missing/declined choices are never filled by model or zero', () => {
  const content = conversation(config(), { provisionalQualification: testQualification }); let draft = fresh();
  for (const [index, id] of ['MH01', 'MH02', 'MH03', 'MH04'].entries()) {
    draft = content.select(draft, 'Q16', id);
    expect(content.view(draft).currentPrompt!.choices!.map(choice => choice.label)).toEqual(['Not at all', 'Several days', 'More than half the days', 'Nearly every day']);
    expect(() => content.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: `Q16:${id}`, action: 'answer', text: String(index), channel: 'confirmed-transcript' })).toThrow('explicit-screening-choice-required');
    draft = content.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: `Q16:${id}`, action: 'answer', text: String(index), channel: 'text' });
    const screen = content.view(draft).topics.find(topic => topic.id === 'Q16')!.screening!;
    expect(screen.status).toBe(index === 3 ? 'complete' : 'incomplete'); if (index < 3) expect(screen.scores).toBeNull();
  }
  expect(content.view(draft).topics.find(topic => topic.id === 'Q16')!.screening).toMatchObject({ scores: { gad2: 1, phq2: 5, phq4: 6 }, furtherAssessmentRequested: true, clinicianReviewRequired: true });
  draft = content.select(draft, 'Q16', 'MH04'); draft = content.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: 'Q16:MH04', action: 'decline', channel: 'text' });
  expect(content.view(draft).topics.find(topic => topic.id === 'Q16')!.screening!.scores).toBeNull();
});

it('full capture retains the existing per-operation storage budget and readable capacity gap rather than oversized claims', async () => {
  const f = fixture('first-intake'), phrase = 'x'.repeat(2000);
  const result = await f.send(phrase, (context, manifest) => {
    const draft = blank(manifest), targets = manifest.targets.filter(target => target.kind === 'text' && !target.collection).slice(0, 32);
    draft.claims = targets.map(target => known(context, manifest, target.topicId, target.path, phrase, phrase)); return draft;
  });
  expect(result.operation).toMatchObject({ status: 'failed', errorCode: 'provisional-capacity', stream: { capture: 'partial' } });
  const saved = (await f.store.read()).draft, capture = saved.adaptive!.operations[result.operation.id].stream!.provisional!;
  expect(capture.claims).toEqual([]); expect(capture.gaps[0].reason).toBe('capacity'); expect(JSON.stringify(capture).length).toBeLessThan(32768);
  expect(saved.turns.find(turn => turn.id === result.operation.sourceId)!.text).toBe(phrase);
  const preview = await f.content.preview(saved); expect(preview.confirmation.submission.completeness).toBe('partial');
  expect(preview.topics.find(topic => topic.id === 'interpretation')!.interpretationGaps!.some(gap => gap.reason === 'capacity')).toBe(true);
});

it('scenario-wide catalog is measured, excludes instruments, and refuses excessive existing items before any provider dispatch', () => {
  const content = conversation(config()), counts: Record<string, number> = {};
  for (const scenario of scenarios) {
    const draft = fresh(scenario), source = { id: crypto.randomUUID(), role: 'patient' as const, text: 'A synthetic update.', at: draft.savedAt };
    const ctx: AdaptiveContext = { binding: { operationId: crypto.randomUUID(), sessionId: draft.id, patient: draft.patient, scenario, revision: 1, contentVersion: 'CC-0.2', snapshotDigest: 'f'.repeat(64) }, source, sources: [source], topics: content.captureDefinitions(draft), responses: {} };
    counts[scenario] = fullReplyTargets(ctx).length; expect(counts[scenario]).toBeLessThan(1024);
    expect(() => createFullReplyManifest(ctx)).not.toThrow();
    if (scenario === 'first-intake') {
      expect(counts[scenario]).toBeGreaterThan(64);
      const oversized = { ...ctx, captureResponses: { Q08: { presented: true, answers: { medicines: { state: 'known' as const, sourceIds: [source.id], complete: false, items: Array.from({ length: 33 }, (_, index) => ({ id: `i${index}`, answers: {} })) } } } } };
      expect(() => createFullReplyManifest(oversized)).toThrow('full-reply-item-context-capacity');
    }
  }
  // Exact measured baseline is pinned after the first run, below the declared
  // upper budget; exceeding it is a failed context, never target truncation.
  // Re-pinned 2026-10-11: the scenario catalog legitimately grew. The first-intake
  // delta (+16) matches the growth of the G7 domain catalog measured in
  // DO-AF37-PREFLIGHT.json (66+38 -> 79+41 fields), so this is content growth, not truncation.
  expect(counts).toEqual({ 'first-intake': 131, 'pre-visit': 24, 'non-visit': 57, 'post-visit': 22, billing: 9, scheduling: 16, refill: 20 });
});
