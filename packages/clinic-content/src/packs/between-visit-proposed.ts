import { questionnairePackSchema, type QuestionnairePack } from '../pack.js';
import { adultIntakePack } from './adult-intake.js';

/**
 * Standalone W08 authoring candidate for the owner's bundled re-qualification.
 * This module is deliberately absent from the runtime registry and public content index.
 * Derive from a validated copy so neither this candidate nor its consumers mutate adult intake.
 */
const source = questionnairePackSchema.parse(adultIntakePack);

export const proposedBetweenVisitPack: QuestionnairePack = {
  ...source,
  id: 'between-visit-proposed',
  url: 'https://corvo.example/Questionnaire/between-visit-proposed',
  version: 'CC-0.2.W08.proposed',
  title: 'Between-visit check-in (proposed)',
  provenance: {
    version: 'CC-0.2.W08.proposed',
    sourcePath: 'docs/implementation/PLAN-QT-T3-REACH.md#t38-between-visit-symptom-check-in-pack',
    derivedFrom: { id: source.id, url: source.url, version: source.version },
    wordingStatus: 'proposed-detail',
    clinicalProtocolApproval: false,
    runtimeRegistration: 'deferred-until-owner-requalification',
  },
  prompts: [
    ...source.prompts,
    { id: 'S08', text: 'How have things been going since your last visit?', origin: 'between-visit', wordingStatus: 'proposed-detail' },
    { id: 'W08.followup.1', text: 'Has anything changed since your last visit, such as medicines, eating, sleep or how you feel? If nothing has changed, you can say so.', origin: 'between-visit', wordingStatus: 'proposed-detail' },
    { id: 'W08.followup.2', text: "Is there anything you'd like your care team to help with before your next visit?", origin: 'between-visit', wordingStatus: 'proposed-detail' },
  ],
  workflows: [
    ...source.workflows,
    {
      id: 'between-visit', workflowId: 'W08',
      patientSummary: 'Send a short update on how things are going between visits.',
      openingPromptId: 'S08',
      contextRequirement: 'Most recent confirmed submission if available (T3.9); otherwise none required.',
      reusableTopicIds: ['Q08', 'Q11', 'Q15', 'Q16'],
      additionalTopics: [{
        linkId: 'W08', openingPromptId: 'S08', presentation: 'R',
        minimumDetailText: 'How things have been overall since the last visit; Changes since the last visit, or none; Anything the care team should help with before the next visit',
        stopWhen: ['target-met', 'does-not-know', 'patient-declines', 'patient-moves-on', 'resistance-after-purpose', 'safety-interruption'],
        item: [
          { linkId: 'overall', text: 'How things have been overall since the last visit', type: 'text', corvo: { promptIds: ['S08'], acceptsNegative: false } },
          { linkId: 'changes', text: 'Changes since the last visit, or none', type: 'text', corvo: { promptIds: ['W08.followup.1'], acceptsNegative: true } },
          { linkId: 'help', text: 'Anything the care team should help with before the next visit', type: 'text', corvo: { promptIds: ['W08.followup.2'], acceptsNegative: true } },
        ],
        corvo: { wordingStatus: 'proposed-detail' },
      }],
      owners: ['medical', 'nutrition'],
      completion: 'Each relevant owner reviews the update and records a next step. PHQ-4 is scored only when all four items are answered by buttons.',
      detailStatus: 'proposed-detail',
    },
  ],
};
