import { expect, it } from 'vitest';
import { fullCaseContext, representativeCaseDraft } from '../../../scripts/qualification/fixtures/adaptive-full-cases.js';
import { fullCaseReadback } from '../../../scripts/qualification/fixtures/adaptive-full-readback.js';
import { createFullReplyManifest, prepareFullNavigation } from '../src/adaptive-reply-full.js';
import { createReadableManifest, decodeReadableAdvance, decodeReadableDraft, encodeReadableDraft } from '../src/adaptive-reply-readable.js';
import { selectUsefulAdvance } from '../src/reply-usefulness.js';

// Independently authored contract checks. No model output, qualification, or holdout.
it('does not interpret an unrelated source phrase as a current-topic refusal', () => {
  for (const text of ['I do not want to run out of metformin.', 'My doctor told me to move on.']) {
    const context = fullCaseContext('G8');
    context.source = { ...context.source, text }; context.sources = [context.source];
    const full = createFullReplyManifest(context), readable = createReadableManifest(full);
    const nominated = full.actions.find(action => action.topicId === 'W07')!;
    const advance = decodeReadableAdvance({ manifestId: full.id, actionId: nominated.id, controls: [], supplied: [] }, readable);
    expect(selectUsefulAdvance(context, advance, full.actions, full.targets)?.action.id).toBe(nominated.id);
  }
});

it('offers remaining height units without repeating a supplied numeric height', () => {
  const context = fullCaseContext('G6'), full = createFullReplyManifest(context), readable = createReadableManifest(full);
  const raw = encodeReadableDraft(representativeCaseDraft('G6', full), readable);
  const height = raw.claims.find(claim => claim.target === 'Q04:height.value')!;
  if (height.report.state !== 'known') throw Error('authored-known-height-required');
  const nominated = full.actions.find(action => action.topicId === 'Q04' && action.targetPaths.includes('height.value'))!;
  const advance = decodeReadableAdvance({ manifestId: full.id, actionId: nominated.id, controls: [], supplied: [{ target: height.target,
    report: { ...height.report, valueSource: raw.anchors[height.report.valueSource] }, evidence: height.evidence.map(index => raw.anchors[index]) }] }, readable);
  const selected = selectUsefulAdvance(context, advance, full.actions, full.targets, prepareFullNavigation(advance, full))!;
  expect(selected.action.topicId).toBe('Q04');
  expect(selected.action.targetPaths).toEqual(['height.unit']);
});

it('uses a complete patient command only for next-question navigation and keeps the capture audit', () => {
  const context = fullCaseContext('G2');
  context.source = { ...context.source, text: 'Please move on from weight.' }; context.sources = [context.source];
  const full = createFullReplyManifest(context), readable = createReadableManifest(full);
  const sentence = JSON.parse(String(full.messages[1].content)).statements[0];
  const nominated = full.actions.find(action => action.topicId === 'Q03')!;
  const packet = { manifestId: full.id, actionId: nominated.id, supplied: [], controls: [{ kind: 'move-on', attribution: 'direct-patient-command',
    targetTopicId: 'Q03', replyId: null, evidence: [{ statementId: sentence.id, quote: sentence.text }] }] };
  const advance = decodeReadableAdvance(packet, readable), navigation = prepareFullNavigation(advance, full);
  expect(selectUsefulAdvance(context, advance, full.actions, full.targets, navigation)?.action.topicId).not.toBe('Q03');
  expect(navigation.claims).toHaveLength(0);
  expect(navigation.acts?.[0]).toMatchObject({ topicId: 'Q03', kind: 'move-on', attribution: 'direct-patient-command' });
  expect(context.responses.Q03?.stopped).toBeUndefined();
  const auditOnly = decodeReadableAdvance({ ...packet, controls: [{ ...packet.controls[0], attribution: 'reported-content' }] }, readable);
  expect(selectUsefulAdvance(context, auditOnly, full.actions, full.targets)?.action.id).toBe(nominated.id);
});

it('cannot crop third-party instructions into direct patient navigation authority', () => {
  const context = fullCaseContext('G2');
  context.source = { ...context.source, text: 'My doctor said please move on from weight.' }; context.sources = [context.source];
  const full = createFullReplyManifest(context), readable = createReadableManifest(full);
  const sentence = JSON.parse(String(full.messages[1].content)).statements[0];
  const nominated = full.actions.find(action => action.topicId === 'Q03')!;
  for (const quote of [sentence.text, 'please move on from weight']) {
    const advance = decodeReadableAdvance({ manifestId: full.id, actionId: nominated.id, supplied: [], controls: [{ kind: 'move-on', attribution: 'direct-patient-command',
      targetTopicId: 'Q03', replyId: null, evidence: [{ statementId: sentence.id, quote }] }] }, readable);
    expect(selectUsefulAdvance(context, advance, full.actions, full.targets)?.action.id).toBe(nominated.id);
  }
});

