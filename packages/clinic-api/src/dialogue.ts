import { evaluateTopic, mentalHealthOptions, promptsById, type TopicDefinition, type TopicResponse } from '../../clinic-content/src/index.js';
import { adaptiveSlot, type AdaptiveContext, type AdaptiveOutcome, type DialogueState, type DisplayedPrompt } from './adaptive-validation.js';

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
  status: 'question' | 'clarification' | 'review-available' | 'paused';
}
const empty = (): TopicResponse => ({ presented: false, answers: {} });
const itemScope = (path: string) => path.includes('].') ? path.slice(0, path.lastIndexOf('].') + 1) : '';

/** Several missing slots may share one exact question; one collection item remains one conversational scope. */
export function eligibleAdaptiveProbes(context: AdaptiveContext): EligibleProbe[] {
  if (context.safetyPaused) return [];
  const evidence = { validSourceIds: new Set(context.sources.filter(source => source.role === 'patient').map(source => source.id)) };
  const probes: EligibleProbe[] = [];
  for (const topic of context.topics) {
    const response = context.responses[topic.id] ?? empty();
    if (response.stopped) continue;
    const readiness = evaluateTopic(topic, response, evidence);
    if (readiness.sufficient || readiness.collection === 'not-applicable' || topic.presentation === 'C' && response.applicability !== 'applicable') continue;
    const missing = readiness.slots.filter(slot => slot.state === 'unresolved' && slot.promptIds.length && !['unanswered', 'invalid-evidence', 'condition-unresolved'].includes(slot.reason ?? ''));
    const groups = new Map<string, EligibleProbe>();
    for (const slot of missing) {
      const { definition, answer } = adaptiveSlot(topic, response, slot.id);
      if (definition.kind === 'configuration') continue;
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
    probes.push(...groups.values());
  }
  return probes;
}

const standardReplies = {
  'COPY-02': () => promptsById['COPY-02']?.text,
  'COPY-04': () => promptsById['COPY-04']?.text,
  'COPY-05': () => promptsById['COPY-05']?.text,
  unsupported: () => "I don't have that information in this demo. I can include your question for the care team to review.",
} as const;

/** No patient-facing clinical prose comes from the model. Ordering may follow the patient's agenda. */
export function selectAdaptiveDialogue(context: AdaptiveContext, outcome?: AdaptiveOutcome): DialogueOutcome {
  const state: DialogueState = { ...context.dialogue };
  const nextContext = { ...context, responses: outcome?.responses ?? context.responses };
  if (context.safetyPaused) return { state, status: 'paused' };
  const probes = eligibleAdaptiveProbes(nextContext);
  const acts = outcome?.acts ?? [];
  const explicitTopic = acts.find(act => act.kind === 'topic-switch')?.targetTopicId;
  const question = acts.find(act => act.kind === 'question');
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
  const clarification = outcome?.clarifications.find(item => !['stopped-topic', 'condition-unresolved'].includes(item.reason) && !stopped.has(item.topicId) && !nextContext.responses[item.topicId]?.stopped);
  if (clarification && !explicitTopic) {
    response.clarification = clarification;
    const definition = context.topics.find(topic => topic.id === clarification.topicId);
    const known = probes.find(probe => probe.topicId === clarification.topicId && probe.targetPaths.includes(clarification.path));
    if (known) response.prompt = known;
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
  const nominated = nomination && probes.find(probe => probe.topicId === nomination.topicId && probe.promptId === nomination.promptId && nomination.targetPaths.every(path => probe.targetPaths.includes(path)));
  const preferredTopic = explicitTopic ?? state.suspended?.topicId ?? state.activeTopicId ?? context.displayed?.topicId;
  const selected = (explicitTopic ? probes.find(probe => probe.topicId === explicitTopic) : undefined)
    ?? (question && state.suspended ? probes.find(probe => probe.topicId === state.suspended!.topicId) : undefined)
    ?? nominated
    ?? probes.find(probe => probe.topicId === preferredTopic)
    ?? probes.find(probe => !probe.optional)
    ?? probes[0];
  if (selected) {
    response.prompt = selected;
    state.activeTopicId = selected.topicId;
    response.status = 'question';
  }
  if (!question) delete state.suspended;
  return response;
}

/** Safe content metadata for the proposer, with no patient identity or persistence state. */
export function adaptiveTargetCatalog(topics: readonly TopicDefinition[], responses: AdaptiveContext['responses']) {
  return topics.map(topic => {
    const response = responses[topic.id] ?? empty();
    const fields: { path: string; label: string; kind: string; choices?: readonly (string | number | boolean)[]; acceptsNegative?: boolean; acceptsNotApplicable?: boolean; when?: unknown }[] = [];
    function walk(definitions: TopicDefinition['slots'], prefix: string, answers: TopicResponse['answers']) {
      for (const definition of definitions) {
        if (/^MH0[1-4]$/.test(definition.id) || definition.kind === 'configuration' || definition.id === 'currentWeightEstimate.statedAt') continue;
        fields.push({ path: `${prefix}${definition.id}`, label: definition.label, kind: definition.kind, choices: definition.choices, acceptsNegative: definition.acceptsNegative, acceptsNotApplicable: definition.acceptsNotApplicable, when: definition.when });
        if (definition.fields) {
          // The @new notation is catalog-only. Proposals create collection items through newItems, never paths with @new.
          walk(definition.fields, `${prefix}${definition.id}[@new].`, {});
          const value = answers[definition.id];
          if (value?.state === 'known' && value.items) for (const item of value.items) walk(definition.fields, `${prefix}${definition.id}[${item.id}].`, item.answers);
        }
      }
    }
    walk(topic.slots, '', response.answers);
    return { id: topic.id, minimumDetail: topic.minimumDetailText, applicability: response.applicability, stopped: response.stopped, fields };
  });
}
