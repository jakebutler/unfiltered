import { describe, expect, it, vi } from 'vitest';
import { createAdaptiveValueManifest, resolveAdaptiveValueProposal } from '../src/adaptive-value-manifest.js';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext, type AdaptiveOutcome } from '../src/adaptive-validation.js';
import { adaptiveSession, type AdaptiveDraftStore } from '../src/adaptive-session.js';
import { conversation } from '../src/conversation.js';
import { administrativeTopics, handoffs, type Snapshot } from '../src/handoffs.js';
import { decodeDocument, document, SNAPSHOT_SYSTEM } from '../src/store.js';
import { digest } from '../../clinical-core/src/domain.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import { planHandoff, resolveReferences, type FhirResource } from '../../clinical-core/src/fhir.js';
import type { ClinicApiConfig, Draft, StoredDraft } from '../src/types.js';

const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic Patient', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://127.0.0.1:5173', mentalHealth: 'phq4', patients: { 'first-intake': patient } } as ClinicApiConfig;
const text = 'I take Cetirizine 10 mg.';
function propose(ctx: AdaptiveContext) {
  const m = createAdaptiveValueManifest(ctx);
  const p = Object.assign({}, ...m.payloads) as { sourceSegments: string[][]; topics: { topicId: string; collections: { ref: string; path: string; fields: { ref: string; path: string }[] }[] }[] };
  const collection = p.topics.find(topic => topic.topicId === 'Q08')!.collections.find(collection => collection.path === 'medicines')!;
  const sentence = p.sourceSegments.find(row => row[1] === 'sentence' && row[2].includes(text))!;
  const raw = { schema: 5, context: m.id, facts: [], newItems: [{ collection: collection.ref, fields: [['name', 'Cetirizine'], ['strength', '10 mg']].map(([path, quote]) => ({ field: collection.fields.find(field => field.path === path)!.ref, state: 'known', value: { source: sentence[0], quote }, evidence: [{ source: sentence[0], quote: text }] })) }], completedLists: [], interruptions: [], unmapped: [] };
  return { proposal: resolveAdaptiveValueProposal(raw, ctx, m), rawProposal: raw };
}

