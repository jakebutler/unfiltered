import { promptText, supplementalPromptText } from './content.js';
import { PHQ4_ITEM_IDS } from './mental-health.js';

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
  phq4: { status:'accepted-targeted-choice', scoring:'explicit-complete-only-helper', stemPromptId:'MH.stem', introPromptId:'COPY-10', itemIds:[...PHQ4_ITEM_IDS], choices:[{value:0,label:'Not at all'},{value:1,label:'Several days'},{value:2,label:'More than half the days'},{value:3,label:'Nearly every day'}], attribution:'Developed by Drs. Robert L. Spitzer, Janet B. W. Williams, Kurt Kroenke and colleagues with an educational grant from Pfizer Inc.', source:'https://www.phqscreeners.com/images/sites/g/files/g10016261/f/201412/instructions.pdf', instruction:'Exact stem/items/choices only, with explicit confirmed responses. No inference from vague language, diagnoses, past answers or missing items. Clinician review is required; a low score is not clearance.' },
  unscored: { status:'proposed-detail', scoring:'disabled', promptId:'MH.unscored', instruction:'Original unvalidated collection wording; never label this PHQ/GAD or calculate an instrument result.' },
} as const;

export interface RuntimePrompt { readonly id: string; readonly text: string; readonly origin: string; readonly wordingStatus: string }
export const promptsById: Readonly<Record<string, RuntimePrompt>> = Object.fromEntries([...promptText,...supplementalPromptText].map(prompt=>[prompt.id,prompt]));

