import { describe, expect, it } from "vitest";
import { isExperimentTelemetryEnabled } from "@/lib/telemetry/runtime";

describe("isExperimentTelemetryEnabled", () => {
  it("returns true only when NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED is true", () => {
    const original = process.env.NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED;

    process.env.NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED = "true";
    expect(isExperimentTelemetryEnabled()).toBe(true);

    process.env.NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED = "false";
    expect(isExperimentTelemetryEnabled()).toBe(false);

    delete process.env.NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED;
    expect(isExperimentTelemetryEnabled()).toBe(false);

    if (typeof original === "string") {
      process.env.NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED = original;
    } else {
      delete process.env.NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED;
    }
  });
});
