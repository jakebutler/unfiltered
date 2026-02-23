"use client";
import { useRef, useCallback, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { extractSignals } from "@/lib/signals/extractor";
import { computeFrictionScore, severityHint } from "@/lib/signals/scorer";
import { computeSpeechWindowBounds, computeWindowBounds, hasEnoughSpeech, selectWordsInWindow } from "@/lib/signals/windowing";
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
  onError?: (errorMessage: string) => void;
}

export function useSignalProcessor({ sessionId, taskId, getWords, getMouseFlush, onWindow, onError }: Props) {
  const addSignalWindow = useMutation(api.signals.addWindow);
  const addMouseWindow = useMutation(api.mouse.addWindow);
  const historyRef = useRef<SignalResult[]>([]);
  const lastSignalWindowEndRef = useRef<number | null>(null);
  const processingRef = useRef(false);
  const getWordsRef = useRef(getWords);
  const getMouseFlushRef = useRef(getMouseFlush);
  const onWindowRef = useRef(onWindow);
  const onErrorRef = useRef(onError);
  const taskIdRef = useRef(taskId);

  useEffect(() => {
    getWordsRef.current = getWords;
  }, [getWords]);

  useEffect(() => {
    getMouseFlushRef.current = getMouseFlush;
  }, [getMouseFlush]);

  useEffect(() => {
    onWindowRef.current = onWindow;
  }, [onWindow]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);

  const processWindow = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      const { words, sessionOffsetSec } = getWordsRef.current();
      const nowMs = Date.now();
      const { windowStart, windowEnd } = computeWindowBounds({
        sessionElapsedSec: sessionOffsetSec,
        words,
        windowSec: WINDOW_SEC,
      });

      // Compute and store mouse window on every stride, independent of transcript density.
      const { summary: mouseSummary, heatmapBins } = getMouseFlushRef.current(nowMs - WINDOW_SEC * 1000, nowMs);
      await addMouseWindow({ sessionId, tStart: windowStart, tEnd: windowEnd, taskId: taskIdRef.current, summary: mouseSummary, heatmapBins });

      const speechBounds = computeSpeechWindowBounds({
        sessionElapsedSec: sessionOffsetSec,
        words,
        windowSec: WINDOW_SEC,
      });
      if (
        lastSignalWindowEndRef.current !== null &&
        speechBounds.windowEnd <= lastSignalWindowEndRef.current + 1e-3
      ) {
        return;
      }

      const windowWords = selectWordsInWindow(words, speechBounds.windowStart, speechBounds.windowEnd);
      if (!hasEnoughSpeech(windowWords)) return;

      const signals = extractSignals(windowWords, WINDOW_SEC);
      const score = computeFrictionScore(signals, historyRef.current);
      historyRef.current = [...historyRef.current.slice(-20), signals]; // keep last 20 windows for z-score

      const severity = severityHint(score);
      const flags: string[] = [];

      await addSignalWindow({
        sessionId,
        tStart: speechBounds.windowStart,
        tEnd: speechBounds.windowEnd,
        taskId: taskIdRef.current,
        promptType: "free_explore",
        computedSignals: signals,
        friction0to100: score,
        severityHint: severity,
        flags,
      });
      lastSignalWindowEndRef.current = speechBounds.windowEnd;

      onWindowRef.current(score, signals, mouseSummary);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown signal processor error";
      onErrorRef.current?.(message);
    } finally {
      processingRef.current = false;
    }
  }, [sessionId, addSignalWindow, addMouseWindow]);

  useEffect(() => {
    const interval = setInterval(processWindow, STRIDE_SEC * 1000);
    return () => clearInterval(interval);
  }, [processWindow]);
}
