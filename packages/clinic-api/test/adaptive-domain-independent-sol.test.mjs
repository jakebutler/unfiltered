import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullCaseContext } from '../../../.stream-domain-build/scripts/qualification/fixtures/adaptive-full-cases.js';
import { domainRepresentativeDraft } from '../../../.stream-domain-build/scripts/qualification/fixtures/adaptive-domain-development.js';
import { createFullReplyManifest, prepareFullNavigation } from '../../../.stream-domain-build/packages/clinic-api/src/adaptive-reply-full.js';
import { createDomainManifest, decodeDomainDraft, decodeDomainAdvance } from '../../../.stream-domain-build/packages/clinic-api/src/adaptive-reply-domain.js';

// Independent offline decoder checks against the pinned emitted candidate.
// No build, model, provider, holdout, or qualification assertion.
const p1 = () => {
  const full = createFullReplyManifest(fullCaseContext('P1'));
  const manifest = createDomainManifest(full);
  return { full, manifest, raw: domainRepresentativeDraft('P1', full, manifest) };
};

test('at most four field reports includes scoped-detail reports', () => {
  const { full, manifest, raw } = p1();
  const scoped = raw.sections.flatMap(group => group.fields).find(report => report.answer.state === 'scoped-detail');
  raw.sections.find(group => group.fields.includes(scoped)).fields.push(structuredClone(scoped));
  assert.equal(raw.sections.flatMap(group => group.fields).length, 5);
  const packet = { manifestId: manifest.id, actionId: full.actions[0].id, controls: [], supplied: raw.sections };
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 8192);
  assert.throws(() => decodeDomainAdvance(packet, manifest));
});

test('scoped-detail validates its issued predicate quote', () => {
  const { manifest, raw } = p1();
  const scoped = raw.sections.flatMap(group => group.fields).find(report => report.answer.state === 'scoped-detail');
  scoped.predicate.quote = 'The source did not contain this predicate.';
  assert.throws(() => decodeDomainDraft(raw, manifest));
});

test('scoped-detail cannot silently discard an unissued correction link', () => {
  const { manifest, raw } = p1();
  raw.sections.flatMap(group => group.fields).find(report => report.answer.state === 'scoped-detail').correctsSourceIds = ['unissued-other-patient-source'];
  assert.throws(() => decodeDomainDraft(raw, manifest));
});

test('an explicitly other-owned closed list cannot become a patient navigation closure', () => {
  const context = fullCaseContext('G3');
  context.source = { ...context.source, text: 'My mother has finished listing her meals.' };
  context.sources = [context.source];
  const full = createFullReplyManifest(context), manifest = createDomainManifest(full);
  const statement = JSON.parse(String(full.messages[1].content)).statements[0];
  const packet = { manifestId: manifest.id, actionId: full.actions.find(action => action.targetPaths.includes('occasions')).id,
    controls: [], supplied: [{ section: 'foodAndDrinkDay', owner: { subject: 'other', entity: 'mother' }, fields: [],
      lists: [{ collection: 'occasions', kind: 'items', items: [], closure: { evidence: [{ statementId: statement.id, quote: statement.text }] } }] }] };
  let advance;
  try { advance = decodeDomainAdvance(packet, manifest); } catch { return; }
  const navigation = prepareFullNavigation(advance, full);
  assert.equal(navigation.closures.length, 0);
  assert.ok(navigation.gaps.length > 0);
});
