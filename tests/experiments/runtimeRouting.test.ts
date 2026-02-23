import { describe, expect, it } from "vitest";
import { getDecideModeForEngine } from "@/lib/experiments/decisionEngineRegistry";

describe("runtime routing from assigned engine", () => {
  it("maps deterministic-a to decide mode A", () => {
    expect(getDecideModeForEngine("deterministic-a")).toBe("A");
  });

  it("maps llm-b to decide mode B", () => {
    expect(getDecideModeForEngine("llm-b")).toBe("B");
  });

  it("throws for unknown engine ids", () => {
    expect(() => getDecideModeForEngine("unknown-engine")).toThrow("Unknown decision engine id");
  });
});

