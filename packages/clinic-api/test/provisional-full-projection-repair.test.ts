import { expect, it } from 'vitest';
import { createClinicContent, evaluateTopic } from '../../clinic-content/src/index.js';
import { conversation } from '../src/conversation.js';
import { projectProvisional } from '../src/provisional-projection.js';
import { fullProvisionalPolicy, type ProvisionalCapture, type ProvisionalClaim } from '../src/provisional-draft.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';

// Author repaired expectations. The independent probes remain unchanged.
// No provider, holdout, emitted build or qualification authority is used.
const topic = createClinicContent({ mentalHealth: 'phq4' }).topics.find(item => item.id === 'Q08')!;
const span = (sourceId: string, text: string) => ({ sourceId, start: 0, end: text.length });
function draft(): Draft {
  const at = new Date().toISOString();
  return { schema: 1, id: crypto.randomUUID(), patient: 'Patient/test', scenario: 'first-intake', revision: 10,
    createdAt: at, savedAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1,
    adaptive: { mode: 'adaptive', operations: {} } };
}
function append(d: Draft, text: string, revision: number, make: (sourceId: string) => Partial<ProvisionalCapture>) {
  const sourceId = crypto.randomUUID(), operationId = crypto.randomUUID(), at = new Date(Date.now() + revision).toISOString();
  d.turns.push({ id: sourceId, role: 'patient', text, at, channel: 'text' });
  const capture: ProvisionalCapture = { sourceId, policy: fullProvisionalPolicy, claims: [], gaps: [],
    accounting: { addressed: [span(sourceId, text)], remaining: [], semanticReview: 'qualification-required' }, ...make(sourceId) };
  d.adaptive!.operations[operationId] = { id: operationId, requestId: crypto.randomUUID(), sourceId, fingerprint: 'offline', status: 'applied',
    acceptedAt: at, updatedAt: at, binding: { operationId, sessionId: d.id, patient: d.patient, scenario: d.scenario,
      revision, contentVersion: 'offline', snapshotDigest: 'a'.repeat(64) }, attemptId: crypto.randomUUID(), resultDigest: 'b'.repeat(64),
    stream: { protocol: 'durable-provisional-stream-v1', reply: 'withheld', capture: 'saved', targetGenerations: {}, provisional: capture } };
  return sourceId;
}
function claim(sourceId: string, text: string, path: string, state: ProvisionalClaim['state'], value: string | null): ProvisionalClaim {
  const ev = span(sourceId, text);
  return { id: crypto.randomUUID(), topicId: 'Q08', path, sourceId, state, value, evidence: [ev], valueEvidence: value === null ? null : ev,
    scope: { subject: 'patient', entity: null, period: null, predicate: ev }, correctsSourceIds: [], attribution: 'proposed-patient-report',
    policy: fullProvisionalPolicy, status: 'proposed', fidelity: 'literal-supported' };
}
function medicine(d: Draft, revision: number, closed = false) {
  const text = closed ? 'I take Vitamin C. That is all.' : 'I take Vitamin C.';
  return append(d, text, revision, sourceId => ({ claims: [claim(sourceId, text, 'medicines[vitc].name', 'known', 'Vitamin C')],
    items: [{ topicId: 'Q08', collection: 'medicines', id: 'vitc', entity: 'Vitamin C', evidence: [span(sourceId, text)] }],
    closures: closed ? [{ topicId: 'Q08', collection: 'medicines', evidence: [span(sourceId, text)] }] : [] }));
}
function none(d: Draft, revision: number) {
  const text = 'I take no medicines or supplements.';
  return append(d, text, revision, sourceId => ({ claims: [claim(sourceId, text, 'medicines', 'negative', null)] }));
}

