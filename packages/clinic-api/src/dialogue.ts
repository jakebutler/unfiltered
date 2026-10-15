import { guardNativePrompt, nextNativeGuidedField } from '../../clinic-content/src/native-questionnaire.js';
import { evaluateTopic, mentalHealthOptions, promptsById, scenarios, type TopicDefinition, type TopicResponse } from '../../clinic-content/src/index.js';
import { adaptiveSlot, adaptiveHistoryScopes, adaptiveHistoryWindowUncertainty, type AdaptiveContext, type AdaptiveOutcome, type DialogueState, type DisplayedPrompt } from './adaptive-validation.js';
import { assertValidatedAdaptiveGroups, type ValidatedAdaptiveGroups } from './adaptive-group-compile.js';
import { specificityFindings, specificityProbes } from './specificity.js';
import { assessSpecificity, specificityContracts } from '../../clinic-content/src/specificity.js';

export interface EligibleProbe extends DisplayedPrompt {
  kind: 'question' | 'instrument' | 'list-completion';
  text: string;
  labels: string[];
  optional: boolean;
  choices?: readonly { value: number; label: string }[];
}
export interface DialogueOutcome {
  state: DialogueState;
  reply?: { id: string; text: string };
  prompt?: EligibleProbe;
  clarification?: AdaptiveOutcome['clarifications'][number];
  status: 'question' | 'clarification' | 'review-available' | 'paused' | 'interpretation-review';
}
interface RejectedTarget { topicId: string; path: string; }
const empty = (): TopicResponse => ({ presented: false, answers: {} });
const itemScope = (path: string) => path.includes('].') ? path.slice(0, path.lastIndexOf('].') + 1) : '';

