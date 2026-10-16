import type { ContentContract } from '../../clinical-core/src/domain.js';
import type { documentProvenance } from './content.js';
import type { conditionBranches } from './branches.js';
import type { scenarios } from './scenarios.js';
import { coreSlots } from './slots.js';
import type { EvidenceContext, MentalHealthChoice, TopicDefinition, TopicResponse } from './types.js';
import { evaluateTopic } from './readiness.js';
import { compilePack } from './pack-compile.js';
import { adultIntakePack } from './packs/adult-intake.js';

import { approvedMentalHealthSelection, mentalHealthOptions, promptsById, stopSemantics } from './content-constants.js';
export { approvedMentalHealthSelection, mentalHealthOptions, promptsById, stopSemantics, type RuntimePrompt } from './content-constants.js';

/** Explicit legacy shape prevents a recursive ReturnType across register and compiler. */
interface ClinicContentDefinition {
  readonly provenance: typeof documentProvenance;
  readonly mentalHealth: MentalHealthChoice;
  readonly mentalHealthOption: typeof mentalHealthOptions[MentalHealthChoice];
  readonly topics: readonly TopicDefinition[];
  readonly promptsById: typeof promptsById;
  readonly branches: typeof conditionBranches;
  readonly scenarios: typeof scenarios;
  readonly stopSemantics: typeof stopSemantics;
}

/** The default follows the recorded targeted choice; explicit pending remains a truthful partial workflow. */
export function createClinicContent(configuration: { mentalHealth: MentalHealthChoice } = approvedMentalHealthSelection): ClinicContentDefinition {
  return compilePack(adultIntakePack, configuration);
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
