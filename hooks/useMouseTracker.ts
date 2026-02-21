"use client";
import { useRef, useCallback } from "react";
import { computeMouseSummary, buildHeatmapBins } from "@/lib/mouse/tracker";
import type { MouseEvent as MouseEv } from "@/lib/mouse/tracker";

export function useMouseTracker() {
  const eventsRef = useRef<MouseEv[]>([]);

  const recordEvent = useCallback((event: MouseEv) => {
    eventsRef.current.push(event);
  }, []);

  const flushWindow = useCallback((windowStartMs: number, windowEndMs: number) => {
    const windowEvents = eventsRef.current.filter(e => e.t >= windowStartMs && e.t <= windowEndMs);
    const summary = computeMouseSummary(windowEvents, windowStartMs, windowEndMs);
    const heatmapBins = buildHeatmapBins(windowEvents);
    // Keep a short rolling buffer to avoid unbounded growth in long sessions.
    eventsRef.current = eventsRef.current.filter((e) => e.t >= windowStartMs - 60_000);
    return { summary, heatmapBins, eventCount: windowEvents.length };
  }, []);

  const clear = useCallback(() => { eventsRef.current = []; }, []);

  return { recordEvent, flushWindow, clear };
}
