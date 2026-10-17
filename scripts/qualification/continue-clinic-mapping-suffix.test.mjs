import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runtime, acquireActors, ownedActorCleanup, writeBudget, successor, validatePrior, validatePlan, sealingModules } from './continue-clinic-mapping-suffix.mjs';
const require = createRequire(import.meta.url), mapping = require('./clinic-native-mapping-v2.cjs'), m = mapping.modules(runtime);
test('actual shared mapper retains typed repeated entries, PHQ and corrected inactive ownership', async () => {
  const { before, after, validSourceIds } = await mapping.controlCaptures(m);
  for (const capture of [before, after]) {
    const qr = await m.toNativeQuestionnaireResponse({ capture, validSourceIds, patient: 'Patient/synthetic', authored: new Date().toISOString(), confirmed: true });
    assert.equal(m.canonicalJson(await m.fromNativeQuestionnaireResponse(qr, validSourceIds)), m.canonicalJson(capture));
    const bad = structuredClone(qr); bad.questionnaire += '-foreign';
    await assert.rejects(() => m.fromNativeQuestionnaireResponse(bad, validSourceIds));
    const forged = structuredClone(capture); forged.definition.digest = '0'.repeat(64);
    await assert.rejects(() => m.validateNativeQuestionnaireCapture(forged, validSourceIds));
  }
  assert.equal(before.topics.Q16.answers.MH01.value, 2);
  assert.equal(after.topics.Q08.answers.medicines.items[1].id, 'm2');
  assert.equal(after.topics.Q15.answers.condition, undefined);
});
test('native mapping roundtrip rejects an actual native answer type mutation', async () => {
  const { before, validSourceIds } = await mapping.controlCaptures(m);
  const qr = await m.toNativeQuestionnaireResponse({ capture: before, validSourceIds, patient: 'Patient/synthetic', authored: new Date().toISOString(), confirmed: true });
  let changed = false;
  const walk = items => { for (const item of items ?? []) { for (const answer of item.answer ?? []) if (!changed && typeof answer.valueInteger === 'number') { answer.valueString = String(answer.valueInteger); delete answer.valueInteger; changed = true; } walk(item.item); } };
  walk(qr.item); assert.equal(changed, true); await assert.rejects(() => m.fromNativeQuestionnaireResponse(qr, validSourceIds));
});
test('complete mapping seam validates actual stored snapshots for seven flows plus both native control versions', async () => {
  const resources = new Map(), receipts = new Map(), journal = [], nativeRef = 'Questionnaire/native/_history/version-1';
  let sequence = 0;
  const client = {
    verifyNativeQuestionnaire: async () => nativeRef,
    check: async confirmation => receipts.get(confirmation.digest),
    versionRead: async (reference, version) => structuredClone(resources.get(reference + '/_history/' + version)),
    deliver: async confirmation => {
      const plan = await m.planHandoff(confirmation, nativeRef), refs = new Map(), receipt = { state: 'received', resources: {}, anchors: {} };
      for (const c of plan.components) { const ref = c.resource.resourceType + '/fixture-' + (++sequence); refs.set(c.fullUrl, ref); receipt.resources[c.key] = ref; }
      for (const c of plan.components) {
        const ref = refs.get(c.fullUrl), value = m.resolvedComponent(plan, c, refs, receipt.anchors);
        const expectedHash = await m.digest(value);
        value.id = ref.split('/')[1]; value.meta = { ...value.meta, versionId: 'version-1' };
        resources.set(ref + '/_history/version-1', value);
        if (c.key.endsWith('.sources') || c.key.endsWith('.response')) { receipt.anchors[c.key.endsWith('.sources') ? 'source' : 'response'] = { reference: ref, version: 'version-1', hash: expectedHash }; refs.set(c.fullUrl, ref + '/_history/version-1'); }
      }
      receipts.set(confirmation.digest, receipt); return { receipt };
    },
  };
  const confirmations = [], now = new Date().toISOString();
  for (const scenario of ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill']) {
    const capture = await m.buildNativeQuestionnaireCapture({ scenario, topics: {}, validSourceIds: new Set(['s1']) });
    const submission = { submissionId: 'qualification-' + scenario, version: 1, patient: 'Patient/synthetic', scenario, contentVersion: 'technical-mapping-test', questionnaire: capture.definition.canonical + '|' + capture.definition.version, confirmedAt: now, completeness: 'partial', sources: [{ id: 's1', patient: 'Patient/synthetic', kind: 'patient-statement', text: 'Synthetic mapping test.', capturedAt: now }], answers: [{ questionId: 'probe', state: 'answered', text: 'Synthetic mapping test.', sourceIds: ['s1'] }], work: [{ id: 'probe', kind: 'clinical', responsibility: 'medical', owner: 'CareTeam/synthetic' }], questionnaireCapture: capture };
    const confirmation = { submission, digest: await m.digest(submission) }; await client.deliver(confirmation); confirmations.push(confirmation);
  }
  assert.equal(await mapping.verify(runtime, { patients: { 'first-intake': { reference: 'Patient/synthetic', careTeams: { medical: 'CareTeam/synthetic' } } } }, client, {}, value => journal.push(value), confirmations), true);
  assert.equal(journal.filter(row => row.nativeMapping).length, 9);
  const last = confirmations.at(-1), qr = resources.get(receipts.get(last.digest).anchors.response.reference + '/_history/version-1'); qr.subject.reference = 'Patient/foreign';
  await assert.rejects(() => mapping.roundtrip(m, client, last, () => {}));
});
test('spacing before every login and cleanup after second login rate limit', async () => {
  let time = 0, count = 0; const dispatches = [], logouts = [], journal = [];
  const users = [{ name: 'one' }, { name: 'two' }];
  await assert.rejects(() => acquireActors(users, () => ({ login: async () => { dispatches.push(time); if (++count === 2) throw Error('try-again-later'); return { cookie: 'session=private' }; }, read: async () => ({}), logout: async () => { logouts.push('logout'); } }), 'https://clinic.example', () => time, async ms => { time += ms; }, row => journal.push(row), { verify: async () => ({ state: 'revoked' }) }));
  assert.deepEqual(dispatches, [15000, 30000]); assert.equal(logouts.length, 1); assert.equal(journal.at(-1).phase, 'native-revocation-confirmed');
});
test('read failure after successful login also cleans acquired cookie and preserves unknown cleanup', async () => {
  let time = 0; const journal = [];
  await assert.rejects(() => acquireActors([{ name: 'one' }], () => ({ login: async () => ({ cookie: 'session=private' }), read: async () => { throw Error('read-failure'); }, logout: async () => { throw Error('logout-network'); } }), 'https://clinic.example', () => time, async ms => { time += ms; }, row => journal.push(row)));
  assert.equal(journal.at(-1).phase, 'logout-or-revocation-unknown');
});
test('successor alters only bounded mapping seams and frozen imports, never sentinel-flips', async () => {
  const original = await readFile(runtime + '/.qualification-build/scripts/qualification/conditional-clinic.js', 'utf8');
  const modified = successor(original, '/reviewed/clinic-native-mapping.cjs');
  assert(modified.includes('mappingConfirmations.push(draft.confirmed.confirmation)'));
  assert(modified.includes('.verify(')); assert(modified.includes('const draft = retainedDrafts[scenario]')); assert(!modified.includes('await fixture(scenario)')); assert(!modified.includes('await h.snapshot(client, draft)')); assert(!modified.includes('await client.deliver(draft.confirmed.confirmation, qualification)')); assert(modified.indexOf('applicationPreMappingChecks') < modified.indexOf('.verify(')); assert(!modified.includes('checks.nativeQuestionnaireMapping = true'));
  assert(!modified.includes('require("../../packages/')); assert.throws(() => successor(original.replace('checks.nativeQuestionnaireMapping = false;', ''), '/reviewed/mapping.cjs'));
});
test('partial old frontier or expired finite continuation cannot dispatch', () => {
  assert.throws(() => validatePrior({ state: 'passed' }));
  assert.throws(() => validatePlan({ schema: 1, allowSyntheticContinuation: true, createdAt: 0, expiresAt: 1 }, 2));
});