it('keeps an unlinked later none-list report conflicting with an earlier medicine item', () => {
  const d = draft(), positive = medicine(d, 1), negative = none(d, 2);
  const p = projectProvisional(d, [topic], { qualified: true });
  expect(p.responses.Q08.answers.medicines?.state).toBe('conflicting');
  expect(p.gaps.some(gap => gap.reason === 'conflict' && gap.evidence.some(ev => ev.sourceId === positive))).toBe(true);
  expect(p.gaps.some(gap => gap.reason === 'conflict' && gap.evidence.some(ev => ev.sourceId === negative))).toBe(true);
  expect(p.claims.every(claim => claim.status === 'conflicting')).toBe(true);
  expect(p.provenance.some(row => row.path === 'medicines' && row.sourceIds.includes(positive) && row.sourceIds.includes(negative))).toBe(true);
  expect(evaluateTopic(topic, p.responses.Q08, { validSourceIds: new Set([positive, negative]) }).sufficient).toBe(false);
  expect(p.creditedSourceIds.has(positive) || p.creditedSourceIds.has(negative)).toBe(false);
});

it('keeps a later item report conflicting with an earlier unlinked none-list report', () => {
  const d = draft(), negative = none(d, 1), positive = medicine(d, 2);
  const p = projectProvisional(d, [topic], { qualified: true });
  expect(p.responses.Q08.answers.medicines?.state).toBe('conflicting');
  expect(p.gaps.some(gap => gap.reason === 'conflict' && gap.evidence.some(ev => ev.sourceId === positive))).toBe(true);
  expect(p.gaps.some(gap => gap.reason === 'conflict' && gap.evidence.some(ev => ev.sourceId === negative))).toBe(true);
  expect(p.claims.every(claim => claim.status === 'conflicting')).toBe(true);
  expect(p.provenance.some(row => row.path === 'medicines' && row.sourceIds.includes(positive) && row.sourceIds.includes(negative))).toBe(true);
  expect(evaluateTopic(topic, p.responses.Q08, { validSourceIds: new Set([positive, negative]) }).sufficient).toBe(false);
  expect(p.creditedSourceIds.has(negative) || p.creditedSourceIds.has(positive)).toBe(false);
});

it('does not replay an old provisional closure over a later directly reopened list', () => {
  let d = draft(); medicine(d, 1, true);
  const before = projectProvisional(d, [topic]).responses.Q08;
  expect(before.answers.medicines?.complete).toBe(true);
  const content = conversation({ mentalHealth: 'phq4', patients: { 'first-intake': { reference: 'Patient/test', displayName: 'Synthetic patient', description: 'Offline', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } } } } as ClinicApiConfig);
  d = content.turn(content.select(d, 'Q08', 'medicines'), { expectedRevision: d.revision, promptId: 'Q08:medicines', action: 'answer', text: '__add', channel: 'text' });
  expect(d.topics.Q08.answers.medicines?.complete).toBe(false);
  const p = projectProvisional(d, [topic]);
  expect(p.responses.Q08.answers.medicines?.complete).toBe(false);
});


it('allows an explicit direct re-close after direct reopen, retaining the earlier item source', () => {
  let d = draft(); const original = medicine(d, 1, true);
  const content = conversation({ mentalHealth: 'phq4', patients: { 'first-intake': { reference: 'Patient/test', displayName: 'Synthetic patient', description: 'Offline', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } } } } as ClinicApiConfig);
  d = content.turn(content.select(d, 'Q08', 'medicines'), { expectedRevision: d.revision, promptId: 'Q08:medicines', action: 'answer', text: '__add', channel: 'text' });
  expect(projectProvisional(d, [topic]).responses.Q08.answers.medicines?.complete).toBe(false);
  d = content.turn(content.select(d, 'Q08', 'medicines'), { expectedRevision: d.revision, promptId: 'Q08:medicines', action: 'answer', text: '__done', channel: 'text' });
  const p = projectProvisional(d, [topic]);
  expect(p.responses.Q08.answers.medicines?.complete).toBe(true);
  expect(p.responses.Q08.answers.medicines?.items?.some(item => item.id === 'vitc')).toBe(true);
  expect(p.provenance.some(row => row.path === 'medicines[vitc].name' && row.sourceIds.includes(original))).toBe(true);
});

