import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const interviewPagePath = path.resolve(__dirname, "../../app/interview/[sessionId]/page.tsx");
const source = readFileSync(interviewPagePath, "utf8");

describe("Interview permission gate", () => {
  it("uses the updated permission reminder copy in the intro script", () => {
    expect(source).toContain("If you haven't yet, allow your browser access to your camera and microphone for this session.");
  });

  it("does not gate intro speech on permission counter state", () => {
    expect(source).not.toContain("grantedPermissionCount");
    expect(source).not.toContain("requiredPermissionGrants");
  });
});
