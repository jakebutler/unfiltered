import { describe, it, expect } from "vitest";
import {
  ALL_SCENARIOS,
  PRIMARY_SCENARIOS,
  getScenarioByName,
  getScenarioNames,
  getPrimaryScenarioNames,
} from "@/lib/benchmark/scenarios";

describe("scenario registry", () => {
  it("has at least 8 primary scenarios", () => {
    expect(PRIMARY_SCENARIOS.length).toBeGreaterThanOrEqual(8);
  });

  it("has more total scenarios than primary", () => {
    expect(ALL_SCENARIOS.length).toBeGreaterThan(PRIMARY_SCENARIOS.length);
  });

  it("all scenarios have names and descriptions", () => {
    for (const scenario of ALL_SCENARIOS) {
      expect(scenario.name).toBeTruthy();
      expect(scenario.description).toBeTruthy();
      expect(scenario.turns.length).toBeGreaterThan(0);
    }
  });

  it("all scenarios have valid turn roles", () => {
    for (const scenario of ALL_SCENARIOS) {
      for (const turn of scenario.turns) {
        expect(["user", "interviewer"]).toContain(turn.role);
      }
    }
  });

  it("getScenarioByName returns correct scenario", () => {
    const scenario = getScenarioByName("session_intro");
    expect(scenario).toBeDefined();
    expect(scenario!.name).toBe("session_intro");
  });

  it("getScenarioByName returns undefined for unknown", () => {
    expect(getScenarioByName("nonexistent")).toBeUndefined();
  });

  it("getScenarioNames returns all names", () => {
    const names = getScenarioNames();
    expect(names.length).toBe(ALL_SCENARIOS.length);
    expect(names).toContain("session_intro");
    expect(names).toContain("adverse_noise");
  });

  it("getPrimaryScenarioNames returns subset", () => {
    const primary = getPrimaryScenarioNames();
    const all = getScenarioNames();
    expect(primary.length).toBeLessThan(all.length);
    for (const name of primary) {
      expect(all).toContain(name);
    }
  });
});

describe("scenario content", () => {
  it("session_intro starts with interviewer", () => {
    const scenario = getScenarioByName("session_intro")!;
    expect(scenario.turns[0].role).toBe("interviewer");
    expect(scenario.turns[0].text).toContain("Thanks for joining");
  });

  it("clarifying_questions has expected behaviors", () => {
    const scenario = getScenarioByName("clarifying_questions")!;
    const behaviorsUsed = scenario.turns
      .map((t) => t.expectedBehavior)
      .filter(Boolean);
    expect(behaviorsUsed.length).toBeGreaterThan(0);
    expect(behaviorsUsed).toContain("clarify_without_leading");
  });

  it("silence_handling has silence duration", () => {
    const scenario = getScenarioByName("silence_handling")!;
    const silenceTurns = scenario.turns.filter((t) => t.silenceDurationSeconds);
    expect(silenceTurns.length).toBeGreaterThan(0);
    expect(silenceTurns[0].silenceDurationSeconds).toBeGreaterThanOrEqual(5);
  });

  it("adverse_noise has noise level metadata", () => {
    const scenario = getScenarioByName("adverse_noise")!;
    const noisyTurns = scenario.turns.filter((t) => t.noiseLevel);
    expect(noisyTurns.length).toBeGreaterThan(0);
    expect(noisyTurns[0].snrDb).toBeDefined();
  });
});
