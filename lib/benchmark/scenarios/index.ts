import type { Scenario } from "./types";
import { sessionIntro, sessionIntroVariant } from "./session-intro";
import { clarifyingQuestions, clarifyingQuestionsExtended } from "./clarifying-qs";
import { silenceHandling, silenceHandlingLong, silenceThinking } from "./silence-handling";
import { positiveFeedback, mixedFeedback } from "./positive-feedback";
import { restating, restatingComplex, restatingCorrection } from "./restating";
import { taskTransition, taskTransitionUnsure } from "./task-transition";
import { sessionWrapup, sessionWrapupAdditional } from "./session-wrapup";
import { adverseNoise, adverseInterruption, adverseHeavyNoise } from "./adverse-conditions";

export type { Scenario, ScenarioTurn, TurnRole, ExpectedBehavior } from "./types";
export { EVALUATION_DIMENSIONS, RATING_LABELS } from "./types";
export type { EvaluationDimensionId, RatingScore } from "./types";

export const ALL_SCENARIOS: Scenario[] = [
  sessionIntro,
  sessionIntroVariant,
  clarifyingQuestions,
  clarifyingQuestionsExtended,
  silenceHandling,
  silenceHandlingLong,
  silenceThinking,
  positiveFeedback,
  mixedFeedback,
  restating,
  restatingComplex,
  restatingCorrection,
  taskTransition,
  taskTransitionUnsure,
  sessionWrapup,
  sessionWrapupAdditional,
  adverseNoise,
  adverseInterruption,
  adverseHeavyNoise,
];

export const PRIMARY_SCENARIOS: Scenario[] = [
  sessionIntro,
  clarifyingQuestions,
  silenceHandling,
  positiveFeedback,
  restating,
  taskTransition,
  sessionWrapup,
  adverseNoise,
];

export function getScenarioByName(name: string): Scenario | undefined {
  return ALL_SCENARIOS.find((s) => s.name === name);
}

export function getScenarioNames(): string[] {
  return ALL_SCENARIOS.map((s) => s.name);
}

export function getPrimaryScenarioNames(): string[] {
  return PRIMARY_SCENARIOS.map((s) => s.name);
}
