import type { ContentContract } from '../../clinical-core/src/domain.js';
import { documentProvenance, topicText } from './content.js';
import { conditionBranches } from './branches.js';
import { scenarios } from './scenarios.js';
import { coreSlots, mentalHealthSlots } from './slots.js';
import { ContentConfigurationError, type EvidenceContext, type MentalHealthChoice, type TopicDefinition, type TopicResponse } from './types.js';
import { evaluateTopic } from './readiness.js';

import { approvedMentalHealthSelection, mentalHealthOptions, promptsById, stopSemantics } from './content-constants.js';
export { approvedMentalHealthSelection, mentalHealthOptions, promptsById, stopSemantics, type RuntimePrompt } from './content-constants.js';

/** The default follows the recorded targeted choice; explicit pending remains a truthful partial workflow. */
export function createClinicContent(configuration: { mentalHealth: MentalHealthChoice } = approvedMentalHealthSelection) {
  if (!configuration || !['phq4','unscored','pending'].includes(configuration.mentalHealth)) throw new ContentConfigurationError('mental-health-selection-required');
  const choice = configuration.mentalHealth;
  const topics: readonly TopicDefinition[] = topicText.map(text => ({
    ...text, slots: text.id === 'Q16' ? [...coreSlots.Q16.slice(0,3), ...(choice === 'pending' ? [{ id:'mentalHealth.configuration',label:'Current depression/anxiety check selection is pending',kind:'configuration' as const,promptIds:[] }] : mentalHealthSlots[choice]), ...coreSlots.Q16.slice(3)] : coreSlots[text.id],
    stopWhen:stopSemantics.reasons, visibility:'assigned-clinical-full' as const,
  }));
  return { provenance:documentProvenance, mentalHealth:choice, mentalHealthOption:mentalHealthOptions[choice], topics, promptsById, branches:conditionBranches, scenarios, stopSemantics } as const;
}
export type ClinicContent = ReturnType<typeof createClinicContent>;

/** Does not manufacture an approval or a trusted sufficiency assessment. */
export function toContentContractDefinition(register: ClinicContent, topics: readonly TopicDefinition[] = register.topics): Omit<ContentContract,'approval'> {
  return {
    version:`${register.provenance.version}.${register.mentalHealth}`, questionnaire:`https://corvo.example/Questionnaire/adult-intake/${register.provenance.version}/${register.mentalHealth}`,
    questions:topics.map(topic=>({id:topic.id,requiredForComplete:topic.presentation !== 'O',requiresAnsweredValue:topic.id === 'Q04',detailTargets:topic.slots.filter(slot=>!slot.optional).map(slot=>slot.id),stopWhen:[...topic.stopWhen]})),
  };
}

export function evaluateRequiredMeasurements(response: TopicResponse, evidence: EvidenceContext) {
  const definition: TopicDefinition = {id:'Q04',presentation:'R-value',openingPromptId:'Q04',slots:coreSlots.Q04,minimumDetailText:'Required height, measured weight/date/units, and separate current estimate when needed.',stopWhen:stopSemantics.reasons,visibility:'assigned-clinical-full'};
  const readiness = evaluateTopic(definition,response,evidence);
  return { ...readiness, measuredWeightSource:'patient-reported-measured' as const, estimateSource:'patient-reported-estimate' as const, hasClinicalRecencyCutoff:false as const, clinicalClearance:false as const };
}
