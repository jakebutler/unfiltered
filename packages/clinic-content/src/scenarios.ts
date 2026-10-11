import type { EvidenceContext, ScenarioId, SlotDefinition, TopicDefinition, TopicId, TopicResponse } from './types.js';
import { conditionBranches, diabetesBranchApplicability } from './branches.js';
import { hasValidEvidence } from './readiness.js';

const f = (id: string, label: string, promptIds: string[], acceptsNegative = false): SlotDefinition => ({ id, label, kind: 'text', promptIds, acceptsNegative });
const choice = (id:string,label:string,promptIds:string[],choices:readonly string[]):SlotDefinition => ({id,label,kind:'choice',promptIds,choices});
const topic = (id: string, openingPromptId: string, slots: SlotDefinition[]): TopicDefinition => ({ id, openingPromptId, slots, presentation: 'R', minimumDetailText: slots.map(s=>s.label).join('; '), visibility: 'assigned-clinical-full', stopWhen: ['target-met','does-not-know','patient-declines','patient-moves-on','resistance-after-purpose','safety-interruption'] });
export interface ScenarioTemplate {
  readonly id: ScenarioId;
  readonly workflowId: string;
  /** Patient-facing purpose; completion and ownership metadata is for staff/engineering. */
  readonly patientSummary: string;
  readonly openingPromptId: string;
  readonly missingContextPromptId?: string;
  readonly contextRequirement: string;
  readonly reusableTopicIds: readonly TopicId[];
  readonly additionalTopics: readonly TopicDefinition[];
  readonly owners: readonly ('medical'|'nutrition'|'admin')[];
  readonly missingContextOwner?: 'medical'|'admin';
  readonly completion: string;
  readonly detailStatus: 'proposed-detail';
}

export const scenarios: Readonly<Record<ScenarioId, ScenarioTemplate>> = {
  'first-intake': { id:'first-intake', workflowId:'W01', patientSummary:'Share your health history and what you want help with before your first visit.', openingPromptId:'Q01', contextRequirement:'Seeded appointment is explicit context, never invented from conversation.', reusableTopicIds:Array.from({length:22},(_,i)=>`Q${String(i+1).padStart(2,'0')}` as TopicId), additionalTopics:[], owners:['medical','nutrition'], completion:'Complete intake requires applicable minimum targets including Q04. A confirmed partial handoff remains permitted. Medical and nutrition review/disposition are separate.', detailStatus:'proposed-detail' },
  'pre-visit': { id:'pre-visit', workflowId:'W02', patientSummary:'Share updates and questions for your upcoming visit.', openingPromptId:'S01', missingContextPromptId:'S01a', contextRequirement:'Verified appointment date/time/timezone and dated prior update; otherwise use S01a and explicit context-check work.', reusableTopicIds:['Q02','Q08','Q09','Q20'], additionalTopics:[topic('W02','S01',[f('appointmentContext','Verified appointment/context or explicit mismatch',['S01','S01a']),f('changes','Relevant dated changes or no changes',['W02.followup.1'],true),f('priority','Current visit priority',['W02.followup.2']),{...f('logistics','Needed logistics or none',['S01a','Q20'],true),extractionNegativeScope:'composite'}])], owners:['medical','nutrition'],missingContextOwner:'admin',completion:'Each relevant care owner reviews the update and records a next step. Appointment mismatch has admin ownership. An update is not check-in or appointment confirmation.',detailStatus:'proposed-detail' },
  'non-visit': { id:'non-visit', workflowId:'W03', patientSummary:'Send an update or ask your care team for help between visits.', openingPromptId:'S02',contextRequirement:'No appointment required.',reusableTopicIds:['Q01','Q02','Q08','Q11','Q12','Q13','Q14','Q15','Q16','Q20','Q22'],additionalTopics:[topic('W03','S02',[f('reason','Reason for contact',['S02']),f('update','Concrete update/concern',['W03.followup.1']),f('timing','Approximate timing',['B01']),f('effect','Effect or difficulty',['B01']),f('help','Requested help',['W03.followup.1'])])],owners:['medical','nutrition','admin'],completion:'Concern-specific owners record a staff response, request for information or explained next step. No full intake rerun or unowned ticket.',detailStatus:'proposed-detail' },
  'post-visit': {id:'post-visit',workflowId:'W04', patientSummary:'Share questions or difficulties after your visit.',openingPromptId:'S03',missingContextPromptId:'S03a',contextRequirement:'Exact authored plan source/version/author/date and relevant plan text, or explicit missing-plan state. Recollection is not an authored plan.',reusableTopicIds:['Q02','Q08','Q20','Q22'],additionalTopics:[topic('W04','S03',[f('planContext','Authored plan identity/version or explicit missing plan',['S03','S03a']),f('question','Question/experience tied to plan element, or concern with no plan',['W04.followup.1','W04.followup.2']),f('difficulty','Difficulty/change or none',['S03','S03a'],true),f('help','Requested support',['Q22.followup.1'])])],owners:['medical','nutrition'],missingContextOwner:'medical',completion:'Relevant plan owner records disposition/next step. Missing plan creates medical clarification/record retrieval plus relevant nutrition support; no invented plan or treatment instruction.',detailStatus:'proposed-detail'},
  billing:{id:'billing',workflowId:'W05', patientSummary:'Ask staff for help with a bill, coverage, or payment question.',openingPromptId:'S04',contextRequirement:'Bill/service reference if known; unavailable reference stays explicit. Never collect payment-card/bank credentials.',reusableTopicIds:['Q20'],additionalTopics:[topic('W05','S04',[choice('issueType','Type of billing question',['S04'],['bill-question','coverage-question','payment-question','other-request']),f('serviceDate','Service date (YYYY-MM-DD), if known',['S04']),choice('requestedResolution','Help requested from billing staff',['S04'],['explanation','review-possible-error','payment-options','contact-me']),f('reference','Bill/service reference or explicitly unavailable',['S04']),f('understanding','What seems wrong or unclear',['W05.followup.1']),f('help','Requested resolution',['S04'])])],owners:['admin'],completion:'Admin records answer, clarification, decline or supported actual outcome. Receipt alone is not refund, coverage verification, payment or changed balance. Medical concern creates separate medical work.',detailStatus:'proposed-detail'},
  scheduling:{id:'scheduling',workflowId:'W06', patientSummary:'Ask staff to arrange, change, or cancel a visit.',openingPromptId:'S05',contextRequirement:'Intended appointment or explicit uncertainty; no guessed booking.',reusableTopicIds:['Q20','Q21'],additionalTopics:[topic('W06','S05',[{id:'intent',label:'Request/change/cancel intent',kind:'choice',choices:['request','change','cancel'],promptIds:['S05']},choice('visitCategory','Visit category',['S05'],['first-visit','follow-up','not-sure']),choice('preferredDay','Preferred day',['W06.followup.1'],['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','Any day','Not sure']),choice('preferredWindow','Preferred time of day',['W06.followup.1'],['Morning','Afternoon','Evening','Flexible','Not sure']),f('requestedDate','Requested date (YYYY-MM-DD), if known',['W06.followup.1']),f('visit','Intended visit or explicit uncertainty',['S05']),f('timing','Acceptable dates/times',['W06.followup.1']),choice('timezone','Time zone',['W06.followup.1'],['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Anchorage','Pacific/Honolulu','Other','Not sure']),f('constraints','Timing/accessibility constraints or none',['S05'],true),f('help','Requested next step',['S05'])])],owners:['admin'],missingContextOwner:'admin',completion:'Admin records disposition. Booking/change/cancellation needs separately recorded actual outcome or labeled synthetic fixture. Unavailable time gets alternative or information request.',detailStatus:'proposed-detail'},
  refill:{id:'refill',workflowId:'W07', patientSummary:'Ask your medical care team to review a prescription refill request.',openingPromptId:'S06',contextRequirement:'Medicine/supply/pharmacy as known; unknown context is preserved, no prescription promise.',reusableTopicIds:['Q08','Q09','Q18'],additionalTopics:[topic('W07','S06',[f('medicine','Medicine identity',['S06','B02']),f('directions','Label directions as known',['B02']),f('actualUse','Actual use, distinct from label',['Q08.followup.1']),f('remaining','Supply remaining',['S06']),f('pharmacy','Intended pharmacy or unknown',['S06']),f('symptomsChanges','Symptoms/use changes or explicit none',['S07'],true),f('help','Requested help',['W07.followup.1'])])],owners:['medical'],completion:'Medical owns renewal, symptoms and uncertainty; admin logistics and nutrition support are separate. Human records renewal-request disposition/communication. Admin closure cannot close unresolved medical work.',detailStatus:'proposed-detail'},
};

