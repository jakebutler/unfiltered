import { describe, expect, it } from "vitest";

import { GuideSchema } from "./types";

describe("GuideSchema", () => {
  it("parses a minimal guide", () => {
    const parsed = GuideSchema.parse({
      studyId: "stu_123",
    });
    expect(parsed.studyId).toBe("stu_123");
    expect(parsed.goals).toEqual([]);
    expect(parsed.audience).toBe("");
    expect(parsed.tasks).toEqual([]);
  });

  it("preserves task probes", () => {
    const parsed = GuideSchema.parse({
      studyId: "stu_456",
      tasks: [
        {
          id: "t1",
          goal: "Sign up successfully",
          instruction: "Create an account.",
          probes: ["Where did you expect that button?"],
        },
      ],
    });
    expect(parsed.tasks[0].probes).toEqual([
      "Where did you expect that button?",
    ]);
  });

  it("rejects malformed shape", () => {
    expect(() => GuideSchema.parse({})).toThrow();
  });
});
