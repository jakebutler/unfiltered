import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeSegmentsForDisplay } from "../../components/interview/TranscriptDisplay";

type Segment = {
  _id: string;
  _creationTime?: number;
  taskId?: string;
  speakerId: "participant" | "interviewer";
  text: string;
  words: { text: string; startTime: number; duration: number }[];
  startTime: number;
};

describe("Transcript display ordering", () => {
  it("keeps transcript append order when start times reset on later tasks", () => {
    const segments: Segment[] = [
      {
        _id: "task-1-segment",
        _creationTime: 1_000,
        taskId: "task-1",
        speakerId: "participant",
        text: "First task response",
        words: [{ text: "First", startTime: 120, duration: 0.2 }],
        startTime: 120,
      },
      {
        _id: "task-2-segment",
        _creationTime: 2_000,
        taskId: "task-2",
        speakerId: "participant",
        text: "Second task response",
        words: [{ text: "Second", startTime: 2, duration: 0.2 }],
        startTime: 2,
      },
    ];

    const lines = mergeSegmentsForDisplay(segments);
    expect(lines.map((line) => line.text)).toEqual([
      "First task response",
      "Second task response",
    ]);
  });

  it("does not merge participant text across task boundaries", () => {
    const segments: Segment[] = [
      {
        _id: "task-1-segment",
        _creationTime: 1_000,
        taskId: "task-1",
        speakerId: "participant",
        text: "still trying this flow",
        words: [{ text: "still", startTime: 50, duration: 0.2 }],
        startTime: 50,
      },
      {
        _id: "task-2-segment",
        _creationTime: 2_000,
        taskId: "task-2",
        speakerId: "participant",
        text: "again",
        words: [{ text: "again", startTime: 1, duration: 0.2 }],
        startTime: 1,
      },
    ];

    const lines = mergeSegmentsForDisplay(segments);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("still trying this flow");
    expect(lines[1].text).toBe("again");
  });

  it("marks the first line of each new task for divider rendering", () => {
    const segments: Segment[] = [
      {
        _id: "task-1-a",
        _creationTime: 1_000,
        taskId: "task-1",
        speakerId: "participant",
        text: "First task content",
        words: [{ text: "First", startTime: 10, duration: 0.2 }],
        startTime: 10,
      },
      {
        _id: "task-2-a",
        _creationTime: 2_000,
        taskId: "task-2",
        speakerId: "participant",
        text: "Second task content",
        words: [{ text: "Second", startTime: 2, duration: 0.2 }],
        startTime: 2,
      },
      {
        _id: "task-3-a",
        _creationTime: 3_000,
        taskId: "task-3",
        speakerId: "participant",
        text: "Third task content",
        words: [{ text: "Third", startTime: 1, duration: 0.2 }],
        startTime: 1,
      },
    ];

    const lines = mergeSegmentsForDisplay(segments);
    expect(lines[0].startsTask).toBe(false);
    expect(lines[1].startsTask).toBe(true);
    expect(lines[1].taskNumber).toBe(2);
    expect(lines[2].startsTask).toBe(true);
    expect(lines[2].taskNumber).toBe(3);
  });
});

describe("Transcript display layout", () => {
  it("uses full available height in the sidebar transcript container", () => {
    const transcriptPath = path.resolve(__dirname, "../../components/interview/TranscriptDisplay.tsx");
    const source = readFileSync(transcriptPath, "utf8");

    expect(source).toContain('className="h-full');
  });
});