/** Context is supplied by a verified server record, not inferred from patient prose. */
export function scenarioOpeningPrompt(id: ScenarioId, hasVerifiedContext: boolean): string {
  const scenario = scenarios[id];
  return !hasVerifiedContext && scenario.missingContextPromptId ? scenario.missingContextPromptId : scenario.openingPromptId;
}

/** Short workflows add reused topics only after an explicit relevance decision; no full intake rerun. */
export function scenarioTopics(register: {readonly topics: readonly TopicDefinition[]}, id: ScenarioId, context: {
  readonly relevantTopicIds?: readonly TopicId[];
  readonly responses?: Readonly<Record<string,TopicResponse | undefined>>;
  readonly evidence?: EvidenceContext;
} = {}): readonly TopicDefinition[] {
  const scenario = scenarios[id];
  const selected = id === 'first-intake' ? scenario.reusableTopicIds : context.relevantTopicIds ?? [];
  if (selected.some(topicId=>!scenario.reusableTopicIds.includes(topicId))) throw new Error('topic-not-in-scenario');
  const topics = [...scenario.additionalTopics,...register.topics.filter(topic=>selected.includes(topic.id as TopicId))];
  const answers = context.responses?.Q06?.answers;
  if (answers && context.evidence && topics.some(topic=>topic.id === 'Q06')) {
    if (diabetesBranchApplicability(answers,context.evidence) === 'applicable') topics.push(conditionBranches.diabetes.topic);
    const positive = (id:string) => { const answer=answers[id]; return answer?.state === 'known' && answer.value === true && hasValidEvidence(answer,context.evidence!); };
    if (positive('conditions.sleepApnea')) topics.push(conditionBranches.sleepApnea.topic);
    if (positive('conditions.digestive')) topics.push(conditionBranches.digestive.topic);
  }
  return topics;
}
