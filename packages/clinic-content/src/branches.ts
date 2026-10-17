import type { EvidenceContext, SlotAnswers, SlotDefinition, TopicDefinition } from './types.js';
import { hasValidEvidence } from './readiness.js';
import type { BranchRule } from './pack-rules.js';

export interface ConditionBranch {
  readonly requirementStatus: 'accepted-user-direction';
  readonly detailStatus: 'proposed-detail';
  readonly sourceIds: readonly string[];
  readonly lead: 'medical';
  readonly trigger: string;
  readonly topic: TopicDefinition;
  readonly rule?: BranchRule;
  readonly optionalFacts?: readonly { readonly id: string; readonly promptId: string; readonly fields: readonly string[]; readonly separateFrom: string }[];
  readonly optionalSlots?: readonly SlotDefinition[];
}

const field = (id: string, label: string, promptIds: string[], acceptsNegative = false): SlotDefinition => ({ id, label, kind: 'text', promptIds, acceptsNegative });
const branch = (id: string, openingPromptId: string, slots: SlotDefinition[], minimumDetailText: string): TopicDefinition => ({ id, openingPromptId, slots, minimumDetailText, presentation: 'C', visibility: 'assigned-clinical-full', stopWhen: ['target-met','does-not-know','not-applicable','patient-declines','patient-moves-on','resistance-after-purpose','safety-interruption'] });

/** Volunteered results remain optional and distinct from a point glucose reading. */
export const optionalA1cSlots: readonly SlotDefinition[] = [
  {id:'a1c.value',label:'Volunteered A1C value',kind:'positive-number',promptIds:['DM03'],optional:true},
  {...field('a1c.unit','Volunteered A1C units',['DM03']),optional:true},
  {...field('a1c.measuredWhen','Volunteered A1C date',['DM03']),optional:true},
];

/** New exact detail/configuration remains proposed. Branch activation requires an explicit patient fact. */
export const conditionBranches = {
  diabetes: {
    rule: { id: 'diabetes-explicit-status' },
    requirementStatus: 'accepted-user-direction', detailStatus: 'proposed-detail', sourceIds: ['S13','S14'], lead: 'medical',
    trigger: 'Patient reports known diabetes or prediabetes; uncertain diagnosis first gets clarification without presumption.',
    topic: branch('DM', 'DM01', [field('typeStatus','Reported type/status',['DM01']),field('when','Approximate diagnosis timing',['DM01']),field('treatment','Current treatment or none; reuse Q08',['DM02'],true),field('monitoring','Monitoring method or none',['DM03'],true),{id:'latestGlucose.value',label:'Latest known point glucose result',kind:'positive-number',promptIds:['DM03']},{...field('latestGlucose.unit','Point glucose units as reported',['DM03']),when:{slotId:'latestGlucose.value',condition:'positive'}},{...field('latestGlucose.measuredWhen','Point glucose exact or approximate date',['DM03']),when:{slotId:'latestGlucose.value',condition:'positive'}},{id:'lowEvents',label:'Reported or suspected low blood sugar episodes',kind:'presence',promptIds:['DM04'],acceptsNegative:true},{...field('lowEvents.description','What happened during the reported low episode',['DM04']),when:{slotId:'lowEvents',condition:'positive'}},{...field('lowEvents.mostRecent','When the most recent low episode occurred',['DM04']),when:{slotId:'lowEvents',condition:'positive'}},{...field('lowEvents.help','Whether someone else’s help was needed',['DM04'],true),when:{slotId:'lowEvents',condition:'positive'}},field('owner','Current care owner or none',['DM05'],true),field('concern','Current concern or none',['DM05'],true),...optionalA1cSlots], 'Known type/status; treatment; monitoring method; latest known result/date/units or unknown; reported/suspected low events and help needed; care owner. A1C is an optional separate fact, never substituted for point glucose.'),
    optionalFacts: [{ id: 'a1c', promptId: 'DM03', fields: ['value','unit','measuredWhen'], separateFrom: 'latestGlucose' }],
    optionalSlots: optionalA1cSlots,
  },
  otherCondition: {
    requirementStatus: 'accepted-user-direction', detailStatus: 'proposed-detail', sourceIds: ['S12'], lead: 'medical',
    trigger: 'Any other reported condition or unclear label; apply separately to each patient condition term.',
    topic: branch('COND','COND01',[field('termStatus','Patient term and reported status',['COND01']),field('care','Current treatment/follow-up or none',['COND01'],true),field('difficulty','Current difficulty or none',['COND02'],true),field('owner','Care owner or none',['COND02'],true)],'Patient term/status, current care/treatment, present concern or none and owner; no disease-specific laboratory interrogation.'),
  },
  sleepApnea: {
    rule: { id: 'slot-positive', slot: 'conditions.sleepApnea' },
    requirementStatus: 'accepted-user-direction', detailStatus: 'proposed-detail', sourceIds: ['S12'], lead: 'medical',
    trigger: 'Reported sleep apnea; reuse Q15.',
    topic: branch('SLEEP','SLEEP01',[field('treatment','Treatment or none',['SLEEP01'],true),field('difficulty','Difficulty using treatment or none',['SLEEP01'],true)],'Treatment or none, difficulty or none; snoring does not establish apnea.'),
  },
  digestive: {
    rule: { id: 'slot-positive', slot: 'conditions.digestive' },
    requirementStatus: 'accepted-user-direction', detailStatus: 'proposed-detail', sourceIds: ['S12'], lead: 'medical',
    trigger: 'Reported digestive disease or relevant surgery with ongoing eating effects; reuse Q07/Q11.',
    topic: branch('GI','GI01',[field('effect','Present eating/drinking/digestion effect or none',['GI01'],true)],'Present effect or none; concerning current symptoms invoke the separate E-policy.'),
  },
} as const satisfies Readonly<Record<string, ConditionBranch>>;

/** No parsing, inference from medicine, or assumption that an unchecked condition is absent. */
export function diabetesBranchApplicability(answers: SlotAnswers, evidence: EvidenceContext): 'applicable' | 'not-applicable' | 'unknown' {
  const inputs = ['conditions.diabetes','conditions.prediabetes'].map(id => answers[id]);
  if (inputs.some(answer => answer?.state === 'known' && answer.value === true && hasValidEvidence(answer,evidence))) return 'applicable';
  return inputs.every(answer => answer?.state === 'negative' && hasValidEvidence(answer,evidence)) ? 'not-applicable' : 'unknown';
}
