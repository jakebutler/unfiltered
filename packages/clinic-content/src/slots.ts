import type { SlotDefinition, TopicId } from './types.js';
import { supplementalPromptText } from './content.js';

const t = (id: string, label: string, promptIds: string[], acceptsNegative = false): SlotDefinition => ({ id, label, kind: 'text', promptIds, acceptsNegative });
const c = (id: string, label: string, promptIds: string[], choices: readonly (string | number | boolean)[]): SlotDefinition => ({ id, label, kind: 'choice', promptIds, choices });
const presence = (id: string, label: string, promptIds: string[]): SlotDefinition => ({ id, label, kind: 'presence', promptIds, acceptsNegative: true });
const when = (slot: SlotDefinition, slotId: string): SlotDefinition => ({ ...slot, when: { slotId, condition: 'positive' } });
const list = (id: string, label: string, promptIds: string[], fields: SlotDefinition[], acceptsNegative = true): SlotDefinition => ({ id, label, kind: 'collection', promptIds, fields, acceptsNegative });

const commonConditions = [
  ['diabetes','Diabetes','Q06a'], ['prediabetes','Prediabetes','Q06a'],
  ['bloodPressure','High blood pressure','Q06b'], ['cholesterol','High cholesterol','Q06b'],
  ['heartDisease','Heart disease','Q06b'], ['stroke','Previous stroke','Q06b'],
  ['sleepApnea','Sleep apnea','Q06c'], ['liver','Fatty liver or another liver condition','Q06c'],
  ['kidney','Kidney disease','Q06c'], ['joint','Arthritis or another joint condition','Q06d'],
  ['thyroidHormone','Thyroid or another hormone condition','Q06d'], ['digestive','Digestive condition','Q06d'],
] as const;