test('owned tokens revoke after cookie expiry and partial login failure without reading expired cookie', async () => {
  let time = 0, cookieReads = 0; const revoked = [], journal = [];
  const owned = ownedActorCleanup(async token => revoked.push(token), async () => ({ state: 'revoked' }), row => journal.push(row), () => {});
  await assert.rejects(() => acquireActors([{ name: 'one' }, { name: 'two' }], () => ({
    login: async (_email, _password) => {
      const actor = cookieReads === 0 ? 'one' : 'two'; owned.intent(actor); owned.issued(actor, actor + '-private-token');
      if (actor === 'two') throw Error('auth-me-failed-after-token');
      return { cookie: 'session=private' };
    },
    read: async () => { time += 2_000_000; return {}; },
    logout: async () => { throw Error('must-not-read-expired-cookie'); },
  }), 'https://clinic.example', () => time, async ms => { time += ms; }, () => {}, {
    capture: async (_request, actor) => { cookieReads++; owned.capture(actor, actor + '-private-token'); }, cleanupAll: () => owned.cleanup(),
  }));
  assert.equal(cookieReads, 1); assert.deepEqual(revoked, ['one-private-token', 'two-private-token']);
  assert.equal(await owned.cleanup(), true); assert.equal(revoked.length, 2); assert(!JSON.stringify(journal).includes('private-token'));
});
test('unknown issuance or failed revocation withholds pass and never replays logout', async () => {
  let logouts = 0;
  const owned = ownedActorCleanup(async () => { logouts++; }, async () => { throw Error('unknown'); }, () => {}, () => {});
  owned.intent('one'); owned.issued('one', 'runtime-only'); owned.intent('two');
  assert.equal(await owned.cleanup(), false); assert.equal(await owned.cleanup(), false); assert.equal(logouts, 1);
});
test('deterministic finite native write bound includes rejected/concurrent/lost writes', () => {
  assert.equal(writeBudget.freshStorage, 27); assert.equal(writeBudget.application, 31); assert.equal(writeBudget.mappingControls, 8);
  assert.equal(Object.values(writeBudget).slice(0, 3).reduce((a, b) => a + b, 0), writeBudget.total);
});

