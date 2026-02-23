import { describe, expect, it } from "vitest";
import {
  buildConfusionProbe,
  buildExpectationProbe,
  buildPositiveProbe,
  hasConfusionFeedback,
  hasNoMoreToAdd,
  hasPositiveFeedback,
} from "@/lib/decide/transcriptHeuristics";

describe("transcriptHeuristics", () => {
  it("detects positive feedback phrases", () => {
    expect(hasPositiveFeedback("I like this flow")).toBe(true);
  });

  it("detects confusion phrases", () => {
    expect(hasConfusionFeedback("This is confusing")).toBe(true);
  });

  it("detects no-more-to-add responses", () => {
    expect(hasNoMoreToAdd("No, that's all for now")).toBe(true);
  });

  it("builds varied expectation probes and avoids repeating the same recent phrasing", () => {
    const priorPrompt = "What did you expect would happen and why?";
    const next = buildExpectationProbe(priorPrompt);
    expect(next).not.toBe(priorPrompt);
  });

  it("uses a next-step confusion probe when participant is unsure what to do next", () => {
    const prompt = buildConfusionProbe("I'm not sure what to do next.");
    expect(prompt.toLowerCase()).toContain("next step");
  });

  it("builds varied affinity probes for liked/interesting signals", () => {
    const first = buildPositiveProbe("");
    const second = buildPositiveProbe(first);
    expect(second).not.toBe(first);
  });
});
