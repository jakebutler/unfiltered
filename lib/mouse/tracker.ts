export interface MouseEvent { type: "move" | "click" | "scroll"; x?: number; y?: number; button?: string; delta?: number; t: number; }
export interface MouseSummary { inactiveSec: number; erraticness: number; repeatClicksSameRegion: number; scrollBursts: number; }
export interface HeatmapBin { x: number; y: number; count: number; }

export function computeMouseSummary(events: MouseEvent[], windowStartMs: number, windowEndMs: number): MouseSummary {
  const windowSec = (windowEndMs - windowStartMs) / 1000;

  // Inactivity: time without any mouse move
  const moves = events.filter(e => e.type === "move").sort((a, b) => a.t - b.t);
  let activeSec = 0;
  for (let i = 1; i < moves.length; i++) {
    const gap = (moves[i].t - moves[i - 1].t) / 1000;
    if (gap < 2) activeSec += gap; // gaps > 2s count as inactive
  }
  const inactiveSec = Math.max(0, windowSec - activeSec);

  // Erraticness: direction change frequency among moves
  let directionChanges = 0;
  for (let i = 2; i < moves.length; i++) {
    if (moves[i].x === undefined || moves[i - 1].x === undefined || moves[i - 2].x === undefined) continue;
    const dx1 = (moves[i - 1].x! - moves[i - 2].x!);
    const dx2 = (moves[i].x! - moves[i - 1].x!);
    const dy1 = (moves[i - 1].y! - moves[i - 2].y!);
    const dy2 = (moves[i].y! - moves[i - 1].y!);
    if ((dx1 * dx2 + dy1 * dy2) < 0) directionChanges++;
  }
  const erraticness = moves.length > 2 ? Math.min(1, directionChanges / (moves.length - 2)) : 0;

  // Repeat clicks in same region (~5% radius)
  const clicks = events.filter(e => e.type === "click" && e.x !== undefined);
  let repeatClicksSameRegion = 0;
  for (let i = 0; i < clicks.length; i++) {
    for (let j = i + 1; j < clicks.length; j++) {
      const dist = Math.sqrt(Math.pow((clicks[j].x! - clicks[i].x!), 2) + Math.pow((clicks[j].y! - clicks[i].y!), 2));
      if (dist < 0.05) { repeatClicksSameRegion++; break; }
    }
  }

  // Scroll bursts: 3+ scrolls within 1s
  const scrolls = events.filter(e => e.type === "scroll").sort((a, b) => a.t - b.t);
  let scrollBursts = 0;
  let burstStart = 0;
  for (let i = 1; i < scrolls.length; i++) {
    if (scrolls[i].t - scrolls[burstStart].t <= 1000) {
      if (i - burstStart >= 2) scrollBursts++;
    } else burstStart = i;
  }

  return { inactiveSec: Math.round(inactiveSec * 10) / 10, erraticness: Math.round(erraticness * 100) / 100, repeatClicksSameRegion, scrollBursts };
}

export function buildHeatmapBins(events: MouseEvent[], gridSize = 20): HeatmapBin[] {
  const binMap = new Map<string, HeatmapBin>();
  for (const e of events) {
    if (e.x === undefined || e.y === undefined) continue;
    const bx = Math.floor(e.x * gridSize);
    const by = Math.floor(e.y * gridSize);
    const key = `${bx},${by}`;
    const existing = binMap.get(key);
    if (existing) existing.count++;
    else binMap.set(key, { x: bx / gridSize, y: by / gridSize, count: 1 });
  }
  return Array.from(binMap.values());
}
