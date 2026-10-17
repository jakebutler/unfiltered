import { fullCaseContext } from "./adaptive-full-cases.js";
/** Successor interview context only. Original source, labels and archived fixture are unchanged. */
export function groupedCaseContext(id: string) {
  const context = fullCaseContext(id);
  // W02 was a synthetic topic ID, never a registered displayed prompt. P1 has
  // no record-verified appointment; S01a is the existing approved missing-context copy.
  if (id === "P1")
    context.displayed = { ...context.displayed!, promptId: "S01a" };
  return context;
}
export const groupedDisplayContextRevision = "grouped-successor-display-v1";

import { fullDevelopmentContext } from "./adaptive-full-development.js";
import { fullReplyActions } from "../../../packages/clinic-api/src/adaptive-reply-full.js";
import type { Draft } from "../../../packages/clinic-api/src/types.js";
/** Catalog size context uses the first existing locally issued question, never an answer-derived hint. */
export function groupedDevelopmentContext(scenario: Draft["scenario"]) {
  const context = fullDevelopmentContext(scenario);
  if (!context.displayed) {
    const question = fullReplyActions(context).find(
      (a) => a.kind === "question",
    );
    if (question)
      context.displayed = {
        topicId: question.topicId,
        promptId: question.promptId,
        targetPaths: question.targetPaths,
        ...(question.wording ? { wording: question.wording } : {}),
      };
  }
  return context;
}