/** Field names operationalize the document's proposed detail targets; they are not new clinical questions. */
export const coreSlots: Record<TopicId, readonly SlotDefinition[]> = {
  Q01: [t('reason', 'Reason for seeking care', ['Q01']), t('priority', 'Personally meaningful outcome or priority', ['Q01.followup.1', 'Q01.followup.2'])],
  Q02: [t('concern', 'Specific current symptom or no concern', ['Q02'], true), when(t('onset', 'Onset and timecourse', ['Q02.followup.2', 'B01']), 'concern'), when(t('impact', 'Current presence and effect', ['Q02.followup.3', 'B01']), 'concern'), when(t('help', 'Help sought', ['Q22.followup.1']), 'concern')],
  Q03: [t('childhood', 'Childhood trajectory', ['Q03', 'Q03a']), t('teenage', 'Teenage trajectory', ['Q03b']), { ...t('afterSchool', 'After high school or equivalent life stage', ['Q03c']), acceptsNotApplicable: true }, t('lastFiveYears', 'Trajectory over last five years', ['Q03d']), t('past18Months', 'Trajectory over past 18 months', ['Q03e']), list('majorChanges', 'Major changes with timing and life context', ['Q03.change-context'], [t('change', 'Change described', ['Q03.change-context']), t('timing', 'Approximate timing', ['Q03.change-context']), t('context', 'Life context or no associated event', ['Q03.change-context'], true)])],
  Q04: [
    { id: 'height.value', label: 'Height value', kind: 'height-value', promptIds: ['Q04'] },
    c('height.unit', 'Height units', ['Q04.followup.2'], ['cm', 'm', 'in', 'ft', 'ft-in']),
    { id: 'lastMeasuredWeight.value', label: 'Latest actual weight reading', kind: 'positive-number', promptIds: ['Q04a'] },
    c('lastMeasuredWeight.unit', 'Measured weight units', ['Q04a', 'Q04.followup.2'], ['kg', 'lb', 'st']),
    t('lastMeasuredWeight.measuredWhen', 'Exact or approximate measurement date', ['Q04a']),
    c('lastMeasuredWeight.datePrecision', 'Whether the measurement date is exact or approximate', ['Q04a'], ['exact', 'approximate']),
    {...c('lastMeasuredWeight.describedAsOld', 'Patient explicitly described the reading as old', [], [true, false]), optional:true},
    { ...c('lastMeasuredWeight.representsCurrent', 'Whether reading represents current weight', ['Q04b'], [true, false]), acceptsUncertain: true },
    { id: 'currentWeightEstimate.value', label: 'Current estimated weight', kind: 'positive-number', promptIds: ['Q04c'], when: { slotId: 'lastMeasuredWeight.representsCurrent', condition: 'estimate-needed', alsoWhenTrue:'lastMeasuredWeight.describedAsOld' } },
    { ...c('currentWeightEstimate.unit', 'Estimated weight units', ['Q04c', 'Q04.followup.2'], ['kg', 'lb', 'st']), when: { slotId: 'lastMeasuredWeight.representsCurrent', condition: 'estimate-needed', alsoWhenTrue:'lastMeasuredWeight.describedAsOld' } },
    { ...t('currentWeightEstimate.statedAt', 'When estimate was stated (source timestamp)', []), when: { slotId: 'lastMeasuredWeight.representsCurrent', condition: 'estimate-needed', alsoWhenTrue:'lastMeasuredWeight.describedAsOld' } },
  ],
  Q05: [list('approaches', 'Prior approaches or explicit none', ['Q05'], [t('approach', 'Name or type', ['Q05']), t('period', 'Approximate period and duration', ['Q05.followup.1']), t('experience', 'What helped or was difficult', ['Q05.followup.2']), t('currentStatus', 'Continuing or reason stopped/changed', ['Q05.followup.2'])])],
  Q06: [
    {...t('uncertainDiagnosis', 'What you recall being told about the uncertain condition', ['Q06.uncertain']), when:{slotId:'conditions.diabetes',condition:'uncertain',orSlotIds:commonConditions.slice(1).map(([id])=>`conditions.${id}`)}},
    ...commonConditions.map(([id,label,prompt]) => presence(`conditions.${id}`, label, [prompt])),
    list('reportedConditions', 'Reported conditions with care context or explicit none', ['Q06'], [t('term', 'Patient condition term and status', ['Q06.followup.1', 'COND01']), t('care', 'Current treatment/follow-up or none', ['COND01'], true), t('concern', 'Current difficulty or none', ['COND02'], true), t('owner', 'Care owner or none', ['Q06.followup.2', 'COND02'], true)]),
  ],
  Q07: [list('events', 'Surgery/procedure/hospital stay or none', ['Q07'], [t('event', 'Procedure or admission reason', ['Q07.followup.1']), t('when', 'Approximate date', ['Q07.followup.1']), t('effects', 'Continuing effects/follow-up or none', ['Q07.followup.2'], true)])],
  Q08: [list('medicines', 'Each medicine/product or explicit none', ['Q08'], [t('name', 'Medicine/product name', ['B02']), t('strength', 'Strength or amount with units', ['B02']), t('labelDirections', 'Label directions as reported', ['B02']), t('actualUse', 'Actual schedule/use, separate from label', ['Q08.followup.1']), t('reason', 'Reason for use if known', ['Q08']), t('concerns', 'Uncertainty/access/use concerns or none', ['Q08.followup.2'], true)])],
  Q09: [list('reactions', 'Allergies/reactions or none known', ['Q09'], [t('substance', 'Substance', ['Q09']), t('reaction', 'Patient reaction description', ['Q09.followup.1']), t('timing', 'Approximate timing and current versus past', ['Q09.followup.2'])])],
  Q10: [list('familyHistory', 'Family history or none known', ['Q10'], [t('condition', 'Known condition', ['Q10.followup.1']), t('relationship', 'Relationship', ['Q10.followup.1'])])],
  Q11: [t('day', 'Identified recall day', ['Q11']), list('occasions', 'Eating/drinking occasions, including omitted meals', ['Q11','Q11a'], [t('time', 'Approximate time', ['Q11a']), t('foods', 'Food contents or explicit no food', ['Q11a'], true), t('drinks', 'Drinks or none', ['Q11c'], true), when(t('drinkAdditions', 'Anything added to the drink or none', ['Q11c'], true), 'drinks'), when(t('foodAmounts', 'Ordinary approximate food portions', ['Q11b']), 'foods'), when(t('drinkAmounts', 'Ordinary approximate drink amounts', ['Q11b']), 'drinks')], false), t('otherIntake', 'Snacks/evening/overnight intake or none', ['Q11d'], true), t('typicality', 'Whether representative and usual differences', ['Q11e'])],
  Q12: [t('concern', 'Eating concern or explicit none', ['Q12'], true), when(t('timing', 'Current versus past', ['Q12.followup.1']), 'concern'), when(t('effect', 'Effect on wellbeing', ['Q16a']), 'concern'), when(t('support', 'Requested support or none', ['Q12.followup.2'], true), 'concern')],
  Q13: [t('barrier', 'Food access barrier or none', ['Q13'], true), when(t('effect', 'Practical effect', ['Q13.followup.1']), 'barrier'), when(t('help', 'Help requested or none', ['Q13.followup.2'], true), 'barrier')],
  Q14: [t('activity', 'Usual movement type, including no routine', ['Q14'], true), t('frequency', 'Approximate frequency/pattern', ['Q14.followup.1'], true), t('limits', 'Functional limits or none', ['Q14.followup.2'], true), t('preference', 'Patient movement/function preference', ['Q14.followup.2'])],
  Q15: [t('schedule', 'Sleep schedule and approximate duration', ['Q15.followup.1']), t('quality', 'Rest/quality and daytime effect', ['Q15.followup.1']), t('condition', 'Known sleep condition or none', ['Q15.followup.2'], true), when(t('treatment', 'Treatment or none', ['Q15.followup.2'], true), 'condition')],
  Q16: [presence('depressionHistory', 'Depression history', ['Q16']), presence('anxietyHistory', 'Anxiety history', ['Q16']), t('currentCare', 'Current mental-health care or none', ['Q16','Q16b'], true), t('stress', 'Current stress or none', ['Q16a'], true), when(t('impact', 'Daily impact', ['Q16a']), 'stress'), t('support', 'Existing/desired support or none', ['Q16b'], true)],
  Q17: [list('substances', 'Substances or none', ['Q17'], [t('substance', 'Substance', ['Q17']), t('frequencyAmount', 'Usual frequency/amount in patient units', ['Q17.followup.1']), t('concern', 'Concern/help requested or none', ['Q17.followup.2'], true)])],
  Q18: [t('context', 'Relevance/status or explicitly not applicable', ['Q18']), t('concern', 'Current/planned context to consider or none', ['Q18.followup.1'], true)],
  Q19: [list('clinicians', 'Current clinicians/roles or none', ['Q19'], [t('owner', 'Clinician or service/role', ['Q19.followup.1'])]), list('records', 'Relevant records/tests or none', ['Q19'], [t('record', 'Record/test description', ['Q19.followup.2']), t('when', 'Approximate date', ['Q19.followup.2']), t('availability', 'Known availability', ['Q19.followup.2'])])],
  Q20: [t('barrier', 'Care access barrier or none', ['Q20'], true), when(t('impact', 'Effect on care', ['Q20.followup.1']), 'barrier'), when(t('help', 'Requested staff help or none', ['Q20.followup.2'], true), 'barrier')],
  Q21: [t('addressPreference', 'Name/address preference', ['Q21']), t('language', 'Language', ['Q21']), t('support', 'Accessibility/communication need or none', ['Q21.followup.1'], true)],
  Q22: [t('request', 'Remaining agenda or no further item', ['Q22'], true), when(t('help', 'Requested action/clarification and intended owner', ['Q22.followup.1']), 'request')],
};

export const mentalHealthSlots = {
  phq4: ['MH01','MH02','MH03','MH04'].map(id => c(id, `${supplementalPromptText.find(prompt=>prompt.id === id)!.text} (over the last 2 weeks)`, [id], [0,1,2,3])),
  unscored: [t('currentMoodAnxiety', 'Current low mood/loss of interest/anxiety/worry, or none; unscored', ['MH.unscored'], true), when(t('currentImpact', 'Current symptom impact', ['MH.unscored']), 'currentMoodAnxiety')],
} as const;
