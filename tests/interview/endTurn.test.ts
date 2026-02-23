import { describe, expect, it } from "vitest";
import {
  getEndTurnLabel,
  resolveEndTurn,
} from "@/lib/interview/endTurn";

describe("interview end turn flow", () => {
  it("labels CTA as Next task before final task", () => {
    expect(getEndTurnLabel({ taskIndex: 0, totalTasks: 2 })).toBe("Next task");
  });

  it("labels CTA as Finish on final task", () => {
    expect(getEndTurnLabel({ taskIndex: 1, totalTasks: 2 })).toBe("Finish");
  });

  it("advances task when not on the final task", () => {
    expect(resolveEndTurn({ currentTaskIndex: 0, totalTasks: 3 })).toEqual({
      shouldCompleteSession: false,
      nextTaskIndex: 1,
      isFinalTask: false,
    });
  });

  it("completes session on final task", () => {
    expect(resolveEndTurn({ currentTaskIndex: 1, totalTasks: 2 })).toEqual({
      shouldCompleteSession: true,
      nextTaskIndex: 1,
      isFinalTask: true,
    });
  });

  it("completes session when index has already reached/passed final task", () => {
    expect(resolveEndTurn({ currentTaskIndex: 3, totalTasks: 2 })).toEqual({
      shouldCompleteSession: true,
      nextTaskIndex: 3,
      isFinalTask: true,
    });
  });
});
