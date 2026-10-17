import { describe, expect, it } from 'vitest';
import { conversation } from '../src/conversation.js';
import { fullProvisionalPolicy, type ProvisionalCapture } from '../src/provisional-draft.js';
import { adaptiveSession, type AdaptiveDraftStore } from '../src/adaptive-session.js';
import type { ClinicApiConfig, Draft, StoredDraft } from '../src/types.js';
const scenarios = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'] as const;
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://127.0.0.1:5173', medplumBaseUrl: 'http://localhost:8103/', projectId: 'synthetic-project', clientId: 'synthetic-client', clientSecret: 'synthetic-offline', cookieSecret: 'synthetic-cookie-key-at-least32characters', mentalHealth: 'phq4', patients: Object.fromEntries(scenarios.map(scenario => [scenario, patient])), staff: [] } as ClinicApiConfig;
describe('admitted short-scenario relevance consistency', () => {
  it('credits an admitted volunteered concern, asks only missing followups and preserves correction history', async () => {
    const c = conversation(config), at = '2026-10-10T10:00:00.000Z';
    let draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'non-visit', revision: 0, savedAt: at, createdAt: at, phase: 'conversation', turns: [{ id: 'opening-source', role: 'patient', text: 'I want to send an update between visits.', at, channel: 'text' }], topics: {}, requests: {}, version: 1 };
    const answers = { reason: 'I want to send an update between visits.', update: 'My daily walks have improved.', timing: 'For the past week.', effect: 'I have more energy for ordinary activities.', help: 'Please let my care team know.' };
    for (const [path, text] of Object.entries(answers)) {
      draft = c.select(draft, 'W03', path);
      draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text });
    }
    expect(draft.relevantTopicIds ?? []).not.toContain('Q02');
    let observedAllowed = false;
    const service = adaptiveSession(c, { propose: async context => {
      observedAllowed = context.topics.some(topic => topic.id === 'Q02');
      expect(context.binding.scenario).toBe('non-visit');
      expect(context.nativeRouting?.relevantTopicIds ?? []).not.toContain('Q02');
      const quote = context.source.text;
      return { proposal: { schema: 1, facts: [{ topicId: 'Q02', path: 'concern', state: 'known', transform: 'verbatim', evidence: [{ sourceId: context.source.id, start: 0, end: quote.length }] }], newItems: [], completedLists: [], acts: [] } };
    } }, { fullCapture: true, now: () => Date.parse('2026-10-10T10:05:00.000Z') });
    draft = service.initialize(draft);
    let stored: StoredDraft = { resource: { resourceType: 'DocumentReference', id: 'synthetic-draft', meta: { versionId: '1' } }, draft, versionId: '1' };
    const store: AdaptiveDraftStore = { read: async () => structuredClone(stored), save: async (previous, next) => {
      expect(previous.versionId).toBe(stored.versionId);
      const versionId = String(Number(stored.versionId) + 1);
      stored = { resource: { ...stored.resource, meta: { versionId } }, draft: structuredClone(next), versionId };
      return structuredClone(stored);
    } };
    const accepted = await service.accept(store, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, text: 'I also have a headache.', channel: 'text' });
    expect(accepted.operation.status).toBe('accepted');
    const applied = await service.interpret(store, accepted.operation.id);
    expect(observedAllowed).toBe(true);
    expect(applied.operation.status).toBe('applied');
    expect(applied.draft.topics.Q02).toMatchObject({ presented: true, answers: { concern: { state: 'known', value: 'I also have a headache.', sourceIds: [accepted.operation.sourceId] } } });
    expect(applied.draft.relevantTopicIds ?? []).not.toContain('Q02');
    expect(c.definitions(applied.draft).some(topic => topic.id === 'Q02')).toBe(true);
    expect(c.effectiveRelevantTopicIds(applied.draft)).toContain('Q02');
    expect(applied.draft.adaptive?.exchange?.prompt?.topicId).toBe('Q02');
    expect(applied.draft.adaptive?.exchange?.prompt?.targetPaths).not.toContain('concern');
    expect(c.view(applied.draft, true, true).currentPrompt?.topicId).toBe('Q02');
    expect((await c.preview(applied.draft)).confirmation.submission.questionnaireCapture?.relevantTopicIds).toContain('Q02');
    const resumed = service.dialogue(applied.draft);
    expect(resumed.adaptive?.exchange?.prompt?.topicId).toBe('Q02');
    draft = service.mode(applied.draft, 'guided');
    const answer = (path: string, text: string) => {
      draft = c.select(draft, 'Q02', path);
      draft = c.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: c.view(draft).currentPrompt!.id, action: 'answer', text });
    };
    answer('onset', 'Yesterday.');
    const priorOnset = draft.topics.Q02.answers.onset;
    answer('concern', '__negative');
    expect(draft.topics.Q02.answers.onset).toBeUndefined();
    expect(c.view(draft).currentPrompt?.topicId).not.toBe('Q02');
    answer('concern', 'I have a headache again.');
    expect(draft.topics.Q02.answers.onset).toBeUndefined();
    expect(c.view(draft).currentPrompt?.id).toBe('Q02:onset');
    expect(draft.questionnaireHistory).toEqual(expect.arrayContaining([expect.objectContaining({ topicId: 'Q02', path: 'onset', answer: priorOnset })]));
    const capture = (await c.preview(draft)).confirmation.submission.questionnaireCapture!;
    expect(capture.relevantTopicIds).toContain('Q02');
    expect(capture.topics.Q02.answers.onset).toBeUndefined();
  });
  it('rejects volunteered Q02 extraction in billing and keeps the raw words without clinical relevance', async () => {
    const c = conversation(config), at = new Date().toISOString();
    let draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'billing', revision: 0, savedAt: at, createdAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
    const service = adaptiveSession(c, { propose: async context => {
      expect(context.topics.some(topic => topic.id === 'Q02')).toBe(false);
      return { proposal: { schema: 1, facts: [{ topicId: 'Q02', path: 'concern', state: 'known', transform: 'verbatim', evidence: [{ sourceId: context.source.id, start: 0, end: context.source.text.length }] }], newItems: [], completedLists: [], acts: [] } };
    } }, { fullCapture: true });
    draft = service.initialize(draft);
    let stored: StoredDraft = { resource: { resourceType: 'DocumentReference', id: 'billing-draft' }, draft, versionId: '1' };
    const store: AdaptiveDraftStore = { read: async () => structuredClone(stored), save: async (_previous, next) => { stored = { ...stored, draft: structuredClone(next), versionId: String(Number(stored.versionId) + 1) }; return structuredClone(stored); } };
    const accepted = await service.accept(store, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, text: 'I also have a headache.', channel: 'text' });
    const result = await service.interpret(store, accepted.operation.id);
    expect(result.operation.status).toBe('failed');
    expect(result.draft.turns.some(turn => turn.id === accepted.operation.sourceId && turn.text === 'I also have a headache.')).toBe(true);
    expect(result.draft.topics.Q02).toBeUndefined();
    expect(c.effectiveRelevantTopicIds(result.draft)).not.toContain('Q02');
    expect(c.view(result.draft, true, true).currentPrompt?.topicId).not.toBe('Q02');
    expect((await c.preview(result.draft)).confirmation.submission.questionnaireCapture?.relevantTopicIds).not.toContain('Q02');
  });
  it('does not infer pregnancy relevance or credit an unqualified provisional concern from presentation alone', () => {
    const c = conversation(config), at = new Date().toISOString();
    const draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 0, savedAt: at, createdAt: at, phase: 'conversation', turns: [{ id: 'source', role: 'patient', text: 'Synthetic uncertain report', at, channel: 'text' }], topics: { Q18: { presented: true, answers: { context: { state: 'unknown', sourceIds: ['source'] } } } }, requests: {}, version: 1 };
    expect(c.effectiveRelevantTopicIds(draft)).not.toContain('Q18');
    expect(c.definitions(draft).find(topic => topic.id === 'Q18')?.presentation).toBe('O');
    draft.scenario = 'non-visit'; draft.topics = {};
    expect(c.captureDefinitions(draft).some(topic => topic.id === 'Q02')).toBe(true);
    expect(c.effectiveRelevantTopicIds(draft)).not.toContain('Q02');
    const span = { sourceId: 'source', start: 0, end: draft.turns[0].text.length };
    const capture: ProvisionalCapture = { sourceId: 'source', policy: fullProvisionalPolicy, claims: [{ id: 'claim', topicId: 'Q02', path: 'concern', sourceId: 'source', state: 'known', value: draft.turns[0].text, evidence: [span], valueEvidence: span, scope: { subject: 'patient', entity: null, period: null, predicate: span }, correctsSourceIds: [], attribution: 'proposed-patient-report', policy: fullProvisionalPolicy, status: 'proposed', fidelity: 'literal-supported' }], gaps: [], accounting: { addressed: [span], remaining: [], semanticReview: 'qualification-required' } };
    draft.adaptive = { mode: 'adaptive', operations: { op: { id: 'op', requestId: 'request', sourceId: 'source', fingerprint: 'synthetic-offline', status: 'applied', acceptedAt: at, updatedAt: at, binding: { operationId: 'op', sessionId: draft.id, patient: draft.patient, scenario: draft.scenario, revision: draft.revision, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'a'.repeat(64) }, stream: { protocol: 'durable-provisional-stream-v1', reply: 'withheld', capture: 'saved', targetGenerations: {}, provisional: capture } } } };
    expect(c.effective(draft).responses.Q02).toMatchObject({ presented: true, answers: { concern: { state: 'known' } } });
    expect(c.effective(draft, true).responses.Q02).toBeUndefined();
    expect(c.effectiveRelevantTopicIds(draft)).not.toContain('Q02');
    expect(c.definitions(draft).some(topic => topic.id === 'Q02')).toBe(false);
  });

});
