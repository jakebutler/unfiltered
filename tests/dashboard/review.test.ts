import { describe, expect, it } from "vitest";
import {
  findTranscriptFocusIndex,
  mergeSegmentsForReview,
  sortSegmentsForReview,
} from "@/lib/dashboard/review";

type Segment = {
  _id: string;
  _creationTime?: number;
  speakerId: "participant" | "interviewer";
  text: string;
  startTime: number;
  endTime?: number;
  words?: { text: string; startTime: number; duration: number }[];
};

describe("sortSegmentsForReview", () => {
  it("keeps append order when transcript start times reset on later tasks", () => {
    const ordered = sortSegmentsForReview([
      {
        _id: "task-2",
        _creationTime: 2_000,
        speakerId: "participant",
        text: "Task two line",
        startTime: 3,
      },
      {
        _id: "task-1",
        _creationTime: 1_000,
        speakerId: "participant",
        text: "Task one line",
        startTime: 120,
      },
    ] as Segment[]);

    expect(ordered.map((s) => s._id)).toEqual(["task-1", "task-2"]);
  });
});

describe("findTranscriptFocusIndex", () => {
  it("focuses the segment containing the referenced snippet", () => {
    const segments: Segment[] = [
      {
        _id: "a",
        _creationTime: 1_000,
        speakerId: "participant",
        text: "Yeah",
        startTime: 10,
        endTime: 11,
      },
      {
        _id: "b",
        _creationTime: 2_000,
        speakerId: "participant",
        text: "I can't find the add meal button",
        startTime: 20,
        endTime: 24,
      },
    ];

    const idx = findTranscriptFocusIndex(segments, {
      tStart: 18,
      tEnd: 26,
      referencedSnippet: "add meal button",
    });

    expect(idx).toBe(1);
  });

  it("falls back to nearest moment-overlap when no snippet text match exists", () => {
    const segments: Segment[] = [
      {
        _id: "a",
        _creationTime: 1_000,
        speakerId: "participant",
        text: "Earlier line",
        startTime: 1,
        endTime: 4,
      },
      {
        _id: "b",
        _creationTime: 2_000,
        speakerId: "participant",
        text: "Mid line",
        startTime: 18,
        endTime: 21,
      },
      {
        _id: "c",
        _creationTime: 3_000,
        speakerId: "participant",
        text: "Later line",
        startTime: 55,
        endTime: 56,
      },
    ];

    const idx = findTranscriptFocusIndex(segments, {
      tStart: 20,
      tEnd: 30,
      referencedSnippet: "nonexistent phrase",
    });

    expect(idx).toBe(1);
  });
});

describe("mergeSegmentsForReview", () => {
  it("concatenates short adjacent transcript fragments into readable speaker lines", () => {
    const segments: Segment[] = [
      {
        _id: "s1",
        _creationTime: 1_000,
        speakerId: "participant",
        text: "I",
        startTime: 10,
        endTime: 10.2,
      },
      {
        _id: "s2",
        _creationTime: 2_000,
        speakerId: "participant",
        text: "can't",
        startTime: 10.21,
        endTime: 10.4,
      },
      {
        _id: "s3",
        _creationTime: 3_000,
        speakerId: "participant",
        text: "find",
        startTime: 10.41,
        endTime: 10.6,
      },
      {
        _id: "s4",
        _creationTime: 4_000,
        speakerId: "participant",
        text: "that.",
        startTime: 10.61,
        endTime: 10.9,
      },
      {
        _id: "s5",
        _creationTime: 5_000,
        speakerId: "interviewer",
        text: "What are you looking for?",
        startTime: 11.5,
        endTime: 12.5,
      },
    ];

    const merged = mergeSegmentsForReview(segments);
    expect(merged).toHaveLength(2);
    expect(merged[0].speakerId).toBe("participant");
    expect(merged[0].text).toBe("I can't find that.");
    expect(merged[1].speakerId).toBe("interviewer");
  });
});