test('retained actual a2 native QR verifies exact immutable source history without weakening typed equality', async () => {
  const base = runtime + '/../../../../infra/cloud/.private/clinic-q4f-continuation-20261010-a2/';
  const evidence = JSON.parse(await readFile(base + 'clinic-config.qualified.json.evidence.json'));
  const qr = JSON.parse(await readFile(base + 'mapping-diagnostic-native-qr.private.json'));
  const intent = evidence.applicationFixtures.find(row => row.scenario === 'first-intake' && row.draft);
  const receiptRow = evidence.applicationFixtures.find(row => row.scenario === 'first-intake' && row.delivery);
  const receipt = { ...receiptRow, state: receiptRow.delivery };
  const native = qr.resourceType === 'QuestionnaireResponse' ? qr : qr.resource;
  assert.equal(native.resourceType, 'QuestionnaireResponse');
  const client = { verifyNativeQuestionnaire: async () => native.extension.find(row => row.url.endsWith('/questionnaire-resource')).valueReference.reference, check: async () => receipt, versionRead: async () => structuredClone(native) };
  await mapping.roundtrip(m, client, intent.draft.confirmed.confirmation, () => {});
  const changed = structuredClone(native); changed.subject.reference = 'Patient/foreign';
  await assert.rejects(() => mapping.roundtrip(m, { ...client, versionRead: async () => changed }, intent.draft.confirmed.confirmation, () => {}));
});

test('actual a2 frontier retains all seven immutable intents and refuses missing confirmations/check provenance', async () => {
  const evidence = JSON.parse(await readFile(runtime + '/../../../../infra/cloud/.private/clinic-q4f-continuation-20261010-a2/clinic-config.qualified.json.evidence.json'));
  assert.equal(Object.keys(validatePrior(evidence)).length, 7);
  const wrong = structuredClone(evidence); wrong.applicationFixtures.pop(); assert.throws(() => validatePrior(wrong));
  const dirty = structuredClone(evidence); dirty.actorCleanupComplete = false; assert.throws(() => validatePrior(dirty));
});

test('schema-3 continuation needs no admin feature file and pins the current-source sealer', () => {
  const now = 1_000_000, pin = 'a'.repeat(64);
  const plan = { schema: 1, allowSyntheticContinuation: true, preparationSha256: pin, createdAt: now - 1000, expiresAt: now + 60_000, loginSpacingMs: 15_000, cleanupRequests: 8, cleanupDeadlineMs: 90_000, maxRequests: 1600, maxFhirWrites: 200, paths: { config: 'c', users: 'u', priorEvidence: 'p' }, pins: { config: pin, users: pin, priorEvidence: 'b'.repeat(64) }, output: 'o' };
  assert.throws(() => validatePlan(plan, now), /prior-output-scope-invalid/); // reaches the prior pin check without any `features` input
  assert.throws(() => validatePlan({ ...plan, paths: { config: 'c', users: 'u' } }, now), /private-input-pin-required/);
  assert.deepEqual([...sealingModules], ['packages/clinic-api/src/deployment-qualification.js', 'packages/clinic-api/src/runtime.js']);
});
