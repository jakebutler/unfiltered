import { diabetesBranchApplicability } from './branches.js';
import { hasValidEvidence } from './readiness.js';
import type { EvidenceContext, SlotAnswers } from './types.js';

/** Closed, code-reviewed applicability rules. Packs contain names, never executable predicates. */
export const branchRuleIds = ['diabetes-explicit-status', 'slot-positive'] as const;
export type BranchRuleId = typeof branchRuleIds[number];
export type BranchRule =
  | { readonly id: 'diabetes-explicit-status'; readonly slot?: never }
  | { readonly id: 'slot-positive'; readonly slot: string };

export const branchRules = {
  'diabetes-explicit-status': (answers: SlotAnswers, evidence: EvidenceContext, _slot?: string): boolean =>
    diabetesBranchApplicability(answers, evidence) === 'applicable',
  'slot-positive': (answers: SlotAnswers, evidence: EvidenceContext, slot?: string): boolean => {
    const answer = slot === undefined ? undefined : answers[slot];
    return answer?.state === 'known' && answer.value === true && hasValidEvidence(answer, evidence);
  },
} as const;
