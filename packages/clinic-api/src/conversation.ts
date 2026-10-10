import { scorePhq4, scenarioTopics, guidedFieldForPath, aggregateTargets, applyGuidedAnswer, addCollectionItem, finishCollection, createClinicContent, diabetesBranchApplicability, evaluateTopic, nextGuidedField, parseGuidedValue, mentalHealthOptions, type GuidedField, type TopicDefinition, type TopicResponse, type SlotAnswer, type SlotAnswers, type SlotDefinition } from '../../clinic-content/src/index.js';
import { canonicalJson, digest, confirmSubmission, type ContentContract, type Submission, type SufficiencyAssessment } from '../../clinical-core/src/domain.js';
import type { ClinicSessionView, PromptView, TopicView, TurnInput, ScenarioId } from '../../clinic-contract/src/index.js';
import { escalation, escalationCopy } from './safety.js';
import { ApiFailure, type Draft, type ClinicApiConfig } from './types.js';
export const scenarioTitles: Record<ScenarioId, string> = { 'first-intake': 'First visit intake', 'pre-visit': 'Before your visit', 'non-visit': 'Check in with your care team', 'post-visit': 'After your visit', billing: 'Billing help', scheduling: 'Scheduling help', refill: 'Prescription refill request' };
const choiceLabels: Record<string, string> = { 'bill-question': 'A bill question', 'coverage-question': 'A coverage question', 'payment-question': 'A payment question', 'other-request': 'Another billing request', explanation: 'An explanation', 'review-possible-error': 'Review a possible error', 'payment-options': 'Discuss payment options', 'contact-me': 'Contact me', 'first-visit': 'First visit', 'follow-up': 'Follow-up visit', 'not-sure': 'Not sure', 'America/New_York': 'Eastern time', 'America/Chicago': 'Central time', 'America/Denver': 'Mountain time', 'America/Los_Angeles': 'Pacific time', 'America/Anchorage': 'Alaska time', 'Pacific/Honolulu': 'Hawaii time' };
const titles: Record<string, string> = { Q01: 'Your priorities', Q02: 'Current symptoms', Q03: 'Weight through your life', Q04: 'Height and weight', Q05: 'Prior approaches', Q06: 'Medical conditions', Q07: 'Surgery and hospital care', Q08: 'Medicines and supplements', Q09: 'Allergies and reactions', Q10: 'Family history', Q11: 'A day of food and drink', Q12: 'Eating concerns', Q13: 'Access to food', Q14: 'Movement and function', Q15: 'Sleep', Q16: 'Mood, anxiety and support', Q17: 'Substance use', Q18: 'Pregnancy and reproductive context', Q19: 'Care team and records', Q20: 'Access to care', Q21: 'Communication preferences', Q22: 'Other questions', DM: 'Diabetes and prediabetes' };
export function conversation(config: ClinicApiConfig) {
    const register = createClinicContent({ mentalHealth: config.mentalHealth });
    const evidence = (d: Draft) => ({ validSourceIds: new Set(d.turns.filter(t => t.role === 'patient').map(t => t.id)) });
    const response = (d: Draft, id: string): TopicResponse => d.topics[id] ?? { presented: false, answers: {} };
    function definitions(d: Draft): TopicDefinition[] {
        return [...scenarioTopics(register, d.scenario, { relevantTopicIds: (d.relevantTopicIds ?? []).filter(id => register.scenarios[d.scenario].reusableTopicIds.includes(id as never)) as import('../../clinic-content/src/types.js').TopicId[], responses: d.topics, evidence: evidence(d) })].map(t => t.id === 'Q18' && !d.relevantTopicIds?.includes('Q18') ? { ...t, presentation: 'O' as const } : t);
    }
    function topicResponse(d: Draft, t: TopicDefinition): TopicResponse { const r = response(d, t.id); return t.presentation === 'C' && t.id !== 'Q18' ? { ...r, applicability: 'applicable' } : r; }
    function fieldAt(t: TopicDefinition, r: TopicResponse, path: string): GuidedField { const field = guidedFieldForPath(t, r, path); if (field.kind === 'configuration' || !field.promptIds.length)
        throw new ApiFailure('detail-not-editable', 400); return field; }
    function current(d: Draft): {
        topic: TopicDefinition;
        field: GuidedField;
    } | undefined {
        if (d.phase === 'confirmed' || d.phase === 'review' || d.safety?.paused)
            return;
        const defs = definitions(d), ordered = d.activeTopic ? [...defs.filter(t => t.id === d.activeTopic), ...defs.filter(t => t.id !== d.activeTopic)] : defs;
        for (const topic of ordered) {
            if (topic.id === 'Q18' && !d.relevantTopicIds?.includes('Q18'))
                continue;
            const r = topicResponse(d, topic);
            if (topic.id === 'Q18' && !r.presented)
                return { topic, field: { path: '__applicability', label: 'Is this topic relevant for your clinician to consider?', kind: 'choice', choices: ['__applicable', '__topic-not-applicable'], promptIds: ['Q18'], acceptsNegative: false, acceptsNotApplicable: false, action: 'answer', allowedStates: ['known', 'unknown', 'declined'] } };
            const field = d.activeTopic === topic.id && d.activeSlot ? fieldAt(topic, r, d.activeSlot) : nextGuidedField(topic, r, evidence(d));
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
        return { id: `${topic.id}:${field.path}`, topicId: topic.id, text, purpose: field.label, ...(choices.length ? { choices } : {}), ...(field.kind === 'height-value' ? { fields: [{ id: 'value', label: 'Height as one value (cm, metres, inches or feet)', kind: 'number' as const, required: false }, { id: 'feet', label: 'Or feet', kind: 'number' as const, required: false }, { id: 'inches', label: 'And inches', kind: 'number' as const, required: false }] } : {}) };
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
    function topics(d: Draft): TopicView[] { return definitions(d).map(t => { const r = topicResponse(d, t), ready = evaluateTopic(t, r, evidence(d)), details = rows(t.slots, r.answers), answered = details.filter(s => s.state !== 'not-asked'), sourceIds = [...new Set([...ready.slots.flatMap(s => s.sourceIds), ...(r.applicabilitySourceIds ?? [])])]; return { id: t.id, title: titles[t.id] ?? scenarioTitles[d.scenario], required: t.presentation !== 'O', status: ready.sufficient ? 'ready-for-review' : r.stopped || ready.collection === 'awaiting-information' ? 'stopped-with-gaps' : ready.presentedOrAccountedFor ? 'more-detail-needed' : 'not-started', missingDetails: ready.unresolvedSlotIds.map(id => details.find(s => s.id === id)?.label ?? id), details, ...(t.id === 'Q16' ? { screening: { ...scorePhq4(r.answers, screenContext(d, r)), title: 'PHQ-4 for clinician review', text: screenText(d, t, r).trim() } } : {}), ...(r.applicability === 'not-applicable' ? { answer: { text: 'Patient explicitly marked this topic not applicable.', state: 'negative' as const, sourceIds } } : answered.length ? { answer: { text: answered.map(s => `${s.label}: ${s.text ?? s.state}`).join('\n') + screenText(d, t, r), state: (ready.sufficient ? 'answered' : answered.every(s => s.state === 'declined') ? 'declined' : answered.every(s => s.state === 'unknown') ? 'unknown' : 'answered') as NonNullable<TopicView['answer']>['state'], sourceIds } } : {}) }; }); }
    function complete(d: Draft) { return !d.safety && definitions(d).filter(t => t.presentation !== 'O').every(t => evaluateTopic(t, topicResponse(d, t), evidence(d)).sufficient); }
    function view(d: Draft, identity = true): ClinicSessionView { return { id: d.id, scenario: d.scenario, title: scenarioTitles[d.scenario], persona: { displayName: config.patients[d.scenario].displayName, description: config.patients[d.scenario].description }, phase: identity ? d.phase : 'identity', revision: d.revision, savedAt: d.savedAt, completeness: identity && complete(d) ? 'complete' : 'partial', topics: identity ? topics(d) : [], turns: identity ? d.turns : [], ...(identity ? { currentPrompt: prompt(d), delivery: d.delivery, previousDelivery: d.previousDelivery, notice: d.safety ? { tone: d.safety.rule === 'E05' ? 'attention' as const : 'urgent' as const, text: d.safety.text + (d.delivery?.state === 'received' ? ' Your confirmed handoff was received. See the actual staff work below; receipt does not mean care was provided.' : d.confirmed ? ' Delivery is not confirmed. Help does not depend on sending this handoff.' : ' Your draft has not been sent. You can review and send a partial handoff, or leave now.') } : d.notice ?? { tone: 'info' as const, text: config.patients[d.scenario].context ?? 'This conversation is saved for your review. It does not replace urgent care.' } } : {}) }; }
    function change(d: Draft) { const n = structuredClone(d); if (n.confirmed) {
        n.prior = { version: n.version, digest: n.confirmed.digest };
        n.previousDelivery = n.delivery;
        n.version++;
        delete n.confirmed;
        delete n.delivery;
    } delete n.preview; n.phase = 'conversation'; return n; }
    function select(d: Draft, topicId: string, slotPath?: string) { const n = change(d), t = definitions(n).find(t => t.id === topicId); if (!t)
        throw new ApiFailure('unknown-topic'); if (topicId === 'Q18' && !n.relevantTopicIds?.includes('Q18'))
        n.relevantTopicIds = [...(n.relevantTopicIds ?? []), 'Q18']; if (n.safety?.paused && n.safety.rule !== 'E05')
        throw new ApiFailure('safety-interruption-review-or-leave', 409); if (n.safety?.rule === 'E05')
        n.safety.paused = false; n.activeTopic = topicId; n.activeSlot = slotPath; n.topics[topicId] = { ...topicResponse(n, t), stopped: undefined }; if (slotPath)
        fieldAt(t, n.topics[topicId], slotPath);
    else if (!nextGuidedField(t, n.topics[topicId], evidence(n))) {
        n.activeSlot = t.slots.find(s => s.promptIds.length)?.id;
    } return n; }
    function turn(d: Draft, input: TurnInput) {
        const n = structuredClone(d), c = current(n);
        if (!c || input.promptId !== `${c.topic.id}:${c.field.path}`)
            throw new ApiFailure('stale-prompt', 409, true);
        const p = prompt(n)!, id = crypto.randomUUID(), last = n.turns.at(-1), now = new Date(Math.max(Date.now(), last ? Date.parse(last.at) + 1 : 0)).toISOString();
        const prior = rows(c.topic.slots, topicResponse(n, c.topic).answers).find(r => r.id === c.field.path)?.sourceIds.at(-1);
        let text = input.text?.trim() ?? input.fields?.value?.trim() ?? '';
        const selected = p.choices?.find(x => x.value === text);
        const sourceText = input.action === 'answer' ? `${c.field.label}: ${selected?.label ?? text}${input.fields?.feet ? ` (${input.fields.feet} ft ${input.fields.inches ?? ''} in)` : ''}` : `${c.field.label}: ${input.action === 'move-on' ? 'Move on from this topic' : input.action === 'unknown' ? "I don't know" : 'Prefer not to answer'}`;
        n.turns.push({ id: `p-${id}`, role: 'assistant', text: p.text, at: now }, { id, role: 'patient', text: sourceText, at: now, ...(prior ? { corrects: prior } : {}) });
        const ev = evidence(n);
        let r = { ...topicResponse(n, c.topic), presented: true };
        const rule = input.action === 'answer' ? escalation(text) : undefined;
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
                a = { state: 'known', value: parseGuidedValue(c.field, c.field.kind === 'height-value' && input.fields?.feet ? { feet: input.fields.feet, inches: input.fields.inches ?? '' } : text), sourceIds: [id] };
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
        n.activeSlot = undefined;
        n.activeTopic = undefined;
        delete n.preview;
        n.phase = 'conversation';
        return n;
    }
    async function preview(d: Draft, confirmedAt = new Date().toISOString()) { if (!d.turns.some(t => t.role === 'patient'))
        throw new ApiFailure('answer-required-before-review'); const defs = definitions(d), tv = topics(d), scenario = register.scenarios[d.scenario]; const owners = [...new Set([...scenario.owners, ...(scenario.missingContextOwner ? [scenario.missingContextOwner] : []), ...(d.safety || ['billing', 'scheduling'].includes(d.scenario) ? ['medical' as const] : []), ...(d.safety?.rule === 'E05' ? ['nutrition' as const] : [])])]; const s: Submission = { submissionId: d.id, version: d.version, patient: d.patient, scenario: d.scenario, contentVersion: `${register.provenance.version}.${register.mentalHealth}`, questionnaire: `https://corvo.example/Questionnaire/clinic/${register.provenance.version}/${d.scenario}/${register.mentalHealth}`, confirmedAt, completeness: complete(d) ? 'complete' : 'partial', ...(d.prior ? { previous: { submissionId: d.id, ...d.prior } } : {}), sources: d.turns.filter(t => t.role === 'patient').map(t => ({ id: t.id, patient: d.patient, kind: t.corrects ? 'patient-correction' : 'patient-statement', text: t.text, capturedAt: t.at, ...(t.corrects ? { corrects: t.corrects } : {}) })), answers: tv.map(t => ({ questionId: t.id, state: t.answer?.state ?? 'not-asked', ...(t.answer ? { text: t.answer.text } : {}), sourceIds: t.answer?.sourceIds ?? [] })), work: owners.map(owner => { const responsibility = owner === 'admin' ? 'administrative' : owner; return { id: responsibility, kind: responsibility === 'administrative' ? 'administrative' : 'clinical', responsibility, owner: config.patients[d.scenario].careTeams[responsibility] }; }) }; const hash = await digest(s); const assessment: SufficiencyAssessment = { submissionDigest: hash, contentVersion: s.contentVersion, assessedBy: 'corvo-guided-content-validation', assessedAt: s.confirmedAt, questions: defs.map(t => ({ questionId: t.id, targets: topicResponse(d, t).applicability === 'not-applicable' ? t.slots.filter(x => !x.optional).map(x => ({ id: x.id, state: 'sufficient' as const, sourceIds: [...(topicResponse(d, t).applicabilitySourceIds ?? [])] })) : aggregateTargets(t, evaluateTopic(t, topicResponse(d, t), evidence(d))) })) }; const content: ContentContract = { version: s.contentVersion, questionnaire: s.questionnaire, approval: { approvedBy: 'Jake: synthetic demonstration scope including PHQ-4 with clinician review; no clinical protocol approval', approvedAt: '2026-10-09T00:00:00.000Z' }, questions: defs.map(t => ({ id: t.id, requiredForComplete: t.presentation !== 'O', requiresAnsweredValue: t.id === 'Q04', detailTargets: t.slots.filter(s => !s.optional).map(s => s.id), stopWhen: [...t.stopWhen] })) }; const confirmation = await confirmSubmission(s, { patient: d.patient, submissionId: d.id, scenario: d.scenario }, content, hash, assessment); return { digest: hash, confirmation, topics: d.safety ? [...tv, { id: d.safety.rule, title: 'Help guidance shown', required: false, status: 'stopped-with-gaps' as const, missingDetails: ['Human medical review remains required'], answer: { text: `${d.safety.version} ${d.safety.rule}: ${d.safety.text}`, state: 'answered' as const, sourceIds: [d.safety.sourceId] } }] : tv }; }
    async function finalize(d: Draft, confirmedAt = new Date().toISOString()) {
        if (!d.preview) throw new ApiFailure('confirmation-digest-mismatch', 409);
        const final = await preview(d, confirmedAt);
        const reviewed = d.preview.confirmation.submission;
        // Re-evaluate the same saved answers, then verify that only the server's
        // confirmation timestamp changed. Never mutate content under an old digest.
        if (await digest({ ...final.confirmation.submission, confirmedAt: reviewed.confirmedAt }) !== d.preview.digest || canonicalJson(final.topics) !== canonicalJson(d.preview.topics))
            throw new ApiFailure('confirmation-digest-mismatch', 409);
        return { ...final, previewDigest: d.preview.digest };
    }
    return { view, turn, select, preview, finalize, definitions, topics, current, register };
}
