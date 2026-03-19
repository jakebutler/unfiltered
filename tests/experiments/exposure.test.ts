import { describe, expect, it } from "vitest";
import {
  markExposureFailure,
  markExposureSent,
  shouldSendExposure,
} from "@/lib/experiments/exposure";

describe("exposure idempotency", () => {
  it("only sends exposure when not already marked sent", () => {
    expect(shouldSendExposure({})).toBe(true);
    expect(shouldSendExposure({ posthogExposureSentAt: 1700 })).toBe(false);
  });

  it("records success and clears previous error metadata", () => {
    expect(markExposureSent(1700)).toEqual({
      posthogExposureSentAt: 1700,
      posthogExposureLastErrorAt: undefined,
      posthogExposureLastError: undefined,
    });
  });

  it("records failure metadata without marking exposure sent", () => {
    const failure = markExposureFailure(1700, "network unavailable");
    expect(failure.posthogExposureSentAt).toBeUndefined();
    expect(failure.posthogExposureLastErrorAt).toBe(1700);
    expect(failure.posthogExposureLastError).toContain("network unavailable");
  });
});

