import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const joinPagePath = path.resolve(__dirname, "../../app/join/[studyId]/page.tsx");
const source = readFileSync(joinPagePath, "utf8");

describe("Join page permissions cards", () => {
  it("uses the updated camera badge copy", () => {
    expect(source).toContain(">Recommended<");
    expect(source).not.toContain("Optional, recommended");
  });

  it("renders permission cards as fully clickable containers", () => {
    const clickableCards = source.match(/cursor-pointer rounded-xl border p-4 transition-colors/g) ?? [];
    expect(clickableCards.length).toBeGreaterThanOrEqual(3);
  });

  it("aligns checkbox inline with icon and label row", () => {
    const alignedRows = source.match(/className=\"flex items-center gap-3\"/g) ?? [];
    expect(alignedRows.length).toBeGreaterThanOrEqual(3);
  });
});