it('permits a newer explicit provisional closure after a direct reopen', () => {
  let d = draft(); medicine(d, 1, true);
  const content = conversation({ mentalHealth: 'phq4', patients: { 'first-intake': { reference: 'Patient/test', displayName: 'Synthetic patient', description: 'Offline', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } } } } as ClinicApiConfig);
  d = content.turn(content.select(d, 'Q08', 'medicines'), { expectedRevision: d.revision, promptId: 'Q08:medicines', action: 'answer', text: '__add', channel: 'text' });
  append(d, 'That is the complete list now.', 20, sourceId => ({ closures: [{ topicId: 'Q08', collection: 'medicines', evidence: [span(sourceId, 'That is the complete list now.')] }] }));
  expect(projectProvisional(d, [topic]).responses.Q08.answers.medicines?.complete).toBe(true);
});

it('a genuinely later item reopens even a directly re-closed list', () => {
  let d = draft(); medicine(d, 1, true);
  const content = conversation({ mentalHealth: 'phq4', patients: { 'first-intake': { reference: 'Patient/test', displayName: 'Synthetic patient', description: 'Offline', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } } } } as ClinicApiConfig);
  d = content.turn(content.select(d, 'Q08', 'medicines'), { expectedRevision: d.revision, promptId: 'Q08:medicines', action: 'answer', text: '__add', channel: 'text' });
  d = content.turn(content.select(d, 'Q08', 'medicines'), { expectedRevision: d.revision, promptId: 'Q08:medicines', action: 'answer', text: '__done', channel: 'text' });
  expect(projectProvisional(d, [topic]).responses.Q08.answers.medicines?.complete).toBe(true);
  const text = 'I also take Vitamin D.';
  append(d, text, 20, sourceId => ({ claims: [claim(sourceId, text, 'medicines[vitd].name', 'known', 'Vitamin D')],
    items: [{ topicId: 'Q08', collection: 'medicines', id: 'vitd', entity: 'Vitamin D', evidence: [span(sourceId, text)] }] }));
  expect(projectProvisional(d, [topic]).responses.Q08.answers.medicines?.complete).toBe(false);
});

it('identical active correction is reaffirmation after exact-slot lineage validation and never rewrites saved claims', () => {
  const d = draft(), first = append(d, 'Vitamin C strength is 100 mg.', 1, id => ({ claims: [claim(id, 'Vitamin C strength is 100 mg.', 'medicines[vitc].strength', 'known', '100 mg')], items: [{ topicId: 'Q08', collection: 'medicines', id: 'vitc', entity: 'Vitamin C', evidence: [span(id, 'Vitamin C strength is 100 mg.')] }] }));
  append(d, 'Vitamin C is still 100 mg.', 2, id => ({ claims: [{ ...claim(id, 'Vitamin C is still 100 mg.', 'medicines[vitc].strength', 'known', '100 mg'), correctsSourceIds: [first] }] }));
  const original = structuredClone(d), p = projectProvisional(d, [topic]);
  expect(p.claims.map(c => c.status)).toEqual(['proposed', 'proposed']); expect(p.claims.flatMap(c => c.correctsSourceIds)).toEqual([]);
  expect(p.provenance[0].sourceIds).toHaveLength(2); expect(p.provenance[0].supersededEvidence).toEqual([]); expect(d).toEqual(original);
  for (const change of ['value', 'period', 'entity', 'state', 'foreign-link', 'prior-conflict'] as const) {
    const mutated = structuredClone(d), operations = Object.values(mutated.adaptive!.operations), later = operations[1].stream!.provisional!.claims[0];
    if (change === 'value') later.value = '200 mg';
    if (change === 'period') later.scope.period = 'last year';
    if (change === 'entity') later.scope.entity = 'different subject';
    if (change === 'state') { later.state = 'uncertain'; later.value = null; later.valueEvidence = null; }
    if (change === 'foreign-link') later.correctsSourceIds = [crypto.randomUUID()];
    if (change === 'prior-conflict') operations[0].stream!.provisional!.claims[0].status = 'conflicting';
    const inverse = projectProvisional(mutated, [topic]);
    expect(inverse.claims[1].correctsSourceIds).toEqual(later.correctsSourceIds);
    expect(inverse.claims[0].status).not.toBe('proposed');
  }
});
