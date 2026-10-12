import { typedCaptureBound } from './provisional-draft.js';
import { prepareFinalRepresentation, type FinalRepresentationQualification } from './final-representation.js';
import { nativeRepresentationAuthority, type TrustedRepresentationAuthority } from '../../clinical-core/src/representation-review.js';
import { buildNativeQuestionnaireCapture, projectNativeQuestionnaireState } from '../../clinical-core/src/questionnaire-response.js';
import { nativeCaptureComplete, nativeTopics, nativeScenarioTopics, nativeRoutingDecisions, deriveNativeRoutingContext, nextNativeGuidedField, guardNativePrompt, NATIVE_QUESTIONNAIRE_CANONICAL, NATIVE_QUESTIONNAIRE_VERSION, type NativeRoutingContext } from '../../clinic-content/src/native-questionnaire.js';
import { administrativeLogisticsSchema, type AdministrativeLogistics } from '../../clinical-core/src/domain.js';
import { streamSpeechScopeDigest } from './adaptive-stream-session.js';
import { choiceConfirmationSpeech, exactSpokenChoice, exactChoiceConfirmation } from '../../clinic-contract/src/choice-voice.js';
import { scorePhq4, scenarioTopics, guidedFieldForPath, aggregateTargets, applyGuidedAnswer, addCollectionItem, finishCollection, createClinicContent, diabetesBranchApplicability, evaluateTopic, nextGuidedField, parseGuidedValue, mentalHealthOptions, type GuidedField, type TopicDefinition, type TopicResponse, type SlotAnswer, type SlotAnswers, type SlotDefinition } from '../../clinic-content/src/index.js';
import { canonicalJson, digest, confirmSubmission, unresolvedRecognitionSourceIds, type ContentContract, type Submission, type SufficiencyAssessment } from '../../clinical-core/src/domain.js';
import { conversationSpeech } from '../../clinic-contract/src/index.js';
import type { ClinicSessionView, PromptView, TopicView, TurnInput, ScenarioId, SourceSpan } from '../../clinic-contract/src/index.js';
import { escalation, escalationCopy } from './safety.js';
import { screenSafety } from './safety-screen.js';
import { ApiFailure, type Draft, type ClinicApiConfig } from './types.js';
import { adaptiveView, requireNoPendingInterpretation } from './adaptive-session.js';
import { scopedQuestion } from './dialogue.js';
import { interpretationReview } from './interpretation-review.js';
import { projectProvisional, policyQualified, focusedPolicyRevision, typedPolicyRevision, type ProvisionalQualification } from './provisional-projection.js';
export const scenarioTitles: Record<ScenarioId, string> = { 'first-intake': 'First visit intake', 'pre-visit': 'Before your visit', 'non-visit': 'Check in with your care team', 'post-visit': 'After your visit', billing: 'Billing help', scheduling: 'Scheduling help', refill: 'Prescription refill request' };
const choiceLabels: Record<string, string> = { 'bill-question': 'A bill question', 'coverage-question': 'A coverage question', 'payment-question': 'A payment question', 'other-request': 'Another billing request', explanation: 'An explanation', 'review-possible-error': 'Review a possible error', 'payment-options': 'Discuss payment options', 'contact-me': 'Contact me', 'first-visit': 'First visit', 'follow-up': 'Follow-up visit', 'not-sure': 'Not sure', 'America/New_York': 'Eastern time', 'America/Chicago': 'Central time', 'America/Denver': 'Mountain time', 'America/Los_Angeles': 'Pacific time', 'America/Anchorage': 'Alaska time', 'Pacific/Honolulu': 'Hawaii time' };
const titles: Record<string, string> = { Q01: 'Your priorities', Q02: 'Current symptoms', Q03: 'Weight through your life', Q04: 'Height and weight', Q05: 'Prior approaches', Q06: 'Medical conditions', Q07: 'Surgery and hospital care', Q08: 'Medicines and supplements', Q09: 'Allergies and reactions', Q10: 'Family history', Q11: 'A day of food and drink', Q12: 'Eating concerns', Q13: 'Access to food', Q14: 'Movement and function', Q15: 'Sleep', Q16: 'Mood, anxiety and support', Q17: 'Substance use', Q18: 'Pregnancy and reproductive context', Q19: 'Care team and records', Q20: 'Access to care', Q21: 'Communication preferences', Q22: 'Other questions', DM: 'Diabetes and prediabetes' };
function detailProvenance(d: Draft, topicId: string, path: string, sourceIds: string[]): SourceSpan[] {
    return Object.values(d.adaptive?.operations ?? {}).flatMap(op => op.provenance ?? []).filter(p => p.topicId === topicId && p.path === path).flatMap(p => {
        const selected = p.evidence.filter(span => sourceIds.includes(span.sourceId));
        if (!p.evidenceProtocol) return selected.map(span => ({ ...span, transform: p.transform }));
        const role = p.valueEvidence ? 'value' as const : 'support' as const;
        const support = (p.supportEvidence ?? []).filter(span => sourceIds.includes(span.sourceId) && (role === 'value' || !selected.some(entry => entry.sourceId === span.sourceId && entry.start === span.start && entry.end === span.end)));
        return [...selected.map(span => ({ ...span, transform: p.transform, role, evidenceProtocol: p.evidenceProtocol })), ...support.map(span => ({ ...span, transform: p.transform, role: 'support' as const, evidenceProtocol: p.evidenceProtocol }))];
    });
}
export function conversation(config: ClinicApiConfig, options: { provisionalQualification?: ProvisionalQualification; finalRepresentationQualification?: FinalRepresentationQualification } = {}) {
    const register = createClinicContent({ mentalHealth: config.mentalHealth });
    const native = config.mentalHealth === 'phq4';
    const nativeContext = (d: Draft): NativeRoutingContext | undefined => native ? deriveNativeRoutingContext(d.topics, { validSourceIds: new Set(d.turns.filter(t => t.role === 'patient' && t.channel !== 'unreviewed-transcript').map(t => t.id)) }, config.patients[d.scenario].nativeContext) : undefined;
    const evidence = (d: Draft) => ({ validSourceIds: new Set(d.turns.filter(t => t.role === 'patient').map(t => t.id)) });
    const focusedQualified = policyQualified(options.provisionalQualification, focusedPolicyRevision);
    const typedQualified = policyQualified(options.provisionalQualification, typedPolicyRevision);
    const qualified = policyQualified(options.provisionalQualification) || focusedQualified || typedQualified;
    const projectionOptions = { qualified, ...(typedQualified ? { qualificationProfile: 'turn-bound-typed-v1' as const } : focusedQualified ? { qualificationProfile: 'source-first-focused-v1' as const } : {}) };
    function captureDefinitions(d: Draft): TopicDefinition[] {
        const scenario = register.scenarios[d.scenario];
        const all = native ? nativeTopics(register) : [...register.topics, ...Object.values(register.branches).map(branch => branch.topic), ...scenario.additionalTopics];
        return all.filter(topic => scenario.additionalTopics.some(t => t.id === topic.id) || scenario.reusableTopicIds.includes(topic.id as never) || ['DM', 'SLEEP', 'GI'].includes(topic.id));
    }
    function effective(d: Draft, readiness = false) {
        const projected = projectProvisional(d, captureDefinitions(d), { ...projectionOptions, readinessOnly: readiness });
        const readinessProjection = readiness ? projected : projectProvisional(d, captureDefinitions(d), { ...projectionOptions, readinessOnly: true });
        if (native) {
          for (const decision of nativeRoutingDecisions({ topics: qualified ? readinessProjection.responses as Record<string, TopicResponse> : d.topics, context: nativeContext(d) }, evidence(d))) {
            const id = ({ 'branch.diabetes': 'DM', 'branch.sleep-apnea': 'SLEEP', 'branch.digestive': 'GI' } as Record<string, string>)[decision.ruleId];
            if (id) projected.responses[id] = { ...(projected.responses[id] ?? { presented: false, answers: {} }), applicability: decision.outcome, applicabilitySourceIds: decision.sourceIds };
          }
        }
        if (!readiness || qualified) return projected;
        const responses = structuredClone(d.topics);
        for (const id of (native ? ['DM', 'SLEEP', 'GI'] : Object.values(register.branches).map(branch => branch.topic.id))) if (projected.responses[id]?.applicability) responses[id] = { ...(responses[id] ?? { presented: false, answers: {} }), applicability: projected.responses[id].applicability, applicabilitySourceIds: projected.responses[id].applicabilitySourceIds };
        return { ...projected, responses, creditedSourceIds: new Set<string>() };
    }
    /** Shared server-owned prompt guard inputs for planning and saved/resumed view. */
    function nativeNavigation(d: Draft) {
        return native ? { topics: effective(d, true).responses as Record<string, TopicResponse>,
            repeatResolutionTopics: effective(d).responses as Record<string, TopicResponse>,
            relevantTopicIds: effectiveRelevantTopicIds(d), context: nativeContext(d) } : undefined;
    }
    const response = (d: Draft, id: string): TopicResponse => effective(d, true).responses[id] ?? { presented: false, answers: {} };
    /** Only selected or admitted readiness evidence can make a reusable topic relevant.
     * The extraction catalog alone and unqualified provisional claims confer no relevance. */
    function effectiveRelevantTopicIds(d: Draft): import('../../clinic-content/src/types.js').TopicId[] {
        const responses = effective(d, true).responses, reusable = register.scenarios[d.scenario].reusableTopicIds;
        return [...new Set([...(d.relevantTopicIds ?? []), ...Object.keys(responses).filter(id => responses[id]?.presented)])]
            .filter(id => reusable.includes(id as never) && (id !== 'Q18' || d.relevantTopicIds?.includes(id) || !!nativeContext(d)?.reproductive)) as import('../../clinic-content/src/types.js').TopicId[];
    }
    function definitions(d: Draft): TopicDefinition[] {
        const projection = effective(d, true), relevant = effectiveRelevantTopicIds(d);
        const selected = [...(native ? nativeScenarioTopics : scenarioTopics)(register, d.scenario, { relevantTopicIds: relevant as import('../../clinic-content/src/types.js').TopicId[], responses: projection.responses, evidence: evidence(d), ...(native ? { context: nativeContext(d) } : {}) })];
        return selected.map(t => t.id === 'Q18' && !d.relevantTopicIds?.includes('Q18') && !nativeContext(d)?.reproductive ? { ...t, presentation: 'O' as const } : t);
    }
    function topicResponse(d: Draft, t: TopicDefinition): TopicResponse { const r = response(d, t.id); return t.presentation === 'C' && t.id !== 'Q18' && !r.applicability ? { ...r, applicability: 'applicable' } : r; }
    function fieldAt(t: TopicDefinition, r: TopicResponse, path: string): GuidedField { const field = guidedFieldForPath(t, r, path); if (field.kind === 'configuration' || !field.promptIds.length)
        throw new ApiFailure('detail-not-editable', 400); return field; }
    /** Patients see that a clinician will read flagged words, never the reviewer's assessment. Unreviewed counts as flagged. */
    function safetyReviewTopics(d: Draft): TopicView[] {
        const flagged = (d.safetySignals ?? []).filter(signal => signal.review?.status !== 'cleared');
        if (!flagged.length) return [];
        return [{ id: 'SAFETY-REVIEW', title: 'Clinician safety review', required: false, status: 'stopped-with-gaps', missingDetails: ['A clinician will read part of what you shared'],
            answer: { text: 'Part of what you shared was flagged for a clinician to read. This is a routine safety check, not a diagnosis.', state: 'answered', sourceIds: [...new Set(flagged.map(signal => signal.sourceId))] } }];
    }
    function synchronize(d: Draft): Draft {
        if (!native) return d;
        // A direct edit inside a provisional list item is routed with that item's provisional anchors
        // (foods enables foodAmounts); the borrowed anchors are removed again and never become direct answers.
        const borrowed: { topicId: string; collection: string; itemId: string; field: string }[] = [];
        type ListView = { state: string; items?: { id: string; answers: Record<string, unknown> }[] } | undefined;
        const routed = structuredClone(d.topics) as unknown as Record<string, { answers: Record<string, ListView> } | undefined>;
        const lists = (topics: typeof routed) => Object.entries(topics).flatMap(([topicId, topic]) => Object.entries(topic?.answers ?? {}).flatMap(([collection, answer]) => answer?.state === 'known' && answer.items?.length ? [{ topicId, collection, items: answer.items }] : []));
        if (lists(routed).length) {
            const provisional = effective(d).responses as unknown as typeof routed;
            for (const { topicId, collection, items } of lists(routed)) {
                const projectedList = provisional[topicId]?.answers[collection];
                for (const item of items) {
                    const source = projectedList?.state === 'known' ? projectedList.items?.find(candidate => candidate.id === item.id) : undefined;
                    for (const [field, value] of Object.entries(source?.answers ?? {})) if (!item.answers[field]) {
                        item.answers[field] = value;
                        borrowed.push({ topicId, collection, itemId: item.id, field });
                    }
                }
            }
        }
        const projected = projectNativeQuestionnaireState({ topics: borrowed.length ? routed as unknown as Draft['topics'] : d.topics, context: nativeContext(d), inactiveHistory: d.questionnaireHistory, unreviewedSourceIds: unresolvedRecognitionSourceIds(d.turns.filter(turn => turn.role === 'patient').map(turn => ({ id: turn.id, patient: d.patient, kind: turn.corrects ? 'patient-correction' as const : 'patient-statement' as const, text: turn.text, capturedAt: turn.at, ...(turn.channel ? { channel: turn.channel } : {}), ...(turn.corrects ? { corrects: turn.corrects } : {}), ...(turn.displayedPromptId ? { displayedPromptId: turn.displayedPromptId } : {}) })), d.topics) }, evidence(d).validSourceIds);
        const isBorrowed = (topicId: string, path: string) => borrowed.some(b => b.topicId === topicId && path === `${b.collection}[${b.itemId}].${b.field}`);
        for (const b of borrowed) {
            const list = (projected.topics as unknown as typeof routed)[b.topicId]?.answers[b.collection], item = list?.state === 'known' ? list.items?.find(candidate => candidate.id === b.itemId) : undefined;
            if (item) delete item.answers[b.field];
        }
        d.topics = projected.topics; d.questionnaireHistory = projected.inactiveHistory.filter(entry => !isBorrowed(entry.topicId, entry.path));
        return d;
    }
    function current(d: Draft): {
        topic: TopicDefinition;
        field: GuidedField;
    } | undefined {
        if (d.phase === 'confirmed' || d.phase === 'review' || d.safety?.paused)
            return;
        const instrument = d.adaptive?.mode === 'adaptive' && d.adaptive.exchange?.prompt?.kind === 'instrument' ? d.adaptive.exchange.prompt : undefined;
        const activeTopic = d.activeTopic ?? instrument?.topicId;
        const activeSlot = d.activeSlot ?? instrument?.targetPaths[0];
        const defs = definitions(d);
        if (activeTopic && !defs.some(topic => topic.id === activeTopic)) { const selected = captureDefinitions(d).find(topic => topic.id === activeTopic); if (selected) defs.unshift(selected); }
        const ordered = activeTopic ? [...defs.filter(t => t.id === activeTopic), ...defs.filter(t => t.id !== activeTopic)] : defs;
        for (const topic of ordered) {
            if (topic.id === 'Q18' && !d.relevantTopicIds?.includes('Q18') && !nativeContext(d)?.reproductive)
                continue;
            if (d.adaptive?.mode === 'adaptive' && topic.id !== activeTopic && d.adaptive.parkedTopicIds?.includes(topic.id))
                continue;
            const r = topicResponse(d, topic);
            if (topic.id === 'Q18' && !r.presented)
                return { topic, field: { path: '__applicability', label: 'Is this topic relevant for your clinician to consider?', kind: 'choice', choices: ['__applicable', '__topic-not-applicable'], promptIds: ['Q18'], acceptsNegative: false, acceptsNotApplicable: false, action: 'answer', allowedStates: ['known', 'unknown', 'declined'] } };
            const field = activeTopic === topic.id && activeSlot ? fieldAt(topic, r, activeSlot) : native ? nextNativeGuidedField(topic, r, evidence(d), { topics: effective(d, true).responses as Record<string, TopicResponse>, context: nativeContext(d) }) : nextGuidedField(topic, r, evidence(d));
            if (field)
                return { topic, field };
        }
    }
    function prompt(d: Draft): PromptView | undefined {
        const c = current(d);
        if (!c)
            return;
        const { topic, field } = c;
        let text = register.promptsById[field.promptIds[0]]?.text ?? field.label;
        const selectedPromptId = native && topic.id === 'W02' && field.promptIds[0] === 'S01' && !nativeContext(d)?.appointment ? 'S01a' : native && topic.id === 'W04' && field.promptIds[0] === 'S03' && !nativeContext(d)?.plan ? 'S03a' : field.promptIds[0];
        text = register.promptsById[selectedPromptId]?.text ?? text;
        const verifiedContext = nativeContext(d);
        if (selectedPromptId === 'S01' && verifiedContext?.appointment) text = text.replace('[verified date/time/timezone]', `${verifiedContext.appointment.startsAt} ${verifiedContext.appointment.timezone}`).replace('[dated prior update]', verifiedContext.appointment.priorUpdateAt);
        if (selectedPromptId === 'S03' && verifiedContext?.plan) text = text.replace('[demo author/role]', verifiedContext.plan.author).replace('[date]', verifiedContext.plan.recordedAt);
        if (native && field.path !== '__applicability' && !/^MH0[1-4]$/.test(field.path)) {
            const readiness = evaluateTopic(topic, topicResponse(d, topic), evidence(d));
            const alreadySatisfied = readiness.slots.some(slot => slot.id !== field.path && slot.state === 'sufficient' && slot.promptIds.includes(selectedPromptId));
            if (alreadySatisfied || field.path.includes('].')) text = scopedQuestion(topic, topicResponse(d, topic), [field.path]) ?? text;
        }
        if (native) guardNativePrompt({ promptId: selectedPromptId, topicId: topic.id, ...(field.path !== '__applicability' ? { path: field.path } : {}), text, scenario: d.scenario, relevantTopicIds: effectiveRelevantTopicIds(d), topics: effective(d, true).responses as Record<string, TopicResponse>, context: nativeContext(d) }, evidence(d));
        const mh = /^MH0[1-4]$/.test(field.path);
        if (mh)
            text = `${register.promptsById['MH.stem'].text}\n${text}`;
        const choices: NonNullable<PromptView['choices']> = [];
        if (field.kind === 'collection') {
            choices.push({ value: '__add', label: field.action === 'finish-or-add' ? 'Add another item' : 'Add an item' });
            if (field.action === 'finish-or-add')
                choices.push({ value: '__done', label: 'Finished listing' });
        }
        else if (field.kind === 'presence')
            choices.push({ value: 'true', label: 'Yes' }, { value: '__uncertain', label: 'Not sure whether I was diagnosed' });
        else if (field.choices)
            choices.push(...field.choices.map(v => ({ value: String(v), label: choiceLabels[String(v)] ?? (v === '__applicable' ? 'Relevant — continue' : v === '__topic-not-applicable' ? 'Not applicable' : mh ? mentalHealthOptions.phq4.choices.find(x => x.value === v)!.label : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)) })));
        if (field.acceptsNegative)
            choices.push({ value: '__negative', label: 'None / no' });
        if (field.acceptsNotApplicable)
            choices.push({ value: '__not-applicable', label: 'Not applicable' });
        return { id: `${topic.id}:${field.path}`, topicId: topic.id, text, mode: 'guided', purpose: field.label, ...(choices.length ? { choices } : {}), ...(field.kind === 'height-value' ? { fields: [{ id: 'value', label: 'Height as one value (cm, metres, inches or feet)', kind: 'number' as const, required: false }, { id: 'feet', label: 'Or feet', kind: 'number' as const, required: false }, { id: 'inches', label: 'And inches', kind: 'number' as const, required: false }] } : {}) };
    }
    const state = (a: SlotAnswer | undefined): NonNullable<TopicView['answer']>['state'] => !a || a.state === 'not-asked' ? 'not-asked' : a.state === 'known' ? 'answered' : a.state === 'not-applicable' ? 'negative' : a.state === 'skipped' ? 'declined' : a.state;
    function rows(defs: readonly SlotDefinition[], answers: SlotAnswers, prefix = ''): {
        id: string;
        label: string;
        state: NonNullable<TopicView['answer']>['state'];
        text?: string;
        sourceIds: string[];
        editable: boolean;
    }[] {
        return defs.flatMap(s => { const a = answers[s.id], id = prefix + s.id; const text = a?.state === 'known' ? a.items ? `${a.items.length} item(s)${a.complete ? ' — list finished' : ' — list open'}` : typeof a.value === 'object' ? `${a.value.feet} ft ${a.value.inches} in` : String(a.value) : a && a.state !== 'not-asked' ? (a.note ?? a.state) : undefined; return [{ id, label: s.label, state: state(a), text, sourceIds: [...(a?.sourceIds ?? [])], editable: s.promptIds.length > 0 && s.kind !== 'configuration' }, ...(a?.state === 'known' && a.items ? a.items.flatMap(item => rows(s.fields ?? [], item.answers, `${id}[${item.id}].`)) : [])]; });
    }
    function screenContext(d: Draft, r: TopicResponse) {
        const itemIds = ['MH01', 'MH02', 'MH03', 'MH04'];
        const sourceIds = new Set(itemIds.flatMap(id => r.answers[id]?.sourceIds ?? []));
        // Completion belongs to the latest cited screening answer, not a later
        // review save, receipt refresh or unrelated correction.
        const sources = d.turns.filter(turn => turn.role === 'patient' && sourceIds.has(turn.id) && Number.isFinite(Date.parse(turn.at)));
        const last = sources.reduce<(typeof sources)[number] | undefined>((latest, turn) => !latest || Date.parse(turn.at) > Date.parse(latest.at) ? turn : latest, undefined);
        return { ...evidence(d), confirmedItemIds: new Set(itemIds), completedAt: last?.at ?? '' };
    }
    function screenText(d: Draft, t: TopicDefinition, r: TopicResponse): string { if (t.id !== 'Q16' || config.mentalHealth !== 'phq4')
        return ''; const screen = scorePhq4(r.answers, screenContext(d, r)); return screen.status === 'complete' ? `\nPHQ-4: ${screen.scores.phq4}; GAD-2: ${screen.scores.gad2}; PHQ-2: ${screen.scores.phq2}. ${screen.furtherAssessmentRequested ? 'Further clinician assessment requested. ' : ''}Clinician review required. This is not a diagnosis or clinical clearance.` : '\nPHQ-4 screen incomplete — no score calculated. Clinician review required.'; }
    function unresolvedSources(d: Draft) {
        const credited = effective(d, true).creditedSourceIds;
        return (adaptiveView(d, true).unresolvedSources ?? []).filter(source => !credited.has(source.sourceId));
    }
    function topics(d: Draft): TopicView[] {
        const projected = effective(d), required = definitions(d), requiredIds = new Set(required.map(topic => topic.id));
        const admittedSources = new Set(Object.values(d.adaptive?.operations ?? {}).filter(op => op.status === 'applied' && op.stream?.capture === 'saved' && typedCaptureBound(d,op) && op.stream.provisional?.policy === options.provisionalQualification?.policy && (op.stream.provisional?.interpretationProfile ?? op.stream.sourceInterpretation?.protocol) === (typedQualified ? 'turn-bound-typed-v1' : focusedQualified ? 'source-first-focused-v1' : undefined)).map(op => op.sourceId));
        const shown = [...required, ...captureDefinitions(d).filter(topic => !requiredIds.has(topic.id) && projected.claims.some(claim => claim.topicId === topic.id && claim.status !== 'superseded'))];
        return shown.map(t => {
            const r = projected.responses[t.id] ?? { presented: false, answers: {} }, ready = evaluateTopic(t, topicResponse(d, t), evidence(d));
            const details = rows(t.slots, r.answers).map(row => {
                const proposed = projected.provenance.filter(item => item.topicId === t.id && item.path === row.id);
                const provenance = [...detailProvenance(d, t.id, row.id, row.sourceIds), ...proposed.flatMap(item => [...item.evidence.map(span => ({ ...span, transform: 'provisional-patient-report' })), ...(item.supersededEvidence ?? []).map(span => ({ ...span, transform: 'superseded-patient-report' }))])];
                return { ...row, sourceIds: [...new Set([...row.sourceIds, ...proposed.flatMap(item => item.sourceIds)])], ...(provenance.length ? { provenance } : {}), ...(proposed.length ? { interpretation: { qualified: qualified && proposed.every(item => item.sourceIds.every(id => admittedSources.has(id))), status: row.state === 'conflicting' ? 'conflicting' as const : 'proposed' as const } } : {}) };
            });
            const answered = details.filter(detail => detail.state !== 'not-asked');
            const sourceIds = [...new Set([...details.flatMap(detail => detail.sourceIds), ...(r.applicabilitySourceIds ?? [])])];
            const gaps = projected.gaps.filter(gap => gap.topicId ? gap.topicId === t.id : gap.evidence.some(span => projected.claims.some(claim => claim.topicId === t.id && claim.sourceId === span.sourceId)));
            const directScreen = d.topics.Q16 ?? { presented: false, answers: {} }; // PHQ is direct exact choice only.
            return { id: t.id, title: titles[t.id] ?? scenarioTitles[d.scenario], required: requiredIds.has(t.id) && t.presentation !== 'O', ...(r.stopped ? { stopReason: r.stopped } : {}),
                status: requiredIds.has(t.id) && ready.sufficient ? 'ready-for-review' : r.stopped || gaps.length ? 'stopped-with-gaps' : answered.length || r.presented ? 'more-detail-needed' : 'not-started',
                missingDetails: [...ready.unresolvedSlotIds.map(id => details.find(detail => detail.id === id)?.label ?? id), ...(details.some(detail => detail.interpretation?.qualified === false) ? ['Proposed interpretation has not been qualified for completeness.'] : [])], details,
                ...(t.id === 'Q16' ? { screening: { ...scorePhq4(directScreen.answers, screenContext(d, directScreen)), title: 'PHQ-4 for clinician review', text: screenText(d, t, directScreen).trim() } } : {}),
                ...(r.applicability === 'not-applicable' ? { answer: { text: 'Patient explicitly marked this topic not applicable.', state: 'negative' as const, sourceIds } }
                    : answered.length ? { answer: { text: answered.map(detail => `${detail.label}: ${detail.interpretation ? 'Proposed patient report — ' : ''}${detail.text ?? detail.state}`).join('\n') + screenText(d, t, directScreen),
                        state: (ready.sufficient ? 'answered' : answered.every(detail => detail.state === 'declined') ? 'declined' : answered.every(detail => detail.state === 'unknown') ? 'unknown' : answered.some(detail => detail.state === 'conflicting') ? 'conflicting' : 'answered') as NonNullable<TopicView['answer']>['state'], sourceIds } } : {}) };
        });
    }
    function complete(d: Draft) { return !unresolvedRecognitionSourceIds(d.turns.filter(turn => turn.role === 'patient').map(turn => ({ id: turn.id, patient: d.patient, kind: turn.corrects ? 'patient-correction' as const : 'patient-statement' as const, text: turn.text, capturedAt: turn.at, ...(turn.channel ? { channel: turn.channel } : {}), ...(turn.corrects ? { corrects: turn.corrects } : {}), ...(turn.displayedPromptId ? { displayedPromptId: turn.displayedPromptId } : {}) })), effective(d, true).responses).length && !d.safety && !unresolvedSources(d).length && !effective(d, true).gaps.length && definitions(d).filter(t => t.presentation !== 'O').every(t => evaluateTopic(t, topicResponse(d, t), evidence(d)).sufficient); }
    function view(d: Draft, identity = true, adaptiveAvailable = false): ClinicSessionView {
        let exchange = d.adaptive?.exchange?.prompt;
        if (native && exchange) {
            try {
                // The saved adaptive question was planned over proposed facts for
                // navigation. Resolve its repeat items against that same projection;
                // readiness still uses effective(d, true) and its qualification gate.
                const authority = nativeNavigation(d)!, navigationResponses = authority.repeatResolutionTopics;
                const failure = d.adaptive?.exchange?.state.lastUnsuccessful;
                const context = exchange.promptId === 'stop-choice' && failure?.purposeExplained ? { ...authority.context, engagementUnclear: { topicId: failure.topicId, path: failure.targetPaths[0], sourceIds: [failure.sourceId], purposeExplained: true as const, unsuccessfulAttempts: failure.count } } : authority.context;
                for (const path of exchange.targetPaths.length ? exchange.targetPaths : ['']) {
                    const topic = captureDefinitions(d).find(topic => topic.id === exchange!.topicId);
                    const promptId = exchange.promptId === '__list-completion' && topic ? fieldAt(topic, navigationResponses[topic.id] ?? { presented: false, answers: {} }, path).promptIds[0] : exchange.promptId;
                    guardNativePrompt({ ...authority, promptId, topicId: exchange.topicId, ...(promptId !== 'stop-choice' ? { path } : {}), text: exchange.kind === 'instrument' ? register.promptsById[promptId]?.text : exchange.text, scenario: d.scenario, context }, evidence(d));
                }
            } catch { exchange = undefined; }
        }
        const natural = adaptiveAvailable && d.adaptive?.mode === 'adaptive' && !d.activeSlot && d.phase === 'conversation' && !d.safety?.paused; const currentPrompt: PromptView | undefined = natural ? exchange ? exchange.kind === 'instrument' ? prompt(d) : { id: `${exchange.topicId}:${exchange.promptId}`, topicId: exchange.topicId, text: exchange.text, purpose: exchange.labels.join('; '), mode: 'adaptive' } : prompt(d) : prompt(d); return { id: d.id, scenario: d.scenario, title: scenarioTitles[d.scenario], persona: { displayName: config.patients[d.scenario].displayName, description: config.patients[d.scenario].description }, phase: identity ? d.phase : 'identity', revision: d.revision, savedAt: d.savedAt, completeness: identity ? d.confirmed?.confirmation.submission.completeness ?? d.preview?.confirmation.submission.completeness ?? (complete(d) ? 'complete' : 'partial') : 'partial', topics: identity ? (d.phase === 'review' && d.preview ? d.preview.topics : d.confirmed ? d.confirmed.topics : topics(d)) : [], turns: identity ? d.turns : [], ...(identity ? { speechScopeDigest: streamSpeechScopeDigest(d), currentPrompt, ...(d.safetySignals?.some(signal => !signal.review) && !d.confirmed ? { safetyReview: { pendingSignalIds: d.safetySignals.filter(signal => !signal.review).map(signal => signal.id) } } : {}), adaptive: adaptiveView(d, adaptiveAvailable), delivery: d.delivery, previousDelivery: d.previousDelivery, notice: d.safety ? { tone: d.safety.rule === 'E05' ? 'attention' as const : 'urgent' as const, text: d.safety.text + (d.delivery?.state === 'received' ? ' Your confirmed handoff was received. See the actual staff work below; receipt does not mean care was provided.' : d.confirmed ? ' Delivery is not confirmed. Help does not depend on sending this handoff.' : ' Your draft has not been sent. You can review and send a partial handoff, or leave now.') } : d.notice ?? { tone: 'info' as const, text: config.patients[d.scenario].context ?? 'This conversation is saved for your review. It does not replace urgent care.' } } : {}) }; }
    function change(d: Draft) { const n = structuredClone(d); if (n.confirmed) {
        n.questionnaireHistory = structuredClone(n.confirmed.confirmation.submission.questionnaireCapture?.inactiveHistory ?? []);
        n.prior = { version: n.version, digest: n.confirmed.digest };
        n.previousDelivery = n.delivery;
        n.version++;
        delete n.confirmed;
        delete n.delivery;
    } delete n.preview; n.phase = 'conversation'; return n; }
    function select(d: Draft, topicId: string, slotPath?: string) { requireNoPendingInterpretation(d, true); const n = change(d), t = [...definitions(n), ...captureDefinitions(n).filter(topic => effective(n).claims.some(claim => claim.topicId === topic.id))].find(t => t.id === topicId); if (!t)
        throw new ApiFailure('unknown-topic'); if (topicId === 'Q18' && !n.relevantTopicIds?.includes('Q18'))
        n.relevantTopicIds = [...(n.relevantTopicIds ?? []), 'Q18']; if (n.safety?.paused && n.safety.rule !== 'E05')
        throw new ApiFailure('safety-interruption-review-or-leave', 409); if (n.safety?.rule === 'E05')
        n.safety.paused = false; n.activeTopic = topicId; n.activeSlot = slotPath;
    if (register.scenarios[n.scenario].reusableTopicIds.includes(topicId as never)) n.relevantTopicIds = [...new Set([...(n.relevantTopicIds ?? []), topicId])];
    n.topics[topicId] = { ...(n.topics[topicId] ?? { presented: true, answers: {} }), stopped: undefined };
    if (slotPath?.includes('[')) {
        const collection = slotPath.slice(0, slotPath.indexOf('[')), itemId = /^\[([^\]]+)\]/.exec(slotPath.slice(collection.length))?.[1];
        const projected = effective(n).responses[topicId]?.answers[collection], direct = n.topics[topicId].answers[collection];
        if (itemId && projected?.state === 'known' && projected.items?.some(item => item.id === itemId) && !(direct?.state === 'known' && direct.items?.some(item => item.id === itemId))) {
            n.topics[topicId] = { ...n.topics[topicId], answers: { ...n.topics[topicId].answers, [collection]: { state: 'known', complete: false, sourceIds: projected.sourceIds, items: [...(direct?.state === 'known' ? direct.items ?? [] : []), { id: itemId, answers: {} }] } } };
        }
    }
    if (slotPath)
        fieldAt(t, n.topics[topicId], slotPath);
    else if (!nextGuidedField(t, n.topics[topicId], evidence(n))) {
        n.activeSlot = t.slots.find(s => s.promptIds.length)?.id;
    } return n; }
    function turn(d: Draft, input: TurnInput) {
        requireNoPendingInterpretation(d, true);
        if (d.adaptive?.mode === 'adaptive' && !d.activeSlot && d.adaptive.exchange?.prompt?.kind !== 'instrument') throw new ApiFailure('choose-guided-mode', 409);
        const n = structuredClone(d), c = current(n);
        if (!c || input.promptId !== `${c.topic.id}:${c.field.path}`)
            throw new ApiFailure('stale-prompt', 409, true);
        const speech = input.channel === 'confirmed-transcript' || input.channel === 'unreviewed-transcript';
        if (input.expectedRevision !== d.revision) throw new ApiFailure('stale-session', 409);
        if (speech && input.action === 'answer' && /^MH0[1-4]$/.test(c.field.path) && !input.choiceConfirmation && !input.choiceTranscriptOnly) throw new ApiFailure('explicit-screening-choice-required', 409);
        const p = prompt(n)!, id = crypto.randomUUID(), last = n.turns.at(-1), now = new Date(Math.max(Date.now(), last ? Date.parse(last.at) + 1 : 0)).toISOString();
        let text = input.text?.trim() ?? input.fields?.value?.trim() ?? '';
        const normalListing = c.field.kind === 'collection' && input.action === 'answer' && ['__add', '__done'].includes(text);
        // A reviewed rewording of retained raw speech for this same displayed prompt links to that
        // raw source: unreviewed recognition holds no answer, so the answer lookup cannot find it.
        const unreviewedRaw = !normalListing && input.channel === 'confirmed-transcript' && input.action === 'answer' && input.text !== undefined && !input.choiceConfirmation
          ? n.turns.filter(t => t.role === 'patient' && t.channel === 'unreviewed-transcript' && t.displayedPromptId === c.topic.id + ':' + c.field.path && t.text.trim() !== input.text!.trim() && !n.turns.some(later => later.channel === 'confirmed-transcript' && later.displayedPromptId === t.displayedPromptId && Date.parse(later.at) > Date.parse(t.at))).at(-1)?.id : undefined;
        const prior = normalListing || input.choiceTranscriptOnly ? undefined : rows(c.topic.slots, effective(n).responses[c.topic.id]?.answers ?? {}).find(r => r.id === c.field.path)?.sourceIds.at(-1) ?? unreviewedRaw;
        const selected = p.choices?.find(x => x.value === text);
        if (input.choiceTranscriptOnly && (input.action !== 'answer' || input.channel !== 'unreviewed-transcript' || !p.choices?.length || !input.text?.trim() || input.choiceConfirmation || input.fields)) throw new ApiFailure('invalid-choice-transcript');
        if (input.priorChoiceTranscript && (!input.choiceTranscriptOnly || !exactSpokenChoice(p, input.priorChoiceTranscript))) throw new ApiFailure('invalid-choice-transcript');
        const confirmation = input.choiceConfirmation;
        if (confirmation && (input.action !== 'answer' || input.channel !== 'confirmed-transcript' || !selected
          || exactSpokenChoice(p, confirmation.optionTranscript)?.value !== selected.value
          || confirmation.confirmationMethod === 'voice' && exactChoiceConfirmation(confirmation.confirmationTranscript) !== 'confirm'
          || confirmation.confirmationMethod === 'control' && confirmation.confirmationTranscript !== '')) throw new ApiFailure('explicit-choice-confirmation-required', 409);
        const confirmationId = confirmation ? `confirmation-${id}` : undefined;
        // Speech source text stays verbatim; interpreted field values remain separate below.
        const sourceText = speech && input.action === 'answer' && input.text !== undefined ? confirmation?.optionTranscript ?? input.text : input.action === 'answer' ? `${c.field.label}: ${selected?.label ?? text}${input.fields?.feet ? ` (${input.fields.feet} ft ${input.fields.inches ?? ''} in)` : ''}` : `${c.field.label}: ${input.action === 'move-on' ? 'Move on from this topic' : input.action === 'unknown' ? "I don't know" : 'Prefer not to answer'}`;
        n.turns.push({ id: `p-${id}`, role: 'assistant', text: speech && p.choices?.length ? conversationSpeech({ currentPrompt: p })!.text : p.text, at: now }, { id, role: 'patient', text: sourceText, at: now, channel: input.channel ?? 'text', ...(speech ? { displayedPromptId: p.id } : {}), ...(prior ? { corrects: prior } : {}) });
        if (confirmation && confirmationId) n.turns.push(
          { id: `prompt-${confirmationId}`, role: 'assistant', text: choiceConfirmationSpeech(p, selected!.value)!, at: now },
          { id: confirmationId, role: 'patient', text: confirmation.confirmationMethod === 'voice' ? confirmation.confirmationTranscript : 'Confirmed the displayed choice using Confirm choice.', at: now, channel: confirmation.confirmationMethod === 'voice' ? 'confirmed-transcript' : 'text', displayedPromptId: p.id });
        const ev = evidence(n);
        let r = { ...(n.topics[c.topic.id] ?? { presented: false, answers: {} }), presented: true };
        const rule = input.action === 'answer' ? escalation(text) : undefined;
        if (input.choiceTranscriptOnly) {
            if (input.priorChoiceTranscript) n.turns.push({ id: `initial-${id}`, role: 'patient', text: input.priorChoiceTranscript, at: now, channel: 'unreviewed-transcript', displayedPromptId: p.id });
            const candidateRule = escalation(input.text!);
            if (candidateRule) {
                n.safety = { rule: candidateRule, version: 'E-0.1', sourceId: id, text: escalationCopy[candidateRule], at: now, paused: true };
                r = { ...r, stopped: 'safety-interruption' };
            }
            n.topics[c.topic.id] = r;
            delete n.preview; n.phase = 'conversation';
            return synchronize(n);
        }
        // Tier 1: typed or spoken free text (never a selected choice) queues a background model review.
        const screen = !rule && input.action === 'answer' && !selected && !text.startsWith('__') ? screenSafety(input.text ?? text) : undefined;
        if (screen) n.safetySignals = [...(n.safetySignals ?? []), { id: crypto.randomUUID(), sourceId: id, categories: screen.categories, terms: screen.terms, at: now, version: screen.version }];
        if (rule)
            r = { ...r, stopped: 'safety-interruption' };
        else if (c.field.path === '__applicability')
            r = { ...r, applicability: input.action === 'answer' && text === '__applicable' ? 'applicable' : input.action === 'answer' && text === '__topic-not-applicable' ? 'not-applicable' : 'unknown', applicabilitySourceIds: [id] };
        else if (input.action === 'move-on')
            r = { ...r, stopped: 'patient-moves-on' };
        else if (input.action === 'answer' && c.field.kind === 'collection' && text === '__add')
            r = addCollectionItem(c.topic, r, { path: c.field.path, itemId: `i${id.replaceAll('-', '').slice(0, 12)}`, sourceIds: [id] }, ev);
        else if (input.action === 'answer' && c.field.kind === 'collection' && text === '__done')
            r = finishCollection(c.topic, r, { path: c.field.path, sourceIds: [id] }, ev);
        else {
            if (input.action === 'answer' && ((c.topic.id === 'W05' && c.field.path === 'serviceDate') || (c.topic.id === 'W06' && c.field.path === 'requestedDate')) && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text))
                throw new ApiFailure('invalid-logistics-date');
            let a: SlotAnswer;
            if (input.action === 'unknown' || input.action === 'decline')
                a = { state: input.action === 'unknown' ? 'unknown' : 'declined', sourceIds: [id] };
            else if (text === '__uncertain')
                a = { state: 'uncertain', sourceIds: [id], note: 'Patient is uncertain; not a confirmed diagnosis.' };
            else if (text === '__negative' || text === '__not-applicable')
                a = { state: text === '__negative' ? 'negative' : 'not-applicable', sourceIds: [id], note: selected?.label };
            else
                a = { state: 'known', value: parseGuidedValue(c.field, c.field.kind === 'height-value' && input.fields?.feet ? { feet: input.fields.feet, inches: input.fields.inches ?? '' } : text), sourceIds: confirmationId ? [id, confirmationId] : [id] };
            r = applyGuidedAnswer(c.topic, r, { path: c.field.path, answer: a }, ev);
            if (c.field.path === 'currentWeightEstimate.value' && a.state === 'known')
                r = { ...r, answers: { ...r.answers, 'currentWeightEstimate.statedAt': { state: 'known', value: now, sourceIds: [id] } } };
        }
        if (input.action === 'decline')
            r = { ...r, stopped: 'patient-declines' };
        if (rule) {
            n.safety = { rule, version: 'E-0.1', sourceId: id, text: escalationCopy[rule], at: now, paused: true };
            n.notice = { tone: rule === 'E05' ? 'attention' : 'urgent', text: escalationCopy[rule] + ' Your draft has not been sent. You can review and send a partial handoff, or leave now.' };
            r = { ...r, stopped: 'safety-interruption' };
        }
        if ((c.topic.id === 'Q08' && c.field.path.endsWith('.reason') && /\b(weight loss|weight management)\b/i.test(text)) || /\b(pregnant|pregnancy|breastfeeding)\b/i.test(text))
            n.relevantTopicIds = [...new Set([...(n.relevantTopicIds ?? []), 'Q18'])];
        n.topics[c.topic.id] = r;
        // A presented PHQ battery continues through its remaining exact items, including
        // explicitly unknown answers. Existing topic decline/move-on/safety still stop it.
        const nextScreenItem = c.topic.id === 'Q16' && /^MH0[1-4]$/.test(c.field.path) && !r.stopped && !n.safety?.paused
            ? ['MH01', 'MH02', 'MH03', 'MH04'].slice(Number(c.field.path.slice(-1))).find(path => !r.answers[path] || r.answers[path].state === 'not-asked')
            : undefined;
        n.activeSlot = nextScreenItem;
        n.activeTopic = nextScreenItem ? 'Q16' : r.stopped ? undefined : c.topic.id;
        delete n.preview;
        n.phase = 'conversation';
        return synchronize(n);
    }
    async function preview(d: Draft, confirmedAt = new Date().toISOString()) { requireNoPendingInterpretation(d); if (!d.turns.some(t => t.role === 'patient'))
        throw new ApiFailure('answer-required-before-review'); const prepared = native ? await prepareFinalRepresentation(d, captureDefinitions(d), options.provisionalQualification, options.finalRepresentationQualification) : undefined; let representationAuthority: TrustedRepresentationAuthority | undefined; const tv = topics(d), requiredDefs = definitions(d), defs = [...requiredDefs, ...captureDefinitions(d).filter(topic => tv.some(view => view.id === topic.id) && !requiredDefs.some(required => required.id === topic.id))], scenario = register.scenarios[d.scenario]; const owners = [...new Set([...scenario.owners, ...(scenario.missingContextOwner ? [scenario.missingContextOwner] : []), ...(d.safety || ['billing', 'scheduling'].includes(d.scenario) || safetyReviewTopics(d).length ? ['medical' as const] : []), ...(d.safety?.rule === 'E05' ? ['nutrition' as const] : [])])]; const logistics: AdministrativeLogistics = { kind: ['billing', 'scheduling'].includes(d.scenario) ? d.scenario as 'billing' | 'scheduling' : 'other' }; for (const detail of tv.find(topic => topic.id === (d.scenario === 'billing' ? 'W05' : 'W06'))?.details ?? []) { if (detail.state !== 'answered') continue; const candidate = administrativeLogisticsSchema.safeParse({ ...logistics, [detail.id]: detail.text }); if (candidate.success) Object.assign(logistics, candidate.data); } const s: Submission = { submissionId: d.id, version: d.version, patient: d.patient, scenario: d.scenario, contentVersion: `${register.provenance.version}.${register.mentalHealth}`, questionnaire: native ? `${NATIVE_QUESTIONNAIRE_CANONICAL}|${NATIVE_QUESTIONNAIRE_VERSION}` : `https://corvo.example/Questionnaire/clinic/${register.provenance.version}/${d.scenario}/${register.mentalHealth}`, confirmedAt, completeness: complete(d) ? 'complete' : 'partial', ...(d.prior ? { previous: { submissionId: d.id, ...d.prior } } : {}), sources: d.turns.filter(t => t.role === 'patient').map(t => ({ id: t.id, patient: d.patient, kind: t.corrects ? 'patient-correction' : 'patient-statement', text: t.text, capturedAt: t.at, ...(t.channel !== undefined ? { channel: t.channel } : {}), ...(t.corrects ? { corrects: t.corrects } : {}), ...(t.displayedPromptId ? { displayedPromptId: t.displayedPromptId } : {}) })), ...(owners.includes('admin') ? { administrativeLogistics: logistics } : {}), answers: tv.map(t => ({ questionId: t.id, state: t.answer?.state ?? 'not-asked', ...(t.answer ? { text: t.answer.text } : {}), sourceIds: t.answer?.sourceIds ?? [] })), work: owners.map(owner => { const responsibility = owner === 'admin' ? 'administrative' : owner; return { id: responsibility, kind: responsibility === 'administrative' ? 'administrative' : 'clinical', responsibility, owner: config.patients[d.scenario].careTeams[responsibility] }; }) }; if (native) s.questionnaireCapture = await buildNativeQuestionnaireCapture({ scenario: d.scenario, relevantTopicIds: effectiveRelevantTopicIds(d), topics: effective(d, true).responses, validSourceIds: evidence(d).validSourceIds, unreviewedSourceIds: [...new Set([...unresolvedRecognitionSourceIds(s.sources, effective(d, true).responses), ...unresolvedSources(d).map(source => source.sourceId)])], context: prepared ? deriveNativeRoutingContext(prepared.projection.responses, { validSourceIds: new Set(s.sources.filter(source => source.channel !== 'unreviewed-transcript').map(source => source.id)), reviewedFact: prepared.preparingAuthority.reviewedFact }, config.patients[d.scenario].nativeContext) : nativeContext(d), ...(prepared ? { representationAuthority: prepared.preparingAuthority } : {}), inactiveHistory: d.questionnaireHistory ?? d.confirmed?.confirmation.submission.questionnaireCapture?.inactiveHistory });
        if (prepared && s.questionnaireCapture) {
            representationAuthority = await prepared.bind(s.contentVersion, s.questionnaireCapture);
            if (!representationAuthority) s.questionnaireCapture = await buildNativeQuestionnaireCapture({ scenario: d.scenario, relevantTopicIds: effectiveRelevantTopicIds(d), topics: effective(d, true).responses, validSourceIds: evidence(d).validSourceIds, unreviewedSourceIds: [...new Set([...unresolvedRecognitionSourceIds(s.sources, effective(d, true).responses), ...unresolvedSources(d).map(source => source.sourceId)])], context: nativeContext(d), inactiveHistory: d.questionnaireHistory });
            else {
            s.representationReview = representationAuthority.expected;
            s.questionnaireCapture.reviewBinding = representationAuthority.expected.digest;
            const authority = nativeRepresentationAuthority(representationAuthority), reviewEvidence = { validSourceIds: new Set(s.sources.filter(source => source.channel !== 'unreviewed-transcript').map(source => source.id)), reviewedFact: authority.reviewedFact, reviewedSourceAccountedFor: authority.reviewedSourceAccountedFor };
            const remainingGaps = effective(d, true).gaps.filter(gap => gap.reason !== 'recognition-unreviewed' || !authority.reviewedSourceAccountedFor(gap.sourceId));
            s.completeness = !d.safety && !unresolvedSources(d).some(source => !authority.reviewedSourceAccountedFor(source.sourceId)) && !remainingGaps.length && nativeCaptureComplete(s.questionnaireCapture, reviewEvidence) ? 'complete' : 'partial';
            }
        }
        const hash = await digest(s); const assessment: SufficiencyAssessment = { submissionDigest: hash, contentVersion: s.contentVersion, assessedBy: qualified ? `corvo-${options.provisionalQualification!.projection}:${options.provisionalQualification!.evidenceDigest}` : 'corvo-guided-content-validation', assessedAt: s.confirmedAt, questions: defs.map(t => ({ questionId: t.id, targets: topicResponse(d, t).applicability === 'not-applicable' ? t.slots.filter(x => !x.optional).map(x => ({ id: x.id, state: 'sufficient' as const, sourceIds: [...(topicResponse(d, t).applicabilitySourceIds ?? [])] })) : aggregateTargets(t, evaluateTopic(t, topicResponse(d, t), evidence(d))) })) }; const content: ContentContract = { version: s.contentVersion, questionnaire: s.questionnaire, approval: { approvedBy: 'Jake: synthetic demonstration scope including PHQ-4 with clinician review; no clinical protocol approval', approvedAt: '2026-10-09T00:00:00.000Z' }, questions: defs.map(t => ({ id: t.id, requiredForComplete: requiredDefs.some(required => required.id === t.id && required.presentation !== 'O'), requiresAnsweredValue: t.id === 'Q04', detailTargets: t.slots.filter(s => !s.optional).map(s => s.id), stopWhen: [...t.stopWhen] })) }; const confirmation = await confirmSubmission(s, { patient: d.patient, submissionId: d.id, scenario: d.scenario }, content, hash, assessment, representationAuthority); return { digest: hash, confirmation, topics: [...(d.safety ? [...tv, { id: d.safety.rule, title: 'Help guidance shown', required: false, status: 'stopped-with-gaps' as const, missingDetails: ['Human medical review remains required'], answer: { text: `${d.safety.version} ${d.safety.rule}: ${d.safety.text}`, state: 'answered' as const, sourceIds: [d.safety.sourceId] } }] : tv), ...safetyReviewTopics(d)].concat(interpretationReview(d, unresolvedSources(d).filter(source => !representationAuthority?.expected.accountedSourceIds.includes(source.sourceId)), { ...effective(d), gaps: effective(d).gaps.filter(gap => gap.reason !== 'recognition-unreviewed' || !representationAuthority?.expected.accountedSourceIds.includes(gap.sourceId)) })) }; }
    async function finalize(d: Draft, confirmedAt = new Date().toISOString()) {
        if (!d.preview) throw new ApiFailure('confirmation-digest-mismatch', 409);
        const final = await preview(d, confirmedAt);
        const reviewed = d.preview.confirmation.submission;
        // Re-evaluate the same saved answers, then verify that only the server's
        // confirmation timestamp changed. Never mutate content under an old digest.
        if (await digest({ ...final.confirmation.submission, confirmedAt: reviewed.confirmedAt }) !== d.preview.digest || canonicalJson(final.topics) !== canonicalJson(d.preview.topics))
            throw new ApiFailure('confirmation-digest-mismatch', 409);
        return { ...final, confirmation: { ...final.confirmation, ...(final.confirmation.representationAuthority ? { representationConfirmed: true as const } : {}) }, previewDigest: d.preview.digest };
    }
    return { navigationQualification: qualified ? options.provisionalQualification : undefined, view, turn, select, preview, finalize, definitions, captureDefinitions, effective, topics, current, register, nativeContext, nativeNavigation, synchronize, effectiveRelevantTopicIds };
}
