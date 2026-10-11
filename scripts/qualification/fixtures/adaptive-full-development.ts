import { conversation } from '../../../packages/clinic-api/src/conversation.js';
import type { AdaptiveContext } from '../../../packages/clinic-api/src/adaptive-validation.js';
import type { ClinicApiConfig, Draft } from '../../../packages/clinic-api/src/types.js';
import type { FullReplyDraft, FullReplyManifest } from '../../../packages/clinic-api/src/adaptive-reply-full.js';

/** Prospective authored development example; no holdout or observed model output. */
export const fullDevelopmentSource = { id: 'development-full-1', role: 'patient' as const, at: '2026-10-10T12:00:00.000Z',
  text: "I'm five feet eight inches. I take Vitamin C, 500 mg each morning. That is my complete medicine and supplement list. I don't know whether my weight changed. Please move on from weight." };
export const fullDevelopmentLabels = { syntheticOnly: true, expected: [
  { topic: 'Q04', path: 'height.value', value: { feet: 5, inches: 8 }, subject: 'patient' },
  { topic: 'Q08', collection: 'medicines', entity: 'Vitamin C', fields: { name: 'Vitamin C', strength: '500 mg', actualUse: 'each morning' }, closure: true },
], controls: ['Do not reask supplied weight uncertainty', 'Preserve move-on from weight'], unresolved: ['Medicine label directions/reason/concerns were not supplied'],
  scope: 'Authored labels for future empirical development evaluation, not qualification or completeness proof' };
export function fullDevelopmentContext(scenario: Draft['scenario'] = 'first-intake'): AdaptiveContext {
  const content = conversation({ mentalHealth: 'phq4', patients: {} } as ClinicApiConfig);
  const d = { schema: 1, id: 'development-full-session', patient: 'Patient/synthetic-only', scenario, revision: 1, createdAt: fullDevelopmentSource.at,
    savedAt: fullDevelopmentSource.at, phase: 'conversation', turns: [fullDevelopmentSource], topics: {}, requests: {}, version: 1 } as Draft;
  return { binding: { operationId: 'development-full-operation', sessionId: d.id, patient: d.patient, scenario, revision: d.revision, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'development-only' },
    source: { ...fullDevelopmentSource }, sources: [{ ...fullDevelopmentSource }], topics: content.captureDefinitions(d), responses: {}, displayed: scenario === 'first-intake' ? { topicId: 'Q04', promptId: 'Q04', targetPaths: ['height.value','height.unit'] } : undefined };
}
/** Authored representative to measure serialization; never inferred or submitted as model output. */
export function representativeFullDraft(manifest: FullReplyManifest): FullReplyDraft {
  const payload = JSON.parse(String(manifest.messages[1].content)) as { statements: { id: string; text: string }[] };
  const quote = (sentence: number, text?: string) => ({ statementId: payload.statements[sentence].id, quote: text ?? payload.statements[sentence].text });
  const target = (topic: string, path: string) => manifest.targets.find(target => target.topicId === topic && target.path === path)!.id;
  const claim = (topic: string, path: string, value: FullReplyDraft['claims'][number]['value'], sentence: number, literal: string, itemKey: string | null = null): FullReplyDraft['claims'][number] => ({ targetId: target(topic,path), itemKey, state: 'known', value,
    valueEvidence: quote(sentence,literal), evidence: [quote(sentence)], scope: { subject: 'patient', entity: itemKey === null ? null : 'Vitamin C', period: null, predicate: quote(sentence) }, correctsSourceIds: [] });
  return { manifestId: manifest.id, claims: [claim('Q04','height.value',{ feet: 5,inches: 8 },0,'five feet eight inches'),
    claim('Q08','medicines[new].name','Vitamin C',1,'Vitamin C','vitc'), claim('Q08','medicines[new].strength','500 mg',1,'500 mg','vitc'), claim('Q08','medicines[new].actualUse','each morning',1,'each morning','vitc')],
    items: [{ collectionId: target('Q08','medicines'), key: 'vitc', entity: 'Vitamin C', evidence: [quote(1)] }], closures: [{ collectionId: target('Q08','medicines'), evidence: [quote(2)] }],
    acts: [{ kind: 'move-on', targetTopicId: 'Q04', replyId: null, evidence: [quote(4)] }], residual: [{ evidence: [quote(3)], reason: 'ambiguous' }], sourceDisposition: 'partially-represented' };
}
