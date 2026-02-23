export function isExperimentTelemetryEnabled(env: Record<string, string | undefined>): boolean {
  return env.NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED === "true";
}

