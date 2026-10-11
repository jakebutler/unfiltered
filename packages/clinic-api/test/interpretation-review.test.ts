import { describe, expect, it } from 'vitest';
import { interpretationReview } from '../src/interpretation-review.js';
import { conversation } from '../src/conversation.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';

const at = '2026-10-09T12:00:00.000Z';
const text = '🙂 I want more energy. My work schedule rotates.';
const patient = { reference: 'Patient/test', displayName: 'Synthetic Patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://127.0.0.1:5173', cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
function fixture(): Draft {
  return { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 1, savedAt: at, createdAt: at, phase: 'conversation',
    turns: [{ id: 'source', role: 'patient', text, at }], topics: {}, requests: {}, version: 1,
    adaptive: { mode: 'adaptive', operations: { op: { id: 'op', requestId: 'request', sourceId: 'source', fingerprint: 'fingerprint', status: 'applied', acceptedAt: at, updatedAt: at,
      binding: { operationId: 'op', sessionId: 'session', patient: patient.reference, scenario: 'first-intake', revision: 1, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'fixture' },
      hasUnresolvedInterpretation: true, unmapped: [{ reason: 'unsupported-target', evidence: [{ sourceId: 'source', start: text.indexOf('My work'), end: text.length }] }],
    } } },
  };
}
const unresolved = [{ sourceId: 'source', reason: 'Saved wording needs human review.' }];
describe('immutable interpretation review evidence', () => {
  it('inventories failed zero-claim sources without hiding their original words or status', () => {
    const draft = fixture(), operation = draft.adaptive!.operations.op;
    operation.status = 'failed'; operation.stream = { protocol: 'durable-provisional-stream-v1', reply: 'withheld', capture: 'partial', targetGenerations: {} };
    const inventory = interpretationReview(draft).find(topic => topic.id === 'source-fact-review')!;
    expect(inventory.details!.find(detail => detail.id === 'source:source')!.text).toBe(text);
    expect(inventory.details!.find(detail => detail.id === 'status:op')!.text).toContain('failed');
    expect(inventory.details!.some(detail => detail.id === 'unmapped:source')).toBe(true);
    expect(inventory.details!.filter(detail => detail.id.startsWith('report:'))).toEqual([]);
  });
  it.each([
    { sourceId: 'foreign', start: 0, end: 2 },
    { sourceId: 'source', start: -1, end: 2 },
    { sourceId: 'source', start: 0, end: 999 },
    { sourceId: 'source', start: 1, end: 2 },
    { sourceId: 'source', start: 0, end: 1 },
    { sourceId: 'source', start: 3.5, end: 5 },
    { sourceId: 'source', start: 4, end: 4 },
  ])('rejects corrupt or foreign evidence %j', span => {
    const draft = fixture(); draft.adaptive!.operations.op.unmapped![0].evidence = [span];
    expect(() => interpretationReview(draft, unresolved)).toThrow('invalid-interpretation-evidence');
  });
  it('rejects assistant text masquerading as patient evidence', () => {
    const draft = fixture(); draft.turns[0].role = 'assistant';
    expect(() => interpretationReview(draft, unresolved)).toThrow('invalid-interpretation-evidence');
  });
  it('copies exact spans and refuses changed diagnostic content under the reviewed version', async () => {
    const draft = fixture(), content = conversation(config);
    draft.preview = await content.preview(draft, at); draft.phase = 'review';
    const visible = structuredClone(content.view(draft).topics);
    expect(content.view(draft, false).topics).toEqual([]);
    expect(visible.find(topic => topic.id === 'interpretation')!.interpretationGaps![0].evidence[0]).toEqual(draft.adaptive!.operations.op.unmapped![0].evidence[0]);
    draft.adaptive!.operations.op.unmapped![0].reason = 'ambiguous';
    expect(content.view(draft).topics).toEqual(visible);
    await expect(content.finalize(draft)).rejects.toThrow('confirmation-digest-mismatch');
  });
});
