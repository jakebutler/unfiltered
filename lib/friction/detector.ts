export interface WindowRecord {
  tStart: number;
  tEnd: number;
  friction0to100: number;
  taskId?: string;
  severityHint: string;
  computedSignals: {
    negAffectCount: number;
    explicitUncertaintyCount: number;
    clarificationCount: number;
    veryLongPauseCount: number;
    longPauseCount: number;
    repairsPer100w: number;
    repetitionsPer100w: number;
    hedgesPer100w: number;
    filledPausePer100w: number;
    backtrackCount: number;
    pauseTimeRatio: number;
    clarityIndex: number;
    repeatAttemptLoopFlag: boolean;
  };
  flags: string[];
}

export interface FrictionCluster {
  tStart: number;
  tEnd: number;
  taskId: string;
  frictionPeak: number;
  signalTags: string[];
}

const MAX_CLUSTER_GAP_SEC = 30;

function getSignalTags(signals: WindowRecord['computedSignals']): string[] {
  const tags: string[] = [];
  if (signals.negAffectCount >= 1) tags.push("negative_affect");
  if (signals.explicitUncertaintyCount >= 1) tags.push("explicit_uncertainty");
  if (signals.clarificationCount >= 1) tags.push("clarification_request");
  if (signals.veryLongPauseCount >= 1) tags.push("very_long_pause");
  if (signals.longPauseCount >= 2) tags.push("long_pause");
  if (signals.repairsPer100w >= 2) tags.push("self_repair");
  if (signals.repetitionsPer100w >= 2) tags.push("repetition");
  if (signals.backtrackCount >= 1) tags.push("backtracking");
  if (signals.repeatAttemptLoopFlag) tags.push("repeat_attempt_loop");
  return tags;
}

export function clusterFrictionWindows(
  windows: WindowRecord[],
  frictionThreshold = 40,
): FrictionCluster[] {
  const highFriction = windows
    .filter((w) => w.friction0to100 >= frictionThreshold)
    .sort((a, b) => a.tStart - b.tStart);

  if (highFriction.length === 0) return [];

  const clusters: FrictionCluster[] = [];
  let current: WindowRecord[] = [highFriction[0]];

  for (let i = 1; i < highFriction.length; i++) {
    const prev = current[current.length - 1];
    const curr = highFriction[i];
    const gapSec = curr.tStart - prev.tEnd;
    if (gapSec <= MAX_CLUSTER_GAP_SEC) {
      current.push(curr);
    } else {
      clusters.push(buildCluster(current));
      current = [curr];
    }
  }
  clusters.push(buildCluster(current));
  return clusters;
}

function buildCluster(windows: WindowRecord[]): FrictionCluster {
  const tStart = windows[0].tStart;
  const tEnd = windows[windows.length - 1].tEnd;
  const frictionPeak = Math.max(...windows.map((w) => w.friction0to100));
  const allTags = new Set(windows.flatMap((w) => getSignalTags(w.computedSignals)));
  return {
    tStart,
    tEnd,
    taskId: windows[0].taskId ?? "unknown",
    frictionPeak,
    signalTags: Array.from(allTags),
  };
}
