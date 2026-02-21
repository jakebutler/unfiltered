import { describe, it, expect } from 'vitest';
import { computeMouseSummary, buildHeatmapBins } from '@/lib/mouse/tracker';

type MouseEv = { type: "move" | "click" | "scroll"; x?: number; y?: number; button?: string; delta?: number; t: number };

describe('computeMouseSummary', () => {
  it('detects inactivity when no events', () => {
    const result = computeMouseSummary([], 15000, 15000);
    expect(result.inactiveSec).toBe(0); // 0s window = 0 inactivity
  });

  it('detects inactivity for a full window with no events', () => {
    const result = computeMouseSummary([], 0, 15000);
    expect(result.inactiveSec).toBe(15);
  });

  it('counts repeat clicks in same region', () => {
    const clicks: MouseEv[] = [
      { type: "click", x: 0.5, y: 0.5, t: 1000 },
      { type: "click", x: 0.51, y: 0.49, t: 2000 },
      { type: "click", x: 0.52, y: 0.5, t: 3000 },
    ];
    const result = computeMouseSummary(clicks, 1000, 4000);
    expect(result.repeatClicksSameRegion).toBeGreaterThanOrEqual(2);
  });

  it('detects scroll bursts', () => {
    const scrolls: MouseEv[] = Array.from({ length: 5 }, (_, i) => ({ type: "scroll" as const, delta: -100, t: 1000 + i * 200 }));
    const result = computeMouseSummary(scrolls, 1000, 2000);
    expect(result.scrollBursts).toBeGreaterThanOrEqual(1);
  });
});

describe('buildHeatmapBins', () => {
  it('aggregates clicks into grid bins', () => {
    const events: MouseEv[] = [
      { type: "click", x: 0.1, y: 0.1, t: 1000 },
      { type: "click", x: 0.1, y: 0.1, t: 2000 },
      { type: "move", x: 0.9, y: 0.9, t: 3000 },
    ];
    const bins = buildHeatmapBins(events, 10);
    const clickBin = bins.find(b => b.count >= 2);
    expect(clickBin).toBeDefined();
  });
});
