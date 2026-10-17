import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditAdaptiveRawProposal, fitAdaptiveRawAudit, adaptiveSession, operationView, type AdaptiveDraftStore } from '../src/adaptive-session.js';
import { AdaptiveProposalFailure, type AdaptiveProposer, type AdaptiveProposalReceipt } from '../src/adaptive.js';
import { conversation } from '../src/conversation.js';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import type { ClinicApiConfig, Draft, StoredDraft } from '../src/types.js';
import { fact, proposal } from './fixtures/adaptive.js';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const receipt: AdaptiveProposalReceipt = { requestId: 'audit-provider-receipt', model: 'offline-test', evidenceProtocol: 'contextual-handles-v4', manifest: { id: 'bound', sha256: 'manifest-hash' } };
const patient = { reference: 'Patient/audit', displayName: 'Synthetic Patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };

function fixture(proposer: AdaptiveProposer, timeoutMs = 1000) {
  const content = conversation({ mentalHealth: 'phq4', patients: { 'first-intake': patient } } as ClinicApiConfig), service = adaptiveSession(content, proposer, { timeoutMs });
  const draft: Draft = service.initialize({ schema: 1, id: 'audit-session', patient: 'Patient/audit', scenario: 'first-intake', revision: 0, savedAt: '2026-10-09T12:00:00Z', createdAt: '2026-10-09T12:00:00Z', phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 });
  let saved: StoredDraft = { resource: { resourceType: 'DocumentReference', id: 'draft', meta: { versionId: '0' } }, draft };
  const store: AdaptiveDraftStore = {
    async read() { return JSON.parse(JSON.stringify(saved)); },
    async save(previous, next) { expect(previous.draft.revision).toBe(saved.draft.revision); saved = JSON.parse(JSON.stringify({ resource: { ...saved.resource, meta: { versionId: String(next.revision) } }, draft: next })); return this.read(); },
  };
  return { service, store, content, current: () => saved, restart: () => adaptiveSession(content, proposer, { timeoutMs }) };
}

describe('bounded raw proposal audit representation', () => {
  it('records canonical JSON explicitly and hashes the complete representation', () => {
    const raw = { z: ['🙂', 'line\nquote"', 42, null], a: { b: true } }, expected = canonicalJson(raw);
    expect(auditAdaptiveRawProposal(raw)).toEqual({ representation: 'canonical-json-v1', retention: 'retained', content: expected, bytes: Buffer.byteLength(expected), sha256: sha(expected) });
    expect(raw.z[0]).toBe('🙂');
  });
  it('preserves malformed provider text and Unicode across bounded chunk boundaries', () => {
    const text = 'a'.repeat(4095) + '🙂' + '\n{bad JSON';
    expect(auditAdaptiveRawProposal(text)).toEqual({ representation: 'raw-proposal-string-v1', retention: 'retained', content: text, bytes: Buffer.byteLength(text), sha256: sha(text) });
  });
  it.each([false, true])('retains only full digest and size above the bound, without truncated content (object=%s)', object => {
    const text = '🙂'.repeat(40000), raw = object ? { text } : text, expected = object ? canonicalJson(raw) : text;
    const audit = auditAdaptiveRawProposal(raw);
    expect(audit).toEqual({ representation: object ? 'canonical-json-v1' : 'raw-proposal-string-v1', retention: 'oversize', bytes: Buffer.byteLength(expected), sha256: sha(expected) });
    expect(audit).not.toHaveProperty('content');
  });
  it('retains the exact boundary and labels non-JSON input without failing interpretation', () => {
    expect(auditAdaptiveRawProposal('a'.repeat(128 * 1024))?.retention).toBe('retained');
    expect(auditAdaptiveRawProposal('a'.repeat(128 * 1024 + 1))?.retention).toBe('oversize');
    const cyclic: any = {}; cyclic.self = cyclic;
    expect(auditAdaptiveRawProposal(cyclic)).toEqual({ representation: 'canonical-json-v1', retention: 'unserializable' });
    expect(auditAdaptiveRawProposal(undefined)).toBeUndefined();
  });
});

describe('durable raw audit without inference replay', () => {
  it.each(['accepted', 'semantic-rejection', 'wire-rejection', 'invalid-json'] as const)('persists %s raw data and receipt through serialized restart', async mode => {
    let calls = 0;
    const raw = mode === 'invalid-json' ? '{broken provider output' : { schema: 4, untouchedModelData: 'quoted original' };
    const f = fixture({ propose: async ctx => {
      calls++;
      if (mode === 'wire-rejection' || mode === 'invalid-json') throw new AdaptiveProposalFailure(mode, receipt, raw);
      return { proposal: mode === 'semantic-rejection' ? proposal([{ ...fact(ctx, 'Q01', 'reason', ctx.source.text), path: 'not-a-target' }]) : proposal([fact(ctx, 'Q01', 'reason', ctx.source.text)]), receipt, rawProposal: raw };
    } });
    const accepted = await f.service.accept(f.store, { requestId: 'audit-op', expectedRevision: 0, text: 'More energy.', channel: 'text' });
    const result = await f.service.interpret(f.store, accepted.operation.id);
    expect(result.operation.status).toBe(mode === 'accepted' ? 'applied' : 'failed');
    const restored = await f.restart().reconcile(f.store, accepted.operation.id);
    expect(restored.operation.rawProposalAudit).toEqual(auditAdaptiveRawProposal(raw));
    expect(restored.operation.receipt).toEqual(receipt);
    expect(JSON.stringify(operationView(restored.operation))).not.toContain('quoted original');
    expect(operationView(restored.operation)).not.toHaveProperty('rawProposalAudit');
    await f.restart().interpret(f.store, accepted.operation.id);
    expect(calls).toBe(1);
  });
  it('caps repeated retained audits per session without dropping previous audit or patient sources', async () => {
    const raw = 'a'.repeat(60 * 1024); let calls = 0;
    const f = fixture({ propose: async ctx => { calls++; return { proposal: proposal([fact(ctx, 'Q01', 'reason', ctx.source.text)]), receipt, rawProposal: raw }; } });
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const accepted = await f.service.accept(f.store, { requestId: `session-budget-${index}`, expectedRevision: f.current().draft.revision, text: 'More energy.', channel: 'text' });
      ids.push(accepted.operation.id); await f.service.interpret(f.store, accepted.operation.id);
    }
    const operations = f.current().draft.adaptive!.operations, audits = ids.map(id => operations[id].rawProposalAudit!);
    expect(audits.map(audit => audit.retention)).toEqual(['retained', 'retained', 'session-capacity']);
    expect(audits[2]).toEqual({ representation: 'raw-proposal-string-v1', retention: 'session-capacity', bytes: raw.length, sha256: sha(raw) });
    expect(audits.filter(audit => audit.retention === 'retained').reduce((sum, audit) => sum + Buffer.byteLength(JSON.stringify(audit)), 0)).toBeLessThanOrEqual(128 * 1024);
    expect(ids.every(id => operations[id].status === 'applied')).toBe(true);
    expect(f.current().draft.turns.filter(turn => turn.role === 'patient')).toHaveLength(3);
    expect(calls).toBe(3);
  });
  it('counts document escaping overhead in the aggregate allocation', () => {
    const raw = '\n'.repeat(70 * 1024), audit = auditAdaptiveRawProposal(raw)!;
    expect(audit.retention).toBe('retained');
    const f = fixture({ propose: async () => ({ proposal: proposal() }) });
    expect(fitAdaptiveRawAudit(f.current().draft, 'new', audit)).toEqual({ representation: 'raw-proposal-string-v1', retention: 'session-capacity', bytes: raw.length, sha256: sha(raw) });
  });
  it.each(['same', 'source', 'fingerprint', 'attempt', 'binding'] as const)('binds late audit retention to the original operation source and attempt: %s', async change => {
    let settle!: (value: any) => void, calls = 0;
    const raw = { rejectedOrLate: 'original proposal' };
    const f = fixture({ propose: async () => { calls++; return new Promise(resolve => { settle = resolve; }); } }, 2);
    const accepted = await f.service.accept(f.store, { requestId: 'late-audit-op', expectedRevision: 0, text: 'More energy.', channel: 'text' });
    const result = await f.service.interpret(f.store, accepted.operation.id);
    expect(result.operation.status).toBe('unresolved');
    const op = f.current().draft.adaptive!.operations[accepted.operation.id];
    if (change === 'source') op.sourceId = 'foreign-source';
    if (change === 'fingerprint') op.fingerprint = 'foreign-binding';
    if (change === 'attempt') op.attemptId = 'other-attempt';
    if (change === 'binding') op.binding.patient = 'Patient/foreign';
    settle({ proposal: proposal(), receipt, rawProposal: raw });
    for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0));
    const saved = (await f.store.read()).draft.adaptive!.operations[accepted.operation.id];
    expect(saved.rawProposalAudit).toEqual(change === 'same' ? auditAdaptiveRawProposal(raw) : undefined);
    expect(saved.receipt).toEqual(change === 'same' ? receipt : undefined);
    expect(saved.status).toBe('unresolved');
    expect(f.current().draft.topics).toEqual({});
    expect(calls).toBe(1);
  });
});
