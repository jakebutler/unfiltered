import { describe, expect, it } from "vitest";
import { canResumeRun } from "@/lib/experiments/runStatus";

describe("canResumeRun", () => {
  it("allows resuming only paused runs", () => {
    expect(canResumeRun("paused")).toBe(true);
    expect(canResumeRun("running")).toBe(false);
    expect(canResumeRun("complete")).toBe(false);
    expect(canResumeRun("aborted")).toBe(false);
  });
});
