/** Synthetic native qualification seam; invokes only exact frozen Q4f modules supplied by root. */
const path = require('node:path');
function modules(runtime) {
  const base = path.join(runtime, '.qualification-build');
  return { ...require(path.join(base, 'packages/clinical-core/src/domain.js')), ...require(path.join(base, 'packages/clinical-core/src/fhir.js')), ...require(path.join(base, 'packages/clinical-core/src/questionnaire-response.js')), ...require(path.join(base, 'packages/clinic-content/src/native-questionnaire.js')), ...require(path.join(base, 'packages/clinic-content/src/mental-health.js')) };
}
const known = (value, sourceIds = ['mapping-s1']) => ({ state: 'known', value, sourceIds });
const topic = answers => ({ presented: true, answers });
async function controlCaptures(m) {
  const validSourceIds = new Set(['mapping-s1', 'mapping-s2']);
  const topics = {
    Q04: topic({ 'height.value': known({ feet: 5, inches: 9 }), 'height.unit': known('ft-in'), 'lastMeasuredWeight.value': known(200), 'lastMeasuredWeight.unit': known('lb'), 'lastMeasuredWeight.measuredWhen': known('last month'), 'lastMeasuredWeight.datePrecision': known('approximate'), 'lastMeasuredWeight.representsCurrent': known(true) }),
    Q06: topic({ 'conditions.diabetes': { state: 'negative', sourceIds: ['mapping-s1'] }, 'conditions.sleepApnea': known(true) }),
    Q07: topic({ events: { state: 'known', complete: true, sourceIds: ['mapping-s1'], items: [{ id: 'surgery-1', answers: { event: known('reported surgery'), effects: known('Since surgery I still cannot tolerate eating solid food now.') } }] } }),
    Q08: topic({ medicines: { state: 'known', complete: true, sourceIds: ['mapping-s1'], items: [{ id: 'm1', answers: { name: known('first medicine'), strength: known('5 mg') } }, { id: 'm2', answers: { name: known('second medicine'), strength: { state: 'unknown', sourceIds: ['mapping-s1'] } } }] } }),
    Q15: topic({ schedule: known('reported schedule'), quality: known('reported quality') }),
    Q16: topic({ MH01: known(2), MH02: known(1), MH03: known(0), MH04: known(0) }),
  };
  const before = await m.buildNativeQuestionnaireCapture({ scenario: 'first-intake', topics, validSourceIds, context: m.deriveNativeRoutingContext(topics, { validSourceIds }) });
  const corrected = { ...before.topics, Q06: topic({ 'conditions.diabetes': { state: 'negative', sourceIds: ['mapping-s1'] }, 'conditions.sleepApnea': { state: 'negative', sourceIds: ['mapping-s2'] } }), Q07: topic({ events: { state: 'negative', sourceIds: ['mapping-s2'] } }) };
  const after = await m.buildNativeQuestionnaireCapture({ scenario: 'first-intake', topics: corrected, validSourceIds, context: m.deriveNativeRoutingContext(corrected, { validSourceIds }), inactiveHistory: before.inactiveHistory });
  if (before.topics.Q15?.answers.condition?.value !== 'sleep apnea' || !before.topics.GI?.answers.effect || after.topics.Q15?.answers.condition || after.topics.GI?.answers.effect || !after.inactiveHistory.some(row => row.path === 'condition') || !after.inactiveHistory.some(row => row.path === 'effect')) throw Error('native-mapping-correction-applicability-control-failed');
  const scores = m.scorePhq4(before.topics.Q16.answers, { validSourceIds, confirmedItemIds: new Set(['MH01', 'MH02', 'MH03', 'MH04']), completedAt: new Date().toISOString() }).scores;
  if (m.canonicalJson(scores) !== m.canonicalJson({ gad2: 3, phq2: 0, phq4: 3 }) || before.topics.Q08.answers.medicines.items.length !== 2 || m.canonicalJson(after.topics.Q08) !== m.canonicalJson(before.topics.Q08)) throw Error('native-mapping-phq-repeat-control-failed');
  return { before, after, validSourceIds };
}
async function roundtrip(m, client, confirmation, journal) {
  const nativeReference = await client.verifyNativeQuestionnaire();
  const receipt = await client.check(confirmation);
  if (receipt.state !== 'received' || !confirmation.submission.questionnaireCapture) throw Error('native-mapping-confirmed-receipt-required');
  const qr = await client.versionRead(receipt.anchors.response.reference, receipt.anchors.response.version);
  const plan = await m.planHandoff(confirmation, nativeReference), refs = new Map(plan.components.map(c => [c.fullUrl, receipt.resources[c.key]]));
  const component = plan.components.find(c => c.resource.resourceType === 'QuestionnaireResponse');
  const expected = m.resolvedComponent(plan, component, refs, receipt.anchors);
  const validSources = new Set(confirmation.submission.sources.filter(s => s.kind !== 'assistant-statement').map(s => s.id));
  const decoded = await m.fromNativeQuestionnaireResponse(qr, validSources);
  if (!m.verifyComponent(expected, qr) || m.canonicalJson(decoded) !== m.canonicalJson(confirmation.submission.questionnaireCapture) || qr.subject.reference !== confirmation.submission.patient) throw Error('native-mapping-roundtrip-mismatch');
  journal({ nativeMapping: { scenario: confirmation.submission.scenario, submissionId: confirmation.submission.submissionId, version: confirmation.submission.version, confirmationDigest: confirmation.digest, questionnaireReference: nativeReference, response: receipt.anchors.response, captureDigest: await m.digest(decoded), typedRoundtrip: true } });
  return decoded;
}
async function verify(runtime, config, client, qualification, journal, confirmations) {
  const m = modules(runtime), scenarios = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'];
  if (confirmations.length !== 7 || scenarios.some(s => confirmations.filter(c => c.submission.scenario === s).length !== 1)) throw Error('native-mapping-seven-actual-workflows-required');
  for (const c of confirmations) await roundtrip(m, client, c, journal);
  const { before, after } = await controlCaptures(m), id = `qualification-mapping-${crypto.randomUUID()}`, now = new Date().toISOString();
  const patient = config.patients['first-intake'];
  await new Promise(resolve => setTimeout(resolve, 2));
  const correctionAt = new Date().toISOString();
  const sources = [{ id: 'mapping-s1', patient: patient.reference, kind: 'patient-statement', text: 'Synthetic mapping control: height five feet nine inches, measured weight 200 lb last month approximately, still represents current weight, no diabetes, reported sleep apnea; reported surgery: Since surgery I still cannot tolerate eating solid food now.; reported schedule and reported quality; first medicine 5 mg, second strength unknown; PHQ choices 2, 1, 0, 0.', capturedAt: now, channel: 'text' }, { id: 'mapping-s2', patient: patient.reference, kind: 'patient-correction', text: 'Synthetic correction: no sleep apnea and no surgery. Keep the two medicine entries and PHQ choices.', capturedAt: correctionAt, channel: 'text', corrects: 'mapping-s1' }];
  let previous;
  for (const [index, capture] of [before, after].entries()) {
    const submission = { submissionId: id, version: index + 1, patient: patient.reference, scenario: 'first-intake', contentVersion: 'technical-native-mapping-probe', questionnaire: `${capture.definition.canonical}|${capture.definition.version}`, confirmedAt: index ? correctionAt : now, completeness: 'partial', sources: index ? sources : sources.slice(0, 1), answers: [{ questionId: 'probe', state: 'answered', text: 'Synthetic typed mapping control only.', sourceIds: [index ? 'mapping-s2' : 'mapping-s1'] }], work: [{ id: 'probe', kind: 'clinical', responsibility: 'medical', owner: patient.careTeams.medical }], questionnaireCapture: capture, ...(previous ? { previous: { submissionId: id, version: 1, digest: previous.digest } } : {}) };
    const confirmation = { submission, digest: await m.digest(submission) };
    journal({ nativeMappingControlIntent: { submissionId: id, version: submission.version, digest: confirmation.digest, capturedAt: submission.confirmedAt, confirmation } });
    const result = await client.deliver(confirmation, qualification);
    if (result.receipt.state !== 'received') throw Error('native-mapping-control-delivery-unresolved');
    const decoded = await roundtrip(m, client, confirmation, journal);
    if (index && (decoded.topics.Q15?.answers.condition || decoded.topics.GI?.answers.effect || decoded.topics.Q08.answers.medicines.items.length !== 2)) throw Error('native-mapping-native-correction-control-failed');
    if (!index) previous = confirmation;
  }
  journal({ nativeMappingQualified: { workflows: 7, nativeControlVersions: 2, repeatedOwnership: true, phqTypedChoices: true, correctionApplicability: true, historicalQuestionnaireBinding: true, actualNativeRoundtrips: 9 } });
  return true;
}
module.exports = { modules, controlCaptures, roundtrip, verify };
