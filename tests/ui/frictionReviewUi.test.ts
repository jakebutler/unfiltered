import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("Friction review UI", () => {
  it("exposes transcript review and verification controls in MomentCard", () => {
    const cardPath = path.resolve(__dirname, "../../components/dashboard/MomentCard.tsx");
    const source = readFileSync(cardPath, "utf8");

    expect(source).toContain("View transcript");
    expect(source).toContain("Confirm");
    expect(source).toContain("Incorrect");
    expect(source).toContain("Explain what was inaccurate");
  });

  it("renders a transcript review sidebar from the dashboard page", () => {
    const pagePath = path.resolve(__dirname, "../../app/dashboard/[sessionId]/page.tsx");
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain("TranscriptReviewSidebar");
    expect(source).toContain("api.transcripts.listBySession");
  });
});
