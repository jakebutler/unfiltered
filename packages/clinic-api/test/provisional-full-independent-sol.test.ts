import { expect, it } from 'vitest';
import { createClinicContent } from '../../clinic-content/src/index.js';
import { conversation } from '../src/conversation.js';
import { projectProvisional } from '../src/provisional-projection.js';
import { fullProvisionalPolicy, type ProvisionalCapture, type ProvisionalClaim } from '../src/provisional-draft.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';

// Independent offline mechanics probes. No qualification artifact, providers,
// emitted builds, holdout or historical receipt fixtures are used here.
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
  expect(p.gaps.some(gap => gap.reason === 'conflict')).toBe(true);
  expect(p.creditedSourceIds.has(positive) || p.creditedSourceIds.has(negative)).toBe(false);
});

it('keeps a later item report conflicting with an earlier unlinked none-list report', () => {
  const d = draft(), negative = none(d, 1), positive = medicine(d, 2);
  const p = projectProvisional(d, [topic], { qualified: true });
  expect(p.responses.Q08.answers.medicines?.state).toBe('conflicting');
  expect(p.gaps.some(gap => gap.reason === 'conflict')).toBe(true);
  expect(p.creditedSourceIds.has(negative) || p.creditedSourceIds.has(positive)).toBe(false);
});

it('does not replay an old provisional closure over a later directly reopened list', () => {
  let d = draft(); medicine(d, 1, true);
  const before = projectProvisional(d, [topic]).responses.Q08;
  expect(before.answers.medicines?.complete).toBe(true);
  const content = conversation({ mentalHealth: 'phq4', patients: {} } as ClinicApiConfig);
  d = content.turn(content.select(d, 'Q08', 'medicines'), { promptId: 'Q08:medicines', action: 'answer', text: '__add', channel: 'text' });
  expect(d.topics.Q08.answers.medicines?.complete).toBe(false);
  const p = projectProvisional(d, [topic]);
  expect(p.responses.Q08.answers.medicines?.complete).toBe(false);
});
