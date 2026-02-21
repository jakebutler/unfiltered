"use client";
import { useRef, useCallback, useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

const FRAME_INTERVAL_MS = 4000; // sample every 4s; reduce to 2s if friction spikes

export function useCamera(sessionId: Id<"sessions">, taskId?: string, taskLabel?: string, recentTranscript?: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const classifyEngagement = useAction(api.classifyEngagement.classifyEngagement);
  const taskStartRef = useRef<number>(Date.now());
  const sessionStartRef = useRef<number>(Date.now());
  const latestContextRef = useRef({ taskId, taskLabel, recentTranscript });

  useEffect(() => {
    latestContextRef.current = { taskId, taskLabel, recentTranscript };
  }, [taskId, taskLabel, recentTranscript]);

  useEffect(() => {
    taskStartRef.current = Date.now();
  }, [taskId]);

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return null;
    const canvas = canvasRef.current ?? document.createElement("canvas");
    if (!canvasRef.current) canvasRef.current = canvas;
    const TARGET_WIDTH = 320;
    const scale = TARGET_WIDTH / video.videoWidth;
    canvas.width = TARGET_WIDTH;
    canvas.height = Math.floor(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Strip data URL prefix, keep only base64
    return canvas.toDataURL("image/jpeg", 0.7).replace("data:image/jpeg;base64,", "");
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 } });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.play();
      videoRef.current = video;
      setCameraActive(true);
      sessionStartRef.current = Date.now();
      taskStartRef.current = Date.now();

      intervalRef.current = setInterval(async () => {
        const frame = captureFrame();
        if (!frame) return;
        const context = latestContextRef.current;
        try {
          await classifyEngagement({
            sessionId,
            taskId: context.taskId,
            frameBase64: frame,
            recentTranscriptSnippet: context.recentTranscript?.slice(-200),
            taskLabel: context.taskLabel,
            taskTimeSec: Math.round((Date.now() - taskStartRef.current) / 1000),
            sessionTimeSec: Math.round((Date.now() - sessionStartRef.current) / 1000),
          });
        } catch {
          // Camera classifier failures should not break interview flow.
        }
      }, FRAME_INTERVAL_MS);
    } catch {
      // Camera permission denied or unavailable — silently skip (camera is optional)
      setCameraActive(false);
    }
  }, [sessionId, captureFrame, classifyEngagement]);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const stream = (videoRef.current?.srcObject as MediaStream);
    stream?.getTracks().forEach(t => t.stop());
    setCameraActive(false);
  }, []);

  return { start, stop, cameraActive };
}
