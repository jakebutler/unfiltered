import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Brand, SourceList } from "../src/components";
import type { Source } from "../src/state";

const original: Source = {
  _id: "row1" as Source["_id"],
  _creationTime: 1,
  sessionId: "session" as Source["sessionId"],
  clientId: "client" as Source["clientId"],
  projectId: "project" as Source["projectId"],
  sourceId: "session:1",
  sequence: 1,
  requestId: "request-1",
  questionId: "question-1",
  author: "participant",
  channel: "text",
  text: "<img src=x onerror=alert(1)>\nExact participant wording",
  recordedAt: 1,
  supersedes: null,
};
describe("rendered source review", () => {
  it("renders the actual brand without a JSX runtime dependency error", () => {
    expect(renderToStaticMarkup(createElement(Brand))).toContain("Corvo Labs");
  });
  it("escapes untrusted participant text and keeps earlier wording readable", () => {
    const correction = {
      ...original,
      _id: "row2" as Source["_id"],
      sourceId: "session:2",
      sequence: 2,
      text: "Corrected exact wording",
      supersedes: original.sourceId,
    };
    const html = renderToStaticMarkup(
      createElement(SourceList, {
        sources: [original, correction],
        canCorrect: true,
      }),
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("Earlier version");
    expect(html).toContain("Corrected exact wording");
    expect(html.match(/Correct answer/g)).toHaveLength(1);
  });
  it("never offers correction for closed review or interviewer sources", () => {
    expect(
      renderToStaticMarkup(createElement(SourceList, { sources: [original] })),
    ).not.toContain("Correct answer");
    expect(
      renderToStaticMarkup(
        createElement(SourceList, {
          sources: [{ ...original, author: "interviewer", channel: "script" }],
          canCorrect: true,
        }),
      ),
    ).not.toContain("Correct answer");
  });
});

it('automatic spoken answer lineage is never labeled a correction or falsely reviewed', () => {
  const raw = { ...original, channel: 'unreviewed-transcript' as const }, spoken = { ...original, sourceId: 'session:2', sequence: 2, channel: 'spoken-answer' as const, supersedes: raw.sourceId };
  const unseen = renderToStaticMarkup(createElement(SourceList, { sources: [raw, spoken] }));
  expect(unseen).toContain('Spoken answer · wording unreviewed'); expect(unseen).not.toContain('Correction');
  const reviewed = renderToStaticMarkup(createElement(SourceList, { sources: [raw, spoken], reviewedSpokenSourceIds: [spoken.sourceId] }));
  expect(reviewed).toContain('Spoken answer · wording reviewed'); expect(reviewed).not.toContain('Correction');
});
