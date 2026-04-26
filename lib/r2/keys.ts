/**
 * R2 key conventions. Centralized here so naming is consistent across
 * the conduction page, the analyzer Workflow, and the retention cron.
 *
 * Buckets (declared in wrangler.toml):
 *   RECORDINGS — raw camera/screen/audio captures
 *   ANALYSIS   — analyzer Workflow stage outputs (sampled frames, intermediate JSON)
 */

export type RecordingKind = "camera" | "screen" | "audio";

export function recordingKey(opts: {
  workspaceId: string;
  studyId: string;
  sessionId: string;
  kind: RecordingKind;
  ext: string; // e.g. "webm", "mp4", "mp3"
}) {
  return `workspaces/${opts.workspaceId}/studies/${opts.studyId}/sessions/${opts.sessionId}/${opts.kind}.${opts.ext}`;
}

export function analysisKey(opts: {
  sessionId: string;
  stage: string; // e.g. "camera-signals", "screen-signals", "friction-confirm"
  ext?: string; // default "json"
}) {
  const ext = opts.ext ?? "json";
  return `sessions/${opts.sessionId}/${opts.stage}.${ext}`;
}

export function frameKey(opts: {
  sessionId: string;
  source: "camera" | "screen";
  tMs: number; // millisecond offset
  ext: string; // typically "webp" or "jpg"
}) {
  return `sessions/${opts.sessionId}/frames/${opts.source}/${String(opts.tMs).padStart(9, "0")}.${opts.ext}`;
}
