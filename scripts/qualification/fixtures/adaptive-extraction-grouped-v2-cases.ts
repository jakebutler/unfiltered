import { createHash } from "node:crypto";
import {
  domainCaseLabels,
  domainLabelInventory,
  domainRepresentativeDraft,
} from "./adaptive-domain-development.js";
import type { FullReplyManifest } from "../../../packages/clinic-api/src/adaptive-reply-full.js";
import type { DomainManifest } from "../../../packages/clinic-api/src/adaptive-reply-domain.js";
export {
  groupedCaseContext,
  groupedDevelopmentContext,
  groupedDisplayContextRevision,
} from "./adaptive-extraction-grouped-cases.js";
/** Explicit successor expectations; historical fixture/labels and patient source stay immutable. */
const p1Corrections = [
  {
    field: "changes",
    value: "Since the October 8, 2026 update, nausea stopped",
    quote: "Since my October 8, 2026 update, the nausea stopped.",
    reason:
      "Retain the exact relevant update date in the structured value, not only evidence.",
  },
  {
    field: "appointmentContext",
    value:
      "Patient reports October 20, 2026 at 9 am Pacific; staff verification absent.",
    quote: "My appointment is October 20, 2026 at 9 am Pacific.",
    reason:
      "Retain the patient-reported date/time/timezone; absent trusted verification is separate from the patient appointment claim.",
  },
] as const;
export const groupedSemanticRevision = "source-meaning-grouped-date-v2";
export function groupedCaseLabels(id: string) {
  const historical = domainCaseLabels(id),
    corrected = structuredClone(historical);
  if (id === "P1")
    for (const correction of p1Corrections) {
      const expected = corrected.expected.find(
        (e) => e.topic === "W02" && e.path === correction.field,
      );
      if (!expected || expected.quote !== correction.quote)
        throw new Error("successor-label-source-mismatch");
      expected.meaning = correction.value;
    }
  return {
    ...corrected,
    revision: groupedSemanticRevision,
    historicalLabelsSha256: createHash("sha256")
      .update(JSON.stringify(historical))
      .digest("hex"),
    semanticCorrections: id === "P1" ? p1Corrections : [],
  };
}
export function groupedLabelInventory() {
  return domainLabelInventory().map((label) => groupedCaseLabels(label.id));
}
/** Authored expectation only. These case values never enter provider instructions/context. */
export function groupedRepresentativeDraft(
  id: string,
  full: FullReplyManifest,
  manifest: DomainManifest,
) {
  const draft = domainRepresentativeDraft(id, full, manifest);
  if (id === "P1")
    for (const correction of p1Corrections) {
      const report = draft.sections
        .find((s) => s.section === "beforeVisit")
        ?.fields.find((f) => f.answer.field === correction.field);
      if (
        !report ||
        report.answer.state !== "known" ||
        report.predicate.quote !== correction.quote
      )
        throw new Error("successor-authored-source-mismatch");
      report.answer.value = correction.value;
    }
  return draft;
}
