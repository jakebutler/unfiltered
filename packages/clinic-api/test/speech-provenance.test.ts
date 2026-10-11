import { describe, expect, it, vi } from 'vitest';
import { conversation } from '../src/conversation.js';
import { handoffs, type Snapshot } from '../src/handoffs.js';
import { decodeDocument, document, saveDraft, DRAFT_SYSTEM, SNAPSHOT_SYSTEM } from '../src/store.js';
import { digest, validateSubmissionIntegrity } from '../../clinical-core/src/domain.js';
import { planHandoff } from '../../clinical-core/src/fhir.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import type { SourceChannel } from '../../clinic-contract/src/index.js';
import type { ClinicApiConfig, Draft, StoredDraft } from '../src/types.js';

const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic Patient', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://127.0.0.1:5173', mentalHealth: 'phq4', patients: { 'first-intake': patient } } as ClinicApiConfig;
const content = conversation(config);
function fresh(): Draft {
  const at = new Date().toISOString();
  return { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 0, savedAt: at, createdAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
}
function answer(draft: Draft, text: string, channel: SourceChannel = 'unreviewed-transcript') {
  return content.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: content.view(draft).currentPrompt!.id, action: 'answer', text, channel });
}

describe('immutable speech provenance through confirmation and handoff', () => {
  it('keeps exact recognized words and appends reviewed corrections without changing the original', async () => {
    const originalText = '  I take fifteen milligrams, not fifty.\n';
    const original = answer(fresh(), originalText), source = structuredClone(original.turns.at(-1)!);
    const corrected = answer(content.select(original, 'Q01', 'reason'), 'I meant five milligrams.', 'confirmed-transcript');
    expect(source).toMatchObject({ text: originalText, channel: 'unreviewed-transcript' });
    expect(corrected.turns.find(t => t.id === source.id)).toEqual(source);
    expect(corrected.turns.at(-1)).toMatchObject({ text: 'I meant five milligrams.', corrects: source.id, channel: 'confirmed-transcript' });
    corrected.preview = await content.preview(corrected); corrected.phase = 'review';
    const final = await content.finalize(corrected);
    expect(final.confirmation.submission.sources.map(s => ({ text: s.text, channel: s.channel }))).toEqual([
      { text: originalText, channel: 'unreviewed-transcript' }, { text: 'I meant five milligrams.', channel: 'confirmed-transcript' },
    ]);
    expect(content.view(corrected).turns.find(t => t.id === source.id)).toEqual(source);
    const plan = await planHandoff(final.confirmation);
    const stored = decodeDocument<{ sources: unknown[] }>(plan.components.find(c => c.key.endsWith('.sources'))!.resource);
    expect(stored.sources).toEqual(final.confirmation.submission.sources);
  });

  it('binds channel into the preview digest and refuses to relabel a source under the reviewed digest', async () => {
    const draft = answer(fresh(), 'More energy.');
    draft.preview = await content.preview(draft); draft.phase = 'review';
    const changed = structuredClone(draft); changed.turns.at(-1)!.channel = 'confirmed-transcript';
    expect((await content.preview(changed, draft.preview.confirmation.submission.confirmedAt)).digest).not.toBe(draft.preview.digest);
    await expect(content.finalize(changed)).rejects.toThrow('confirmation-digest-mismatch');
  });

  it('keeps absent legacy channels absent through validation, confirmation, hashing and FHIR serialization', async () => {
    const draft = answer(fresh(), 'An older saved answer.', 'text');
    delete draft.turns.at(-1)!.channel;
    draft.preview = await content.preview(draft); draft.phase = 'review';
    const before = structuredClone(draft.preview.confirmation.submission);
    expect(before.sources[0]).not.toHaveProperty('channel');
    expect(await digest(validateSubmissionIntegrity(before))).toBe(draft.preview.digest);
    const final = await content.finalize(draft);
    const plan = await planHandoff(final.confirmation);
    const stored = decodeDocument<{ sources: unknown[] }>(plan.components.find(c => c.key.endsWith('.sources'))!.resource);
    expect(stored.sources[0]).not.toHaveProperty('channel');
    expect(await digest({ ...final.confirmation.submission, confirmedAt: before.confirmedAt })).toBe(draft.preview.digest);
  });

  it.each(['text', 'channel', 'remove'] as const)('rejects rewriting an already persisted source: %s', async change => {
    const draft = answer(fresh(), 'Exact original recognized words.');
    const previous: StoredDraft = { draft, resource: { ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft), id: 'draft', meta: { versionId: '1' } }, versionId: '1' };
    // Also catch in-place mutations of a caller's decoded draft, not just cloned edits.
    if (change === 'text') draft.turns.at(-1)!.text = 'Replacement wording';
    else if (change === 'channel') draft.turns.at(-1)!.channel = 'confirmed-transcript';
    else draft.turns.pop();
    const request = vi.fn();
    await expect(saveDraft({ request } as unknown as MedplumClient, previous, draft)).rejects.toMatchObject({ code: 'immutable-source-conflict' });
    expect(request).not.toHaveBeenCalled();
  });

  it('projects original speech provenance from the confirmed snapshot to authorized clinical staff', async () => {
    const draft = answer(fresh(), 'More energy.');
    draft.preview = await content.preview(draft); draft.phase = 'review';
    const final = await content.finalize(draft);
    const snapshot: Snapshot = { schema: 1, id: draft.id, patient: draft.patient, patientName: patient.displayName, scenario: draft.scenario, confirmation: final.confirmation, topics: final.topics };
    const resource = { ...document(SNAPSHOT_SYSTEM, `${draft.id}.v1`, draft.patient, snapshot), id: 'snapshot' };
    const client = {
      request: vi.fn(async (path: string) => ({ body: path.startsWith('Task/') ? { resourceType: 'Task', id: 'work', meta: { versionId: '1' } } : path.includes('?') ? { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource }] } : resource })),
      check: vi.fn(async () => ({ state: 'received', digest: final.digest, resources: Object.fromEntries(final.confirmation.submission.work.map(w => [`${draft.id}.v1.work.${w.id}`, `Task/${w.id}`])) })),
    } as unknown as MedplumClient;
    const staff = { membershipId: 'md', profile: 'Practitioner/md', policy: 'AccessPolicy/clinical', name: 'Synthetic MD', role: 'physician' as const, patients: [draft.patient], careTeams: [patient.careTeams.medical] };
    const view = await handoffs(config).view(client, client, staff, `${draft.id}.v1`);
    expect(view.sources).toEqual([{ id: draft.turns.at(-1)!.id, text: 'More energy.', channel: 'unreviewed-transcript', at: draft.turns.at(-1)!.at, role: 'patient' }]);
  });
});