it('preserves a complete topic refusal and a supplied unknown without asking for certainty', () => {
  const context = fullCaseContext('G6');
  context.source = { ...context.source, text: 'I prefer not to discuss height.' }; context.sources = [context.source];
  let full = createFullReplyManifest(context), readable = createReadableManifest(full);
  let sentence = JSON.parse(String(full.messages[1].content)).statements[0];
  let nominated = full.actions.find(action => action.topicId === 'Q04')!;
  const refusal = decodeReadableAdvance({ manifestId: full.id, actionId: nominated.id, supplied: [], controls: [{ kind: 'move-on', attribution: 'direct-patient-command',
    targetTopicId: 'Q04', replyId: null, evidence: [{ statementId: sentence.id, quote: sentence.text }] }] }, readable);
  expect(selectUsefulAdvance(context, refusal, full.actions, full.targets)?.action.topicId).not.toBe('Q04');
  context.source = { ...context.source, text: 'I do not know my height.' }; context.sources = [context.source];
  full = createFullReplyManifest(context); readable = createReadableManifest(full);
  sentence = JSON.parse(String(full.messages[1].content)).statements[0];
  nominated = full.actions.find(action => action.topicId === 'Q04' && action.targetPaths.includes('height.value'))!;
  const unknown = decodeReadableAdvance({ manifestId: full.id, actionId: nominated.id, controls: [], supplied: [{ target: 'Q04:height.value', report: { state: 'unknown' },
    evidence: [{ statementId: sentence.id, quote: sentence.text }] }] }, readable);
  const navigation = prepareFullNavigation(unknown, full), selected = selectUsefulAdvance(context, unknown, full.actions, full.targets, navigation)!;
  expect(selected.action.targetPaths).not.toContain('height.value');
  expect(navigation.claims[0]).toMatchObject({ state: 'unknown', value: null });
  expect(context.responses.Q04?.answers['height.value']).toBeUndefined();
});

it('rejects a new medicine reference using a family collection key or repeated owner', () => {
  const full = createFullReplyManifest(fullCaseContext('G4')), manifest = createReadableManifest(full);
  const raw = encodeReadableDraft(representativeCaseDraft('G4', full), manifest);
  const crossCollection = structuredClone(raw);
  crossCollection.items[0].collectionTarget = 'Q10:familyHistory';
  expect(() => decodeReadableDraft(crossCollection, manifest)).toThrow();
  const repeatedOwner = structuredClone(raw);
  repeatedOwner.claims[0].owner = { subject: 'patient', entity: 'Different medicine' };
  expect(() => decodeReadableDraft(repeatedOwner, manifest)).toThrow();
});

it('requires an issued exact unique source quote for value, predicate, and item anchors', () => {
  const full = createFullReplyManifest(fullCaseContext('G4')), manifest = createReadableManifest(full);
  const raw = encodeReadableDraft(representativeCaseDraft('G4', full), manifest);
  const changed = structuredClone(raw); changed.anchors[0].quote = 'A fabricated medicine report';
  expect(() => decodeReadableDraft(changed, manifest)).toThrow();
  const foreign = structuredClone(raw); foreign.anchors[0].statementId = 'another-patient-statement';
  expect(() => decodeReadableDraft(foreign, manifest)).toThrow();
  const unreferenced = structuredClone(raw); unreferenced.anchors.push({ ...raw.anchors[0], quote: 'Metformin' });
  expect(() => decodeReadableDraft(unreferenced, manifest)).toThrow();
});

it('retains a corrected existing medicine identity and its prior source through store readback', async () => {
  const context = fullCaseContext('G7'), full = createFullReplyManifest(context), manifest = createReadableManifest(full);
  const raw = encodeReadableDraft(representativeCaseDraft('G7', full), manifest);
  expect(raw.items).toHaveLength(0); expect(raw.claims.every(claim => claim.item === null && claim.owner === null)).toBe(true);
  const decoded = decodeReadableDraft(raw, manifest), readback = await fullCaseReadback('G7', { draft: decoded,
    advance: { manifestId: full.id, actionId: full.actions[0].id, controls: [], defer: [] } });
  const list = readback.projection.responses.Q08.answers.medicines;
  expect(list.state).toBe('known');
  if (list.state !== 'known') throw Error('known-list-required');
  expect(list.items).toHaveLength(2);
  const metformin = list.items!.find(item => item.answers.name?.state === 'known' && item.answers.name.value === 'Metformin')!;
  expect(metformin.answers.strength).toMatchObject({ state: 'known', value: '500 mg' });
  expect(readback.projection.provenance.some(entry => entry.path === `medicines[${metformin.id}].strength`
    && entry.sourceIds.includes(context.sources[0].id) && entry.sourceIds.includes(context.source.id))).toBe(true);
  expect(readback.projection.creditedSourceIds).toEqual([]); expect(readback.policyQualified).toBe(false);
});