/** Finite questions narrow existing content targets; no model-authored wording or new care policy. */
export function scopedQuestion(topic: TopicDefinition, response: TopicResponse, paths: readonly string[]): string | undefined {
  const first = adaptiveSlot(topic, response, paths[0]);
  const value = (key: string) => { const answer = first.siblings[key]; return answer?.state === 'known' && typeof answer.value === 'string' ? answer.value : undefined; };
  const name = value('name'), drink = value('drinks'), food = value('foods'), time = value('time');
  const child = (path: string) => path.includes('].') ? path.slice(path.lastIndexOf('].') + 2) : path;
  const ids = paths.map(child);
  const date = response.answers['lastMeasuredWeight.measuredWhen'];
  const measuredDate = date?.state === 'known' && typeof date.value === 'string' ? date.value : undefined;
  // A description ("pills for my heart") is not a name to put in a question; after a follow-up ("pills for my heart; metoprolol") the name is the part that names it.
  const nameContract = specificityContracts.find(contract => contract.path === 'medicines.name')!;
  const named = name?.split(/;\s*/).reverse().find(part => assessSpecificity(nameContract, part).level === 'specific');
  const med = named ?? 'this medicine or product', label = named ? `your ${named} label` : 'the label';
  const conditions: Record<string, string> = { diabetes: 'diabetes', prediabetes: 'prediabetes', bloodPressure: 'high blood pressure', cholesterol: 'high cholesterol', heartDisease: 'heart disease', stroke: 'a stroke', sleepApnea: 'sleep apnea', liver: 'a fatty liver or another liver condition', kidney: 'kidney disease', joint: 'arthritis or another joint condition', thyroidHormone: 'a thyroid or other hormone condition', digestive: 'a digestive condition' };
  if (topic.id === 'Q06' && ids.every(id => id.startsWith('conditions.'))) {
    const names = ids.map(id => conditions[id.slice('conditions.'.length)]);
    if (names.every(Boolean)) return `Have you ever been told you have ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`}?`;
  }
  if (topic.id === 'Q08' && ids.length === 2 && ids.includes('strength') && ids.includes('labelDirections')) return `What strength and directions are written on ${label}? Please don't guess if you aren't sure.`;
  const scoped: Record<string, Record<string, string>> = {
    Q03: { change: 'What was the change in your weight?', timing: 'About when did that change happen?', context: 'What was happening in your life around that change, if anything?' },
    Q04: {
      'height.value': 'How tall are you?', 'height.unit': 'What units is your height in?',
      'lastMeasuredWeight.value': 'What was the last actual weight reading?', 'lastMeasuredWeight.unit': 'What units was that weight reading in?',
      'lastMeasuredWeight.measuredWhen': 'About when was your weight measured?',
      'lastMeasuredWeight.datePrecision': measuredDate ? `Was ${measuredDate} the exact date, or is that approximate?` : 'Is that measurement date exact or approximate?',
      'lastMeasuredWeight.representsCurrent': promptsById.Q04b.text,
      'currentWeightEstimate.value': 'If you can estimate your current weight, what would it be? We will record it as an estimate.',
      'currentWeightEstimate.unit': 'What units is your current weight estimate in?',
    },
    Q05: { approach: 'What approach did you try?', experience: 'What helped with that approach, and what was difficult?', currentStatus: 'Are you still using that approach? If not, what led you to stop or change it?' },
    Q06: { term: 'What have you been told about this condition?', care: 'What treatment or follow-up do you currently have for this condition, if any?', concern: 'Is this condition causing any difficulties now?', owner: 'Who helps you manage this condition, if anyone?' },
    Q07: { event: 'What procedure did you have, or what was the hospital stay for?', when: 'About when did that happen?' },
    Q08: { name: 'What name is on the medicine or product label?', strength: `What strength is on ${label}, including the units? Please don't guess if you aren't sure.`, labelDirections: `What directions are written on ${label}? Please don't guess if you aren't sure.`, actualUse: `How do you actually take or use ${med}?`, reason: `What do you take ${med} for, if you know?`, concerns: `Is there anything you are unsure about or finding difficult with ${med}?` },
    Q09: { substance: 'What medicine, food or other substance caused the reaction?' },
    Q10: { condition: value('relationship') ? `What condition does your ${value('relationship')} have?` : 'What condition do you know of in your family?', relationship: value('condition') ? `Which relative has ${value('condition')}?` : 'Which relative are you thinking of?' },
    Q11: { day: 'Which day are you describing?', occasions: 'What else did you eat or drink that day, and about what time?', time: 'About what time did you have that?', foods: 'What did you eat then, if anything?', drinks: 'What did you drink with that, if anything?', drinkAdditions: drink ? `Did you add anything to the ${drink}?` : 'Did you add anything to that drink?', foodAmounts: food ? `About how much ${food} did you have? An everyday description is fine.` : 'About how much food did you have? An everyday description is fine.', drinkAmounts: drink ? `About how much ${drink} did you have? A cup or glass is fine.` : 'About how much did you drink? A cup or glass is fine.' },
    Q14: { limits: 'Does anything limit the movement or activities you can do?', preference: 'Is there a movement or activity you would like to be able to do more comfortably?' },
    Q15: { schedule: 'What is your usual sleep schedule, and about how long do you sleep?', quality: 'How rested do you feel, and how does your sleep affect you during the day?', condition: 'Have you been told you have a sleep condition?', treatment: 'Do you use any treatment for that sleep condition?' },
    Q16: { depressionHistory: 'Have you ever been told you have depression?', anxietyHistory: 'Have you ever been told you have anxiety?', currentCare: 'Do you currently have any care or treatment for your mental health?', stress: 'What has been stressful for you lately, if anything?', impact: 'How is that affecting your day-to-day life?', support: 'What support do you have, or what support would you like?' },
    Q17: { substance: 'What substance would you like to tell us about?' },
    Q19: { clinicians: 'Who currently helps with your care, if anyone?', records: 'Are there any records or test results you would like the team to review?', record: 'What record or test result are you thinking of?', when: 'About when was that record or test result from?', availability: 'Do you know where that record or test result is available?' },
    Q21: { addressPreference: 'What would you like us to call you?', language: 'What language would you prefer to use?' },
    DM: { typeStatus: 'What type or status were you told you have?', when: 'About when were you told?', monitoring: 'Do you check your blood sugar, for example with a meter or sensor?', 'latestGlucose.value': 'What is the most recent blood sugar reading you know?', 'latestGlucose.unit': 'What units was that blood sugar reading in?', 'latestGlucose.measuredWhen': 'About when was that blood sugar reading taken?', 'a1c.value': 'If you know a recent A1C result, what was it?', 'a1c.unit': 'What units were reported with that A1C result?', 'a1c.measuredWhen': 'About when was that A1C result taken?', lowEvents: 'Have you had an episode you were told was low blood sugar, or thought might be low blood sugar?', 'lowEvents.description': 'What happened during that episode?', 'lowEvents.mostRecent': 'When was the most recent episode?', 'lowEvents.help': 'Did you need someone else to help during that episode?', owner: 'Who currently helps you manage it, if anyone?', concern: 'Is there a concern you would like your care team to review?' },
    COND: { termStatus: 'What have you been told about this condition?', care: 'What treatment or follow-up do you have for it?', difficulty: 'Is it causing any difficulties now?', owner: 'Who helps you manage it, if anyone?' },
    SLEEP: { treatment: 'Do you use any treatment for sleep apnea?', difficulty: 'Are you having any difficulty using that treatment?' },
    W02: { appointmentContext: 'What appointment details should staff check?', priority: 'What matters most to you for this visit?', logistics: 'Is there anything practical you need help with before the visit?' },
    W03: { update: 'What update or concern would you like to share?', timing: 'About when did this start or change?', effect: 'How is it affecting you?', help: 'What would you like the care team to help with?' },
    W04: { planContext: 'What plan or plan detail would you like the care team to check?', difficulty: 'Has anything changed or been difficult since the visit?', question: 'What question would you like the care team to review?', help: 'What support would you like from the care team?' },
    W05: { issueType: 'Is your question about a bill, coverage, payment, or something else?', serviceDate: 'What was the service date, if you know it?', requestedResolution: 'Would you like an explanation, a possible error reviewed, payment options, or staff to contact you?', reference: 'Do you have a bill or service reference you can share?', help: 'What would you like billing staff to help with?' },
    W06: { intent: 'Would you like to request, change, or cancel a visit?', visitCategory: 'Is this for a first visit or a follow-up, or are you unsure?', preferredDay: 'Which day would you prefer?', preferredWindow: 'What time of day works best for you?', requestedDate: 'Is there a particular date you would like to request?', visit: 'Which visit are you asking about, if you know?', timing: 'What dates or times would work for you?', timezone: 'What time zone should staff use?', constraints: 'Are there any timing or accessibility needs staff should consider?', help: 'What would you like scheduling staff to do next?' },
    W07: { medicine: 'Which medicine is the refill request for?', directions: 'What directions are written on the medicine label? Please do not guess if you are unsure.', actualUse: 'How do you actually take or use the medicine?', remaining: 'How much of the medicine do you have left?', pharmacy: 'Which pharmacy would you like to use?', symptomsChanges: 'Have you noticed any symptoms or changes in how you use the medicine?', help: 'What would you like your medical care team to help with?' },
  };
  const questions = ids.map(id => scoped[topic.id]?.[id]);
  if (questions.some(question => !question)) return;
  const text = questions.join(' ');
  if (topic.id === 'Q11' && time && !ids.includes('time') && itemScope(paths[0])) return `At ${time}, ${text[0].toLowerCase()}${text.slice(1)}`;
  return text;
}

/** Several missing slots may share one exact question; one collection item remains one conversational scope. */
export function eligibleAdaptiveProbes(context: AdaptiveContext, rejectedTargets: readonly RejectedTarget[] = []): EligibleProbe[] {
  if (context.safetyPaused) return [];
  const evidence = { validSourceIds: new Set(context.sources.filter(source => source.role === 'patient').map(source => source.id)) };
  const probes: EligibleProbe[] = [];
  for (const topic of context.topics) {
    const response = context.responses[topic.id] ?? empty();
    if (response.stopped) continue;
    if (context.nativeRouting) {
      const field = nextNativeGuidedField(topic, response, evidence, { topics: context.nativeRouting.topics ?? Object.fromEntries(Object.entries(context.responses).filter((entry): entry is [string, TopicResponse] => !!entry[1])), context: context.nativeRouting.context });
      if (field && adaptiveSlot(topic, response, field.path).definition.optional && !rejectedTargets.some(target => target.topicId === topic.id && target.path === field.path)) {
        const exact = promptsById[field.promptIds[0]];
        if (exact) probes.push({ topicId: topic.id, promptId: field.promptIds[0], targetPaths: [field.path], kind: /^MH0[1-4]$/.test(field.promptIds[0]) ? 'instrument' : 'question', text: /^MH0[1-4]$/.test(field.promptIds[0]) ? `${promptsById['MH.stem'].text}\n${exact.text}` : exact.text, labels: [field.label], optional: topic.presentation === 'O' });
      }
    }
    // Authored specificity follow-ups (opt-in per context): naming questions lead their topic in order; other detail is optional and follows it.
    const identity: EligibleProbe[] = [], detail: EligibleProbe[] = [];
    if (context.specificity) for (const { finding, text, mark } of specificityProbes(specificityFindings({ [topic.id]: response }, context.specificity), context.specificity)) {
      const promptId = adaptiveSlot(topic, response, finding.path).definition.promptIds[0];
      if (!promptId || rejectedTargets.some(target => target.topicId === topic.id && target.path === finding.path)) continue;
      (finding.contract.kind === 'entity' ? identity : detail).push({ topicId: topic.id, promptId, targetPaths: [finding.path], kind: 'question', text, labels: [finding.contract.missing], optional: topic.presentation === 'O' || finding.contract.kind !== 'entity', specificity: mark });
    }
    probes.push(...identity);
    const readiness = evaluateTopic(topic, response, evidence);
    if (readiness.sufficient || readiness.collection === 'not-applicable' || topic.presentation === 'C' && response.applicability !== 'applicable') { probes.push(...detail); continue; }
    const missing = readiness.slots.filter(slot => slot.state === 'unresolved' && slot.promptIds.length && !['unanswered', 'invalid-evidence', 'condition-unresolved'].includes(slot.reason ?? ''));
    const groups = new Map<string, EligibleProbe>();
    for (const slot of missing) {
      if (rejectedTargets.some(target => target.topicId === topic.id && target.path === slot.id)) continue;
      const { definition, answer } = adaptiveSlot(topic, response, slot.id);
      if (definition.kind === 'configuration') continue;
      // A missing precision cannot turn an explicitly unavailable measurement date into a new question.
      if (slot.id === 'lastMeasuredWeight.datePrecision' && ['unknown', 'uncertain', 'declined', 'skipped', 'not-applicable'].includes(response.answers['lastMeasuredWeight.measuredWhen']?.state ?? '')) continue;
      if (definition.kind === 'collection' && answer?.state === 'known' && answer.items?.length) {
        if (missing.some(child => child.id.startsWith(`${slot.id}[`))) continue;
        if (!answer.complete) probes.push({ topicId: topic.id, promptId: '__list-completion', targetPaths: [slot.id], kind: 'list-completion', text: 'Is that everything you wanted to add to this list, or is there something else?', labels: [definition.label], optional: topic.presentation === 'O' });
        continue;
      }
      const promptId = slot.promptIds[0], instrument = /^MH0[1-4]$/.test(promptId);
      const prompt = promptsById[promptId];
      if (!prompt) continue;
      const key = `${promptId}:${itemScope(slot.id)}`;
      const group = groups.get(key);
      if (group) { group.targetPaths = [...group.targetPaths, slot.id]; group.labels.push(definition.label); continue; }
      const text = instrument ? `${promptsById['MH.stem'].text}\n${prompt.text}` : prompt.text;
      groups.set(key, { topicId: topic.id, promptId, targetPaths: [slot.id], kind: instrument ? 'instrument' : 'question', text, labels: [definition.label], optional: topic.presentation === 'O', ...(instrument ? { choices: mentalHealthOptions.phq4.choices } : {}) });
    }
    for (const group of groups.values()) {
      if (group.kind === 'instrument') continue; // Frozen instruments keep their exact wording/options.
      const field = adaptiveSlot(topic, response, group.targetPaths[0]);
      const coverage = field.definitions.filter(definition => definition.promptIds?.includes(group.promptId));
      // The content question may cover several details. Once some are answered, ask only remaining targets.
      const narrowed = itemScope(group.targetPaths[0]) && group.promptId === topic.openingPromptId || coverage.some(definition => !group.targetPaths.includes(`${itemScope(group.targetPaths[0])}${itemScope(group.targetPaths[0]) ? '.' : ''}${definition.id}`));
      // Refill help must not presume a difficulty; questions and requested help are distinct targets.
      const scopedText = narrowed || topic.id === 'W07' && group.targetPaths.includes('help') ? scopedQuestion(topic, response, group.targetPaths) : undefined;
      if (scopedText) {
        group.text = scopedText;
        group.wording = { version: 'S2.scoped.2', status: 'proposed-detail', sourcePromptId: group.promptId };
      } else if (itemScope(group.targetPaths[0])) {
        const anchor = ['name', 'time', 'foods', 'drinks'].map(key => field.siblings[key]).find(answer => answer?.state === 'known' && typeof answer.value === 'string');
        if (anchor?.state === 'known') group.text = `Thinking about ${anchor.value}, ${group.text[0].toLowerCase()}${group.text.slice(1)}`;
      }
      const verified = context.nativeRouting?.context;
      if (group.promptId === 'S01' && verified?.appointment) group.text = group.text.replace('[verified date/time/timezone]', `${verified.appointment.startsAt} ${verified.appointment.timezone}`).replace('[dated prior update]', verified.appointment.priorUpdateAt);
      if (group.promptId === 'S03' && verified?.plan) group.text = group.text.replace('[demo author/role]', verified.plan.author).replace('[date]', verified.plan.recordedAt);
      if (/\[[^\]]+\]/.test(group.text)) {
        // AdaptiveContext currently carries no verified appointment/plan
        // identity. A patient's recollection cannot fill trusted templates.
        const scenario = scenarios[context.binding.scenario], fallback = scenario.missingContextPromptId;
        const local = fallback && topic.id === scenario.workflowId ? promptsById[fallback] : undefined;
        const detail = scopedQuestion(topic, response, group.targetPaths);
        if (local) { group.promptId = fallback!; group.text = local.text; }
        else if (detail && !/\[[^\]]+\]/.test(detail)) group.text = detail;
      }
    }
    probes.push(...[...groups.values()].filter(group => !/\[[^\]]+\]/.test(group.text)), ...detail);
  }
  return probes.filter(probe => {
    if (!context.nativeRouting) return true;
    try {
      for (const path of probe.targetPaths) {
        const promptId = probe.promptId === '__list-completion' ? adaptiveSlot(context.topics.find(t => t.id === probe.topicId)!, context.responses[probe.topicId] ?? empty(), path).definition.promptIds?.[0] : probe.promptId;
        guardNativePrompt({ promptId, topicId: probe.topicId, path, text: probe.kind === 'instrument' ? promptsById[probe.promptId].text : probe.text, scenario: context.binding.scenario, relevantTopicIds: context.nativeRouting.relevantTopicIds, topics: context.nativeRouting.topics ?? Object.fromEntries(Object.entries(context.responses).filter((entry): entry is [string, TopicResponse] => !!entry[1])), repeatResolutionTopics: context.nativeRouting.repeatResolutionTopics ?? Object.fromEntries(Object.entries(context.responses).filter((entry): entry is [string, TopicResponse] => !!entry[1])), context: context.nativeRouting.context }, evidence);
      }
      return true;
    } catch { return false; }
  });
}

const standardReplies = {
  'COPY-02': () => promptsById['COPY-02']?.text,
  'COPY-04': () => promptsById['COPY-04']?.text,
  'COPY-05': () => promptsById['COPY-05']?.text,
  unsupported: () => "I don't have that information in this demo. I can include your question for the care team to review.",
} as const;

/** No patient-facing clinical prose comes from the model. Ordering may follow the patient's agenda. */
function selectAdaptiveDialogueUnchecked(context: AdaptiveContext, outcome?: AdaptiveOutcome): DialogueOutcome {
  return selectDialogue(context, outcome);
}
/** V6-only, locally issued dispositions. Preserve gaps; suppress only rejected roles before wording. */
export function selectAdaptiveGroupDialogue(context: AdaptiveContext, groups: ValidatedAdaptiveGroups): DialogueOutcome {
  const targets = adaptiveGroupRejectedTargets(context, groups);
  const outcome = { ...groups.outcome, clarifications: [...groups.patientClarifications], hasUnresolvedInterpretation: groups.hasInterpretationGaps };
  return guardDialogue(context, outcome, selectDialogue(context,outcome,targets));
}
/** Exact production exclusions, also exposed for offline eligibility qualification. */
export function adaptiveGroupRejectedTargets(context: AdaptiveContext, groups: ValidatedAdaptiveGroups): RejectedTarget[] {
  assertValidatedAdaptiveGroups(context, groups);
  // Must match adaptive-validation.ts and adaptive-group-compile.ts; capture item ids are limited to ^[A-Za-z0-9_-]{1,64}$.
  const sourceCode = context.source.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  const targets: RejectedTarget[] = groups.semanticRejections.filter(rejection => {
    if (groups.sourceProtocol !== 'scoped-groups-v7' || rejection.topicId !== 'Q03' || rejection.reason !== 'unscoped-response' || adaptiveHistoryWindowUncertainty(context, rejection.path)) return true;
    const scopes = adaptiveHistoryScopes(context, rejection.evidence);
    // Only evidence positively scoped to another retained window can release a
    // missing-window probe. Dispositions/gaps remain intact; no readiness credit.
    return !(scopes.length === 1 && scopes[0] !== rejection.path && groups.outcome.provenance.some(provenance => provenance.topicId === 'Q03' && provenance.path === scopes[0]
      && JSON.stringify(provenance.evidence) === JSON.stringify(rejection.evidence)));
  }).map(({topicId,path})=>({topicId,path}));
  for (const candidate of groups.rejectedCandidates) {
    if (!candidate.topicId || !candidate.path) continue;
    const match = /^([^\[]+)\[new:([^\]]+)\]\.(.+)$/.exec(candidate.path);
    if (!match) { targets.push({topicId:candidate.topicId,path:candidate.path}); continue; }
    const index = groups.proposal.newItems.findIndex(item=>item.key===match[2] && item.topicId===candidate.topicId && item.collection===match[1]);
    const itemId = `a${sourceCode}_${index}`;
    const saved = groups.outcome.responses[candidate.topicId]?.answers[match[1]];
    const exists = index >= 0 && saved?.state === 'known' && saved.items?.some(item=>item.id===itemId);
    targets.push({topicId:candidate.topicId,path:exists ? `${match[1]}[${itemId}].${match[3]}` : match[1]});
  }
  return targets;
}
function selectDialogue(context: AdaptiveContext, outcome?: AdaptiveOutcome, rejectedTargets?: readonly RejectedTarget[]): DialogueOutcome {
  const state: DialogueState = { ...context.dialogue };
  const nextContext = { ...context, responses: outcome?.responses ?? context.responses };
  if (context.safetyPaused) return { state, status: 'paused' };
  const probes = eligibleAdaptiveProbes(nextContext,rejectedTargets);
  const acts = outcome?.acts ?? [];
  const explicitTopic = acts.find(act => act.kind === 'topic-switch')?.targetTopicId;
  const question = acts.filter(act => act.kind === 'question').sort((a, b) => (a.replyId === 'COPY-05' ? 0 : a.replyId === 'COPY-04' ? 1 : 2) - (b.replyId === 'COPY-05' ? 0 : b.replyId === 'COPY-04' ? 1 : 2))[0];
  const stopped = new Set(acts.filter(act => act.kind === 'move-on').map(act => act.targetTopicId));
  if (state.activeTopicId && stopped.has(state.activeTopicId)) delete state.activeTopicId;
  if (state.suspended && stopped.has(state.suspended.topicId)) delete state.suspended;
  if (explicitTopic) { state.activeTopicId = explicitTopic; delete state.suspended; }
  const response: DialogueOutcome = { state, status: 'review-available' };
  if (question) {
    const id = question.replyId ?? 'unsupported';
    const local = context.approvedReplies?.find(reply => reply.id === id);
    const text = id in standardReplies ? standardReplies[id as keyof typeof standardReplies]() : local?.text;
    response.reply = { id: text ? id : 'unsupported', text: text ?? standardReplies.unsupported() };
    if (!explicitTopic && context.displayed && !stopped.has(context.displayed.topicId)) state.suspended = { ...context.displayed };
  }
  // A neutral acknowledgement of an unplaced disclosure, or a spoken-number confirmation, is not a failed attempt at the question.
  const unsuccessful = outcome && !outcome.acknowledgement && !outcome.clarifications.some(item => item.confirm) && !question && !explicitTopic && !outcome.updates.length && outcome.hasUnresolvedInterpretation && (rejectedTargets === undefined || outcome.clarifications.some(item=>item.reason==='conflict'));
  const failed = unsuccessful ? outcome.clarifications.find(item => !['stopped-topic', 'condition-unresolved'].includes(item.reason)) : undefined;
  const failedTopic = failed?.topicId ?? (unsuccessful ? context.displayed?.topicId : undefined);
  const failedPaths = failed ? [failed.path] : context.displayed?.targetPaths ?? [];
  if (failedTopic) {
    const previous = state.lastUnsuccessful;
    const same = previous?.topicId === failedTopic && JSON.stringify(previous.targetPaths) === JSON.stringify(failedPaths);
    const count = same ? previous.count + (previous.sourceId === outcome!.sourceId ? 0 : 1) : 1;
    state.lastUnsuccessful = { topicId: failedTopic, targetPaths: failedPaths, sourceId: outcome!.sourceId, count, ...(context.nativeRouting ? { purposeExplained: true } : {}) };
    if (context.nativeRouting && count === 1 && !response.reply) response.reply = { id: 'COPY-02', text: promptsById['COPY-02'].text };
    if (count >= 2) {
      response.prompt = { topicId: failedTopic, promptId: '__engagement-choice', targetPaths: failedPaths, kind: 'question', text: 'Would you rather move on or come back to this?', labels: [], optional: false };
      response.status = 'clarification';
      return response;
    }
  } else if (outcome?.updates.length || explicitTopic || stopped.size) delete state.lastUnsuccessful;
  const clarification = outcome?.clarifications.find(item => !['stopped-topic', 'condition-unresolved'].includes(item.reason) && !stopped.has(item.topicId) && !nextContext.responses[item.topicId]?.stopped);
  if (clarification && !explicitTopic) {
    response.clarification = clarification;
    const definition = context.topics.find(topic => topic.id === clarification.topicId);
    const known = probes.find(probe => probe.topicId === clarification.topicId && probe.targetPaths.includes(clarification.path));
    if (clarification.confirm && definition) {
      const field = adaptiveSlot(definition, nextContext.responses[definition.id] ?? empty(), clarification.path).definition;
      // Proposed (not approved) wording that only reads back the patient's own spoken number; the value is recorded only after a plain yes.
      response.prompt = { topicId: definition.id, promptId: '__clarify-record', targetPaths: [clarification.path], kind: 'question', text: clarification.confirm.text, labels: [field.label], optional: definition.presentation === 'O',
        wording: { version: 'spoken-number-confirm.1', status: 'proposed-detail', sourcePromptId: field.promptIds[0] ?? definition.openingPromptId, confirm: structuredClone(clarification.confirm) } };
    }
    else if (known) response.prompt = known;
    else if (definition) {
      const field = adaptiveSlot(definition, nextContext.responses[definition.id] ?? empty(), clarification.path).definition;
      // Conflicting alternatives are displayed separately; this is a record-correction control, not new care content.
      response.prompt = { topicId: definition.id, promptId: '__clarify-record', targetPaths: [clarification.path], kind: 'question', text: clarification.reason === 'conflict' ? 'Which statement would you like recorded? You can also leave this uncertain.' : 'Could you clarify this detail, or would you rather leave it unknown?', labels: [field.label], optional: definition.presentation === 'O' };
    }
    state.activeTopicId = clarification.topicId;
    response.status = 'clarification';
    return response;
  }
  const nomination = outcome?.nomination;
  if (rejectedTargets && outcome?.hasUnresolvedInterpretation && !explicitTopic && !probes.some(probe=>!probe.optional)) {
    response.status = 'interpretation-review';
    return response;
  }
  // A nomination never picks an optional detail follow-up ahead of the topic's core questions.
  const nominated = nomination && probes.find(probe => !(probe.specificity && probe.optional) && probe.topicId === nomination.topicId && probe.promptId === nomination.promptId && nomination.targetPaths.every(path => probe.targetPaths.includes(path)));
  const preferredTopic = explicitTopic ?? state.suspended?.topicId ?? state.activeTopicId ?? context.displayed?.topicId;
  const selected = (explicitTopic ? probes.find(probe => probe.topicId === explicitTopic) : undefined)
    ?? (question && state.suspended ? probes.find(probe => probe.topicId === state.suspended!.topicId) : undefined)
    ?? (nominated?.topicId === preferredTopic ? nominated : undefined)
    ?? probes.find(probe => probe.topicId === preferredTopic)
    ?? nominated
    ?? probes.find(probe => !probe.optional)
    ?? probes[0];
  if (selected) {
    response.prompt = selected;
    state.activeTopicId = selected.topicId;
    response.status = 'question';
  }
  else if (rejectedTargets && outcome?.hasUnresolvedInterpretation) response.status = 'interpretation-review';
  if (!question) delete state.suspended;
  return response;
}

/** Safe content metadata for the proposer, with no patient identity or persistence state. */
export function adaptiveTargetCatalog(topics: readonly TopicDefinition[], responses: AdaptiveContext['responses']) {
  return topics.map(topic => {
    const response = responses[topic.id] ?? empty();
    const fields: unknown[][] = [];
    const collections: { path: string; label: string; acceptsNegative: boolean; fields: unknown[][]; existingItems: { id: string; paths: string[] }[] }[] = [];
    const allowed = (definition: TopicDefinition['slots'][number]) => !/^MH0[1-4]$/.test(definition.id) && definition.kind !== 'configuration' && definition.id !== 'currentWeightEstimate.statedAt';
    const tuple = (definition: TopicDefinition['slots'][number], path: string) => [path, definition.label, definition.kind, definition.choices ?? null, definition.acceptsNegative ? 1 : 0, definition.acceptsNotApplicable ? 1 : 0, definition.when ?? null];
    for (const definition of topic.slots.filter(allowed)) {
      if (definition.kind !== 'collection') { fields.push(tuple(definition, definition.id)); continue; }
      const children = (definition.fields ?? []).filter(allowed);
      const answer = response.answers[definition.id];
      const items = answer?.state === 'known' ? answer.items ?? [] : [];
      collections.push({ path: definition.id, label: definition.label, acceptsNegative: !!definition.acceptsNegative, fields: children.map(child => tuple(child, child.id)), existingItems: items.map(item => ({ id: item.id, paths: children.map(child => `${definition.id}[${item.id}].${child.id}`) })) });
    }
    return { id: topic.id, applicability: response.applicability, stopped: response.stopped, fields, collections };
  });
}

/** Final dispatcher gate applies to clarification/control paths as well as ordinary eligible probes. */
function guardDialogue(context: AdaptiveContext, outcome: AdaptiveOutcome | undefined, result: DialogueOutcome): DialogueOutcome {
  if (!context.nativeRouting || !result.prompt) return result;
  const candidate = result.prompt, responses = outcome?.responses ?? context.responses;
  const topics = Object.fromEntries(Object.entries(responses).filter((entry): entry is [string, TopicResponse] => !!entry[1]));
  const evidence = { validSourceIds: new Set(context.sources.filter(source => source.role === 'patient').map(source => source.id)) };
  try {
    if (candidate.promptId === '__engagement-choice') { candidate.promptId = 'stop-choice'; candidate.text = promptsById['stop-choice'].text; }
    else if (candidate.promptId === '__clarify-record') candidate.promptId = adaptiveSlot(context.topics.find(t => t.id === candidate.topicId)!, topics[candidate.topicId] ?? empty(), candidate.targetPaths[0]).definition.promptIds[0];
    const failure = result.state.lastUnsuccessful;
    const routingContext = candidate.promptId === 'stop-choice' && failure?.purposeExplained ? { ...context.nativeRouting.context, engagementUnclear: { topicId: failure.topicId, path: failure.targetPaths[0], sourceIds: [failure.sourceId], purposeExplained: true as const, unsuccessfulAttempts: failure.count } } : context.nativeRouting.context;
    for (const path of candidate.targetPaths.length ? candidate.targetPaths : ['']) {
      const promptId = candidate.promptId === '__list-completion' ? adaptiveSlot(context.topics.find(t => t.id === candidate.topicId)!, topics[candidate.topicId] ?? empty(), path).definition.promptIds[0] : candidate.promptId;
      guardNativePrompt({ promptId, topicId: candidate.topicId, ...(promptId !== 'stop-choice' ? { path } : {}), text: candidate.kind === 'instrument' ? promptsById[promptId].text : candidate.text, scenario: context.binding.scenario, relevantTopicIds: context.nativeRouting.relevantTopicIds, topics: context.nativeRouting.topics ?? topics, repeatResolutionTopics: context.nativeRouting.repeatResolutionTopics ?? topics, context: routingContext }, evidence);
    }
  } catch { delete result.prompt; result.status = 'review-available'; }
  return result;
}

export function selectAdaptiveDialogue(context: AdaptiveContext, outcome?: AdaptiveOutcome): DialogueOutcome { return guardDialogue(context, outcome, selectAdaptiveDialogueUnchecked(context, outcome)); }
