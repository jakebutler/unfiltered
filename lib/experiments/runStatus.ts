export type RunStatus = "running" | "paused" | "complete" | "aborted";

export function canResumeRun(status: RunStatus): boolean {
  return status === "paused";
}
