import { hasValidEvidence } from './readiness.js';
import type { EvidenceContext, SlotAnswers } from './types.js';

/** Explicitly invoked arithmetic after the targeted user selection; never infer or fill item responses. */
export function scorePhq4(answers: SlotAnswers, context: EvidenceContext & { confirmedItemIds: ReadonlySet<string>; completedAt: string }) {
  const ids = ['MH01','MH02','MH03','MH04'] as const;
  const items = ids.map(id=>answers[id]);
  const valid = ids.every((id,index)=>{
    const answer = items[index];
    return context.confirmedItemIds.has(id) && answer?.state === 'known' && !answer.items && typeof answer.value === 'number' && Number.isInteger(answer.value) && answer.value >= 0 && answer.value <= 3 && hasValidEvidence(answer,context);
  });
  if (!valid || !context.completedAt.trim() || !Number.isFinite(Date.parse(context.completedAt))) return {status:'incomplete' as const,message:'Screen incomplete — no score calculated',scores:null,clinicianReviewRequired:true as const,diagnosis:null,clinicalClearance:false as const};
  const values = items.map(item=>item?.state === 'known' ? item.value as number : NaN);
  const gad2 = values[0]+values[1]; const phq2 = values[2]+values[3];
  return {
    status:'complete' as const, scores:{gad2,phq2,phq4:gad2+phq2}, furtherAssessmentRequested:gad2 >= 3 || phq2 >= 3,
    clinicianReviewRequired:true as const, diagnosis:null, clinicalClearance:false as const,
    timeframe:'Over the last 2 weeks', contentVersion:'CC-0.2.PHQ-4', completedAt:context.completedAt,
    itemResponses:ids.map((id,index)=>({id,value:values[index],sourceIds:items[index]!.sourceIds!})),
  };
}
