import { describe, expect, it } from "vitest";
import { pickTranscriptSnippetsForMoment } from "@/lib/friction/snippets";

type Segment = {
  _id: string;
  _creationTime: number;
  speakerId: "participant" | "interviewer";
  taskId?: string;
  text: string;
  startTime: number;
  endTime?: number;
  words?: { text: string; startTime: number; duration: number }[];
};

describe("pickTranscriptSnippetsForMoment", () => {
  it("returns a merged phrase when transcript arrives in tiny adjacent fragments", () => {
    const segments: Segment[] = [
      {
        _id: "frag-1",
        _creationTime: 1_000,
        speakerId: "participant",
        taskId: "task-2",
        text: "Okay , this not sure where it got my daily protein",
        startTime: 42,
        endTime: 44,
      },
      {
        _id: "frag-2",
        _creationTime: 2_000,
        speakerId: "participant",
        taskId: "task-2",
        text: "target from because it didn't really ask me that",
        startTime: 44.01,
        endTime: 46,
      },
      {
        _id: "frag-3",
        _creationTime: 3_000,
        speakerId: "participant",
        taskId: "task-2",
        text: "much information other than my medication .",
        startTime: 46.01,
        endTime: 48,
      },
    ];

    const snippets = pickTranscriptSnippetsForMoment(
      { tStart: 40, tEnd: 60, taskId: "task-2" },
      segments,
    );

    expect(snippets[0]).toContain("daily protein target");
    expect(snippets[0]).toContain("other than my medication");
  });

  it("prefers substantive snippets for the same task over short filler utterances", () => {
    const segments: Segment[] = [
      {
        _id: "task-1-yes",
        _creationTime: 1_000,
        speakerId: "participant",
        taskId: "task-1",
        text: "Yeah,",
        startTime: 24,
        endTime: 24.3,
      },
      {
        _id: "task-2-yes",
        _creationTime: 2_000,
        speakerId: "participant",
        taskId: "task-2",
        text: "Yeah,",
        startTime: 25,
        endTime: 25.2,
      },
      {
        _id: "task-2-core",
        _creationTime: 3_000,
        speakerId: "participant",
        taskId: "task-2",
        text: "I can't find where to add the meal plan for the week",
        startTime: 27,
        endTime: 31,
      },
    ];

    const snippets = pickTranscriptSnippetsForMoment(
      { tStart: 20, tEnd: 40, taskId: "task-2" },
      segments,
    );

    expect(snippets[0]).toBe("I can't find where to add the meal plan for the week");
    expect(snippets).not.toContain("Yeah,");
  });

  it("includes segments that overlap the moment even when they start before the moment", () => {
    const segments: Segment[] = [
      {
        _id: "overlap",
        _creationTime: 1_000,
        speakerId: "participant",
        taskId: "task-1",
        text: "I think I clicked the wrong thing",
        startTime: 18,
        endTime: 22,
      },
    ];

    const snippets = pickTranscriptSnippetsForMoment(
      { tStart: 20, tEnd: 30, taskId: "task-1" },
      segments,
    );

    expect(snippets).toEqual(["I think I clicked the wrong thing"]);
  });

  it("falls back to same-task participant text when timestamp overlap is unavailable", () => {
    const segments: Segment[] = [
      {
        _id: "task-2-main",
        _creationTime: 1_000,
        speakerId: "participant",
        taskId: "task-2",
        text: "I'm unsure what this button does",
        startTime: 2,
        endTime: 3.5,
      },
      {
        _id: "task-2-filler",
        _creationTime: 2_000,
        speakerId: "participant",
        taskId: "task-2",
        text: "Okay",
        startTime: 4,
        endTime: 4.2,
      },
    ];

    const snippets = pickTranscriptSnippetsForMoment(
      { tStart: 120, tEnd: 150, taskId: "task-2" },
      segments,
    );

    expect(snippets[0]).toContain("I'm unsure what this button does");
  });
});
