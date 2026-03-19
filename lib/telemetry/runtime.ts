export function isExperimentTelemetryEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED === "true";
}
