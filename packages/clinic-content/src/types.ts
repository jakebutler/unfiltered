import type { topicText } from './content.js';

export type TopicId = typeof topicText[number]['id'];
export type MentalHealthChoice = 'phq4' | 'unscored' | 'pending';
export type { ScenarioId } from './workflows.js';
export type StopReason = 'target-met' | 'does-not-know' | 'not-applicable' | 'patient-declines' | 'patient-moves-on' | 'resistance-after-purpose' | 'safety-interruption';
export type AnswerState = 'known' | 'negative' | 'unknown' | 'declined' | 'uncertain' | 'skipped' | 'not-asked' | 'not-applicable' | 'conflicting';
export type Scalar = string | number | boolean | { readonly feet: number; readonly inches: number };
type Evidence = { readonly sourceIds: readonly string[] };
export type SlotAnswer =
  | (Evidence & { readonly state: 'known'; readonly value: Scalar; readonly items?: never; readonly reusedFrom?: { readonly topicId: 'Q06' | 'Q07'; readonly path: string } })
  | (Evidence & { readonly state: 'known'; readonly items: readonly { readonly id: string; readonly answers: SlotAnswers }[]; readonly complete: boolean; readonly value?: never })
  | (Evidence & { readonly state: Exclude<AnswerState, 'known' | 'not-asked'>; readonly note?: string })
  | { readonly state: 'not-asked'; readonly sourceIds?: readonly [] };
export type SlotAnswers = Readonly<Record<string, SlotAnswer | undefined>>;
export interface SlotDefinition {
  readonly id: string;
  readonly label: string;
  readonly optional?: boolean;
  readonly kind: 'text' | 'positive-number' | 'height-value' | 'choice' | 'presence' | 'collection' | 'configuration';
  readonly promptIds: readonly string[];
  readonly choices?: readonly (string | number | boolean)[];
  readonly acceptsNegative?: boolean;
  /** A component absence cannot establish whole composite absence through extraction. Guided explicit none remains allowed. */
  readonly extractionNegativeScope?: 'composite';
  readonly acceptsNotApplicable?: boolean;
  readonly acceptsUncertain?: boolean;
  readonly fields?: readonly SlotDefinition[];
  readonly when?: { readonly slotId: string; readonly condition: 'positive' | 'estimate-needed' | 'uncertain'; readonly alsoWhenTrue?: string; readonly orSlotIds?: readonly string[] };
}
export interface TopicDefinition {
  readonly id: string;
  readonly presentation: 'R' | 'R-value' | 'O' | 'C';
  readonly openingPromptId: string;
  readonly slots: readonly SlotDefinition[];
  readonly minimumDetailText: string;
  readonly stopWhen: readonly StopReason[];
  readonly visibility: 'assigned-clinical-full';
}
export interface TopicResponse {
  readonly presented: boolean;
  readonly answers: SlotAnswers;
  /** Set by an explicit choice or trusted review, never inferred from voice/face affect. */
  readonly stopped?: Exclude<StopReason, 'target-met' | 'does-not-know'>;
  /** Used for a conditional topic; unknown never suppresses it as inapplicable. */
  readonly applicability?: 'applicable' | 'not-applicable' | 'unknown';
  readonly applicabilitySourceIds?: readonly string[];
}
export interface EvidenceContext {
  /** Patient-scoped, validated source IDs from the server; not arbitrary client assertions. */
  readonly validSourceIds: ReadonlySet<string>;
  /** Trusted final-review authority for this exact fact, never source-wide trust. */
  readonly reviewedFact?: (topicId: string, path: string, answer: SlotAnswer) => boolean;
  readonly reviewedSourceAccountedFor?: (sourceId: string) => boolean;
  readonly topicId?: string;
}
export interface SlotReadiness {
  readonly id: string;
  readonly answerState: AnswerState;
  readonly state: 'sufficient' | 'unresolved' | 'not-applicable';
  readonly reason?: 'missing' | 'unanswered' | 'invalid-value' | 'invalid-evidence' | 'negative-not-allowed' | 'not-applicable-not-allowed' | 'condition-unresolved' | 'collection-open';
  readonly sourceIds: readonly string[];
  readonly promptIds: readonly string[];
}
export interface TopicReadiness {
  readonly topicId: string;
  readonly presentedOrAccountedFor: boolean;
  readonly sufficient: boolean;
  readonly collection: 'continue' | 'complete' | 'stopped' | 'awaiting-information' | 'not-applicable';
  readonly slots: readonly SlotReadiness[];
  readonly unresolvedSlotIds: readonly string[];
  readonly nextPromptIds: readonly string[];
  readonly partialHandoffAllowed: true;
}
export class ContentConfigurationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ContentConfigurationError'; }
}
