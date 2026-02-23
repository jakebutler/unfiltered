import { describe, expect, it } from "vitest";
import { extractFirstJsonObject, normalizeConfidence } from "@/convex/lib/classifierOutput";

describe("classifierOutput", () => {
  it("extracts plain JSON", () => {
    const raw = '{"state":"engaged_active","confidence":0.81}';
    expect(extractFirstJsonObject(raw)).toEqual({ state: "engaged_active", confidence: 0.81 });
  });

  it("extracts JSON when wrapped in extra text", () => {
    const raw = 'Here is the result:\n{"state":"disengaged_away","confidence":"high"}\nThanks';
    expect(extractFirstJsonObject(raw)).toEqual({ state: "disengaged_away", confidence: "high" });
  });

  it("returns null when JSON cannot be parsed", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
  });

  it("normalizes string confidence labels", () => {
    expect(normalizeConfidence("high")).toBe(0.85);
    expect(normalizeConfidence("medium")).toBe(0.6);
    expect(normalizeConfidence("low")).toBe(0.35);
  });

  it("normalizes numeric confidence and clamps to [0,1]", () => {
    expect(normalizeConfidence(0.7)).toBe(0.7);
    expect(normalizeConfidence(10)).toBe(1);
    expect(normalizeConfidence(-2)).toBe(0);
  });
});
