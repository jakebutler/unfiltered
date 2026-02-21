"use client";
import { useRef, useCallback, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { extractSignals } from "@/lib/signals/extractor";
import { computeFrictionScore, severityHint } from "@/lib/signals/scorer";
import type { SignalResult } from "@/lib/signals/extractor";

const WINDOW_SEC = 15;
const STRIDE_SEC = 5;

interface Word { text: string; startTime: number; duration: number; }

interface Props {
  sessionId: Id<"sessions">;
  taskId?: string;
  getWords: () => { words: Word[]; sessionOffsetSec: number }; // returns all buffered participant words + current session time
  getMouseFlush: (startMs: number, endMs: number) => { summary: { inactiveSec: number; erraticness: number; repeatClicksSameRegion: number; scrollBursts: number }; heatmapBins: { x: number; y: number; count: number }[] };
  onWindow: (
    friction0to100: number,
    signals: SignalResult,
    mouseSummary: { inactiveSec: number; erraticness: number; repeatClicksSameRegion: number; scrollBursts: number },
  ) => void; // callback for decide engine
}

export function useSignalProcessor({ sessionId, taskId, getWords, getMouseFlush, onWindow }: Props) {
  const addSignalWindow = useMutation(api.signals.addWindow);
  const addMouseWindow = useMutation(api.mouse.addWindow);
  const historyRef = useRef<SignalResult[]>([]);
  const processingRef = useRef(false);

  const processWindow = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
    const { words, sessionOffsetSec } = getWords();
    const windowEnd = sessionOffsetSec;
    const windowStart = Math.max(0, windowEnd - WINDOW_SEC);
    const nowMs = Date.now();

    // Filter words within this window
    const windowWords = words.filter(w => w.startTime >= windowStart && w.startTime < windowEnd);
    if (windowWords.length < 3) return; // not enough data

    // Compute signals
    const signals = extractSignals(windowWords, WINDOW_SEC);
    const score = computeFrictionScore(signals, historyRef.current);
    historyRef.current = [...historyRef.current.slice(-20), signals]; // keep last 20 windows for z-score

    const severity = severityHint(score);
    const flags: string[] = [];

    // Compute and store mouse window
    const { summary: mouseSummary, heatmapBins } = getMouseFlush(nowMs - WINDOW_SEC * 1000, nowMs);
    await addMouseWindow({ sessionId, tStart: windowStart, tEnd: windowEnd, taskId, summary: mouseSummary, heatmapBins });

    // Store signal window
    await addSignalWindow({
      sessionId,
      tStart: windowStart,
      tEnd: windowEnd,
      taskId,
      promptType: "free_explore",
      computedSignals: signals,
      friction0to100: score,
      severityHint: severity,
      flags,
    });

    onWindow(score, signals, mouseSummary);
    } finally {
      processingRef.current = false;
    }
  }, [sessionId, taskId, getWords, getMouseFlush, addSignalWindow, addMouseWindow, onWindow]);

  useEffect(() => {
    const interval = setInterval(processWindow, STRIDE_SEC * 1000);
    return () => clearInterval(interval);
  }, [processWindow]);
}
