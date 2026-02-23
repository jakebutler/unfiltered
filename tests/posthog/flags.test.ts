import { describe, expect, it } from "vitest";
import {
  buildPostHogCaptureBody,
  getPostHogConfig,
  isPostHogConfigured,
} from "@/lib/posthog/flags";

describe("posthog flag helpers", () => {
  it("resolves config from env when API key exists", () => {
    const config = getPostHogConfig({
      POSTHOG_PROJECT_API_KEY: "phc_123",
      POSTHOG_HOST: "https://app.posthog.com",
    });
    expect(config).toEqual({
      apiKey: "phc_123",
      host: "https://app.posthog.com",
    });
  });

  it("returns null when no API key exists", () => {
    expect(getPostHogConfig({})).toBeNull();
    expect(isPostHogConfigured({})).toBe(false);
  });

  it("builds capture request body", () => {
    expect(
      buildPostHogCaptureBody(
        {
          event: "decision_engine_exposure",
          distinct_id: "run:abc",
          properties: { run_id: "abc" },
        },
        "phc_123",
      ),
    ).toEqual({
      api_key: "phc_123",
      event: "decision_engine_exposure",
      distinct_id: "run:abc",
      properties: { run_id: "abc" },
    });
  });
});
