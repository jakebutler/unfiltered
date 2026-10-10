import { describe, expect, it } from "vitest";
import {
  currentSources,
  errorText,
  invitationUrl,
  readCapability,
  readPending,
  sourceHistory,
  type Source,
} from "../src/state";

const token = "a".repeat(64);
describe("capability URL boundary", () => {
  it("accepts only the dedicated fragment and resumes an existing tab without it", () => {
    expect(readCapability(`#token=${token}`, null)).toBe(token);
    expect(readCapability("", token)).toBe(token);
    expect(readCapability("#main", token)).toBe(token);
    expect(invitationUrl("https://research.example", token)).toBe(
      `https://research.example/participate#token=${token}`,
    );
    expect(
      new URL(invitationUrl("https://research.example", token)).search,
    ).toBe("");
  });
  it("does not fall back to another participant when a malformed invitation is opened", () => {
    for (const fragment of [
      "#token=bad",
      `#token=${token}&token=${token}`,
      `#token=${token}&client=x`,
      "#unrelated",
    ])
      expect(readCapability(fragment, token)).toBeNull();
    expect(readCapability("", "bad")).toBeNull();
  });
});
describe("explicit source recovery", () => {
  const operation = {
    kind: "answer",
    args: {
      requestId: "34d7381e-13fa-4f8d-ae3f-87926800469f",
      expectedRevision: 2,
      questionId: "question-2",
      text: "  Keep my exact words.\nEven spacing.  ",
      channel: "text",
    },
  };
  it("keeps the original request, text and revision across a reload", () => {
    expect(
      readPending("pending", { getItem: () => JSON.stringify(operation) }),
    ).toEqual(operation);
  });
  it("cannot restore a token, session selector or untrusted channel from a local draft", () => {
    expect(
      readPending("pending", {
        getItem: () =>
          JSON.stringify({
            ...operation,
            args: { ...operation.args, token: "secret", sessionId: "other" },
          }),
      }),
    ).toEqual(operation);
    expect(
      readPending("pending", {
        getItem: () =>
          JSON.stringify({
            ...operation,
            args: { ...operation.args, channel: "script" },
          }),
      }),
    ).toBeNull();
  });
  it("discards malformed, oversized and unavailable local drafts", () => {
    for (const value of [
      "{",
      JSON.stringify({ kind: "answer" }),
      JSON.stringify({
        ...operation,
        args: { ...operation.args, text: "x".repeat(8001) },
      }),
      JSON.stringify({
        ...operation,
        args: { ...operation.args, expectedRevision: -1 },
      }),
    ])
      expect(readPending("pending", { getItem: () => value })).toBeNull();
    expect(
      readPending("pending", {
        getItem: () => {
          throw new Error("Storage denied");
        },
      }),
    ).toBeNull();
  });
  it("preserves the precise correction target rather than rewriting an earlier source", () => {
    const correction = {
      kind: "correction",
      args: {
        requestId: operation.args.requestId,
        expectedRevision: 4,
        sourceId: "session:1",
        text: "The corrected wording",
      },
    };
    expect(
      readPending("pending", { getItem: () => JSON.stringify(correction) }),
    ).toEqual(correction);
  });
});
const source = (
  id: string,
  supersedes: string | null,
  sequence: number,
): Source => ({
  _id: id as Source["_id"],
  _creationTime: 1,
  sessionId: "s" as Source["sessionId"],
  clientId: "c" as Source["clientId"],
  projectId: "p" as Source["projectId"],
  sourceId: id,
  supersedes,
  sequence,
  requestId: `request-${id}`,
  questionId: "question",
  author: "participant",
  channel: "text",
  text: `Exact wording ${id}`,
  recordedAt: 1,
});
describe("inspectable correction lineage", () => {
  it("keeps originals while selecting the latest participant answer", () => {
    const original = source("s:1", null, 1),
      correction = source("s:3", "s:1", 3),
      final = source("s:4", "s:3", 4);
    const list = [original, correction, final];
    expect(currentSources(list)).toEqual([final]);
    expect(sourceHistory(final, list)).toEqual([correction, original]);
    expect(original.text).toBe("Exact wording s:1");
  });
  it("does not invent history across unloaded pages or loop on malformed chains", () => {
    const latest = source("s:4", "s:3", 4);
    expect(sourceHistory(latest, [latest])).toEqual([]);
    const one = source("s:1", "s:2", 1),
      two = source("s:2", "s:1", 2);
    expect(sourceHistory(one, [one, two]).length).toBeLessThanOrEqual(2);
  });
});
describe("public errors", () => {
  it("never exposes transport URLs, capability arguments or stack traces", () => {
    expect(errorText(new Error(`token=${token}`))).not.toContain(token);
    expect(errorText({ data: "Revision changed; refresh the session" })).toBe(
      "Revision changed; refresh the session",
    );
  });
});
