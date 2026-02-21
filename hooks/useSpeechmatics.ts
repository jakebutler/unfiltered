"use client";
import { useRef, useCallback, useState, useEffect } from "react";

interface Word { text: string; startTime: number; duration: number; }
interface TranscriptEvent { text: string; words: Word[]; startTime: number; endTime: number; isFinal: boolean; }
interface ProvisionalWord { text: string; startTime: number; duration: number | null; }

export function useSpeechmatics(onTranscript: (event: TranscriptEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const startAudio = useCallback(async (ws: WebSocket) => {
    if (contextRef.current && contextRef.current.state !== "closed") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const context = new AudioContext({ sampleRate: 44100 });
      contextRef.current = context;
      await context.audioWorklet.addModule("/audio-processor.js");
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "audio-processor");
      workletRef.current = worklet;
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };
      source.connect(worklet);
      worklet.connect(context.destination);
    } catch {
      setError("Audio capture unavailable — check microphone permissions");
    }
  }, []);

  const start = useCallback(async () => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      setError(null);
      // 1. Get short-lived JWT from our API route
      const tokenRes = await fetch("/api/speechmatics-token");
      if (!tokenRes.ok) throw new Error("Failed to get Speechmatics token");
      const { keyValue } = await tokenRes.json();

      // 2. Open WebSocket to Speechmatics RT
      const ws = new WebSocket(`wss://eu2.rt.speechmatics.com/v2?jwt=${keyValue}`);
      wsRef.current = ws;

      ws.onopen = () => {
        // 3. Send StartRecognition config
        ws.send(JSON.stringify({
          message: "StartRecognition",
          transcription_config: {
            language: "en",
            operating_point: "enhanced",
            enable_partials: false,
            max_delay: 2.0,
          },
          audio_format: {
            type: "raw",
            encoding: "pcm_s16le",
            sample_rate: 44100,
          },
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.message === "RecognitionStarted") {
          setIsConnected(true);
          startAudio(ws);
        }
        if (msg.message === "AddTranscript" && msg.results?.length > 0) {
          const provisionalWords: ProvisionalWord[] = msg.results
            .map((r: { alternatives?: { content?: string }[]; start_time?: number; end_time?: number; duration?: number }) => {
              const text = String(r.alternatives?.[0]?.content ?? "").trim();
              if (!text) return null;
              if (typeof r.start_time !== "number" || Number.isNaN(r.start_time)) return null;

              let duration: number | null = null;
              if (typeof r.duration === "number" && Number.isFinite(r.duration) && r.duration > 0) {
                duration = r.duration;
              } else if (
                typeof r.end_time === "number" &&
                Number.isFinite(r.end_time) &&
                r.end_time > r.start_time
              ) {
                duration = r.end_time - r.start_time;
              }

              return { text, startTime: r.start_time, duration };
            })
            .filter((w: ProvisionalWord | null): w is ProvisionalWord => Boolean(w))
            .sort((a: ProvisionalWord, b: ProvisionalWord) => a.startTime - b.startTime);

          const words: Word[] = provisionalWords.map((w: ProvisionalWord, i: number) => {
            if (typeof w.duration === "number" && w.duration > 0) {
              return { text: w.text, startTime: w.startTime, duration: w.duration };
            }
            const next = provisionalWords[i + 1];
            const inferred =
              next && next.startTime > w.startTime
                ? next.startTime - w.startTime
                : 0.25;
            return { text: w.text, startTime: w.startTime, duration: inferred };
          });

          if (words.length === 0) return;
          onTranscriptRef.current({
            text: words.map((w) => w.text).join(" "),
            words,
            startTime: words[0].startTime,
            endTime: words[words.length - 1].startTime + words[words.length - 1].duration,
            isFinal: true,
          });
        }
      };

      ws.onerror = () => setError("WebSocket error — check Speechmatics key and region");
      ws.onclose = () => setIsConnected(false);
    } catch (e) {
      setError(String(e));
    }
  }, [startAudio]);

  const stop = useCallback(() => {
    try {
      workletRef.current?.disconnect();
    } catch {
      // noop
    }
    if (workletRef.current) {
      workletRef.current.port.onmessage = null;
    }
    workletRef.current = null;

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }

    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => {
        // noop
      });
    }

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ message: "EndOfStream", last_seq_no: 0 }));
      ws.close();
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    setIsConnected(false);
  }, []);

  return { start, stop, isConnected, error };
}