describe('V5 durable value/support provenance and confirmed staff handoff', () => {
  it('retains both roles through operation readback/digest, patient review, snapshot and clinical staff view', async () => {
    const content = conversation(config);
    let captured: AdaptiveOutcome | undefined;
    const proposer = { async propose(ctx: AdaptiveContext) {
      const candidate = propose(ctx);
      captured = applyValidatedTurn(ctx, validateAdaptiveProposal(candidate.proposal, ctx));
      return candidate;
    } };
    const service = adaptiveSession(content, proposer);
    const at = '2026-10-09T12:00:00.000Z';
    const draft: Draft = service.initialize({ schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 0, savedAt: at, createdAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 });
    let saved: StoredDraft = { resource: { resourceType: 'DocumentReference', id: 'draft', meta: { versionId: '0' } }, draft };
    const store: AdaptiveDraftStore = {
      async read() { return JSON.parse(JSON.stringify(saved)); },
      async save(previous, next) {
        expect(previous.draft.revision).toBe(saved.draft.revision);
        saved = JSON.parse(JSON.stringify({ resource: { ...saved.resource, meta: { versionId: String(next.revision) } }, draft: next }));
        return this.read();
      },
    };
    const accepted = await service.accept(store, { requestId: 'v5-source-operation', expectedRevision: 0, text, channel: 'confirmed-transcript' });
    const applied = await service.interpret(store, accepted.operation.id);
    expect(applied.operation.status).toBe('applied');
    const restored = await adaptiveSession(content, proposer).reconcile(store, accepted.operation.id);
    expect(restored.operation.provenance).toEqual(captured!.provenance);
    expect(restored.operation.resultDigest).toBe(await digest(captured!));
    const withoutSupport = structuredClone(captured!);
    for (const entry of withoutSupport.provenance) { delete entry.supportEvidence; delete entry.supportSourceText; }
    expect(restored.operation.resultDigest).not.toBe(await digest(withoutSupport));
    const storedDraft = (await store.read()).draft;
    const detail = content.view(storedDraft).topics.find(topic => topic.id === 'Q08')!.details!.find(detail => detail.id.endsWith('.strength'))!;
    expect(detail.text).toBe('10 mg');
    expect(detail.provenance).toMatchObject([{ role: 'value', evidenceProtocol: 'contextual-values-v5' }, { role: 'support', evidenceProtocol: 'contextual-values-v5' }]);
    const source = storedDraft.turns.find(source => source.id === restored.operation.sourceId)!;
    expect(detail.provenance!.map(span => source.text.slice(span.start, span.end))).toEqual(['10 mg', text]);
    expect(source).toMatchObject({ text, channel: 'confirmed-transcript' });

    storedDraft.preview = await content.preview(storedDraft); storedDraft.phase = 'review';
    const altered = structuredClone(storedDraft);
    altered.adaptive!.operations[accepted.operation.id].provenance![0].supportEvidence![0].end -= 1;
    await expect(content.finalize(altered)).rejects.toThrow('confirmation-digest-mismatch');
    const final = await content.finalize(storedDraft);
    const snapshot: Snapshot = { schema: 2, deliveryContract: 'conditional-resumable-v1', id: storedDraft.id, patient: storedDraft.patient, patientName: patient.displayName, scenario: storedDraft.scenario, confirmation: final.confirmation, topics: final.topics };
    const resource = { ...document(SNAPSHOT_SYSTEM, `${storedDraft.id}.v1`, storedDraft.patient, snapshot), id: 'snapshot' };
    expect(decodeDocument<Snapshot>(resource).topics).toEqual(final.topics);
    // Anchored source and response components as the real handoff writes them: the planned resources with the
    // source reference rewritten to the anchor version, version-readable by reference.
    const plan = await planHandoff(final.confirmation);
    const sourceAnchor = 'DocumentReference/source-anchor', responseAnchor = 'QuestionnaireResponse/response-anchor';
    const anchorReferences = new Map([[plan.components[0].fullUrl, `${sourceAnchor}/_history/1`]]);
    const atVersion = (resource: FhirResource): FhirResource => ({ ...resolveReferences(resource, anchorReferences), meta: { ...(resource.meta as Record<string, unknown>), versionId: '1' } });
    const anchored: Record<string, FhirResource> = { [sourceAnchor]: atVersion(plan.components[0].resource), [responseAnchor]: atVersion(plan.components[1].resource) };
    const client = {
      request: vi.fn(async (path: string) => ({ body: path.includes('?') ? { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource }] } : resource })),
      history: vi.fn(async () => [resource]),
      versionRead: vi.fn(async (reference: string) => reference === 'DocumentReference/snapshot' ? resource : anchored[reference]),
      // Work Tasks are not part of this probe, so the receipt is incomplete while source and response are anchored.
      check: vi.fn(async () => ({ state: 'incomplete', digest: final.digest, present: 2, resources: {}, verifiedWork: [], anchors: {
        source: { reference: sourceAnchor, version: '1', hash: await digest(anchored[sourceAnchor]) },
        response: { reference: responseAnchor, version: '1', hash: await digest(anchored[responseAnchor]) },
      } })),
    } as unknown as MedplumClient;
    const staff = { membershipId: 'md', profile: 'Practitioner/md', policy: 'AccessPolicy/clinical', name: 'Synthetic MD', role: 'physician' as const, patients: [storedDraft.patient], careTeams: [patient.careTeams.medical] };
    const handoff = await handoffs(config).view(client, client, staff, `${storedDraft.id}.v1`);
    expect(handoff.topics.find(topic => topic.id === 'Q08')!.details!.find(detail => detail.id.endsWith('.strength'))!.provenance).toEqual(detail.provenance);
    expect(handoff.sources).toContainEqual({ id: source.id, text, channel: 'confirmed-transcript', at: source.at, role: 'patient' });
    expect(administrativeTopics(snapshot)).toEqual([]);
  });
});
