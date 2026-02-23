import { describe, expect, it } from "vitest";
import { generateVariationMatrix } from "@/lib/experiments/variationGenerator";

describe("generateVariationMatrix", () => {
  it("creates deterministic, balanced variations with assigned engine equal to target", () => {
    const matrix = generateVariationMatrix({
      studyIds: ["studyA", "studyB"],
      decisionEngineIds: ["deterministic-a", "llm-b"],
      repeatsPerCell: 3,
    });

    expect(matrix).toHaveLength(12);
    expect(matrix[0]).toMatchObject({
      index: 1,
      studyId: "studyA",
      decisionEngineIdTarget: "deterministic-a",
      decisionEngineIdAssigned: "deterministic-a",
      repeatIndex: 1,
    });
    expect(matrix[11]).toMatchObject({
      index: 12,
      studyId: "studyB",
      decisionEngineIdTarget: "llm-b",
      decisionEngineIdAssigned: "llm-b",
      repeatIndex: 3,
    });

    const targetCounts = matrix.reduce<Record<string, number>>((acc, row) => {
      acc[row.decisionEngineIdTarget] = (acc[row.decisionEngineIdTarget] ?? 0) + 1;
      return acc;
    }, {});

    expect(targetCounts["deterministic-a"]).toBe(6);
    expect(targetCounts["llm-b"]).toBe(6);
    expect(matrix.every((row) => row.decisionEngineIdAssigned === row.decisionEngineIdTarget)).toBe(true);
  });
});

