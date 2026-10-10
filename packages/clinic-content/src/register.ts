import type { ContentContract } from '../../clinical-core/src/domain.js';
import { documentProvenance, promptText, supplementalPromptText, topicText } from './content.js';
import { conditionBranches } from './branches.js';
import { scenarios } from './scenarios.js';
import { coreSlots, mentalHealthSlots } from './slots.js';
import { ContentConfigurationError, type EvidenceContext, type MentalHealthChoice, type TopicDefinition, type TopicResponse } from './types.js';
import { evaluateTopic } from './readiness.js';

export const stopSemantics = {
  reasons: ['target-met','does-not-know','not-applicable','patient-declines','patient-moves-on','resistance-after-purpose','safety-interruption'],
  unknownStops: 'the missing detail only; independent targets may continue when the patient is receptive',
  resistanceStops: 'the topic; never inferred from face, voice or affect',
  clarificationCountLimit: null,
  partialHandoffAllowed: true,
  urgentHelpWaitsForCollection: false,
} as const;

export const approvedMentalHealthSelection = { mentalHealth:'phq4', selectedBy:'Jake', selectedOn:'2026-10-09', scope:'PHQ-4 with clinician review', clinicalProtocolApproval:false } as const;

export const mentalHealthOptions = {
  pending: { status:'unselected', scoring:'disabled', instruction:'Keep explicit depression/anxiety history and stress/support collection. Current-symptom implementation is unresolved; no implicit instrument or unscored alternative.' },
  phq4: { status:'accepted-targeted-choice', scoring:'explicit-complete-only-helper', stemPromptId:'MH.stem', introPromptId:'COPY-10', itemIds:['MH01','MH02','MH03','MH04'], choices:[{value:0,label:'Not at all'},{value:1,label:'Several days'},{value:2,label:'More than half the days'},{value:3,label:'Nearly every day'}], attribution:'Developed by Drs. Robert L. Spitzer, Janet B. W. Williams, Kurt Kroenke and colleagues with an educational grant from Pfizer Inc.', source:'https://www.phqscreeners.com/images/sites/g/files/g10016261/f/201412/instructions.pdf', instruction:'Exact stem/items/choices only, with explicit confirmed responses. No inference from vague language, diagnoses, past answers or missing items. Clinician review is required; a low score is not clearance.' },
  unscored: { status:'proposed-detail', scoring:'disabled', promptId:'MH.unscored', instruction:'Original unvalidated collection wording; never label this PHQ/GAD or calculate an instrument result.' },
} as const;

export interface RuntimePrompt { readonly id: string; readonly text: string; readonly origin: string; readonly wordingStatus: string }
export const promptsById: Readonly<Record<string, RuntimePrompt>> = Object.fromEntries([...promptText,...supplementalPromptText].map(prompt=>[prompt.id,prompt]));

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
