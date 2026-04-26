// ─────────────────────────────────────────────────────────────────────
// Pure-TS types shared across UI, Workers, and Workflows.
// No runtime dependencies on Cloudflare bindings, browser APIs, or LLMs.
// ─────────────────────────────────────────────────────────────────────

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────
// The `Guide` — the contract for #1 (creator), #4 (synthetic), #5 (interviewer)
// ─────────────────────────────────────────────────────────────────────
export const GuideTaskSchema = z.object({
  id: z.string(),
  goal: z.string(),
  instruction: z.string(),
  probes: z.array(z.string()).default([]),
  successSignal: z.string().optional(),
  failureSignal: z.string().optional(),
});
export type GuideTask = z.infer<typeof GuideTaskSchema>;

export const GuideSchema = z.object({
  studyId: z.string(),
  goals: z.array(z.string()).default([]),
  audience: z.string().default(""),
  warmup: z
    .object({
      questions: z.array(z.string()).default([]),
    })
    .default({ questions: [] }),
  tasks: z.array(GuideTaskSchema).default([]),
  wrapup: z
    .object({
      questions: z.array(z.string()).default([]),
    })
    .default({ questions: [] }),
  systemPromptOverrides: z.string().optional(),
});
export type Guide = z.infer<typeof GuideSchema>;

// ─────────────────────────────────────────────────────────────────────
// Persona (synthetic users)
// ─────────────────────────────────────────────────────────────────────
export const PersonaSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  studyId: z.string().nullable(),
  name: z.string(),
  demographics: z.string().optional(),
  goals: z.string().optional(),
  expertise: z.string().optional(),
  attitudes: z.string().optional(),
  antiPatterns: z.string().optional(),
  source: z.enum(["ai", "founder", "library"]),
});
export type Persona = z.infer<typeof PersonaSchema>;

// ─────────────────────────────────────────────────────────────────────
// Bot tool calls (the structured side-channel during sessions)
// ─────────────────────────────────────────────────────────────────────
export type BotEventType =
  | "markFrictionMoment"
  | "advanceTask"
  | "saveQuote"
  | "noteObservation"
  | "endSession";

export type BotEvent =
  | {
      type: "markFrictionMoment";
      ts: number;
      severity: "low" | "med" | "high";
      description: string;
    }
  | {
      type: "advanceTask";
      ts: number;
      taskId: string;
    }
  | {
      type: "saveQuote";
      ts: number;
      tStart: number;
      tEnd: number;
      text: string;
      significance: "low" | "med" | "high";
    }
  | {
      type: "noteObservation";
      ts: number;
      note: string;
    }
  | {
      type: "endSession";
      ts: number;
      reason: string;
    };

// ─────────────────────────────────────────────────────────────────────
// Analyzer output shapes (per-session)
// ─────────────────────────────────────────────────────────────────────
export interface CameraSignal {
  t: number;
  emotion?: string;
  focus?: string;
  engagement?: string;
  notes?: string;
}

export interface ScreenSignal {
  t: number;
  page?: string;
  action?: string;
  inferredEvents?: Array<{ type: string; target?: string; details?: string }>;
  frictionFlags?: string[];
}

export interface FrictionMoment {
  id: string;
  sessionId: string;
  tStart: number;
  tEnd: number;
  severity: "low" | "med" | "high";
  description: string;
  evidence: {
    transcriptChunkIds: string[];
    cameraFrameTs: number[];
    screenFrameTs: number[];
    botEventIds: string[];
  };
  themeIds: string[];
}

export interface Quote {
  id: string;
  sessionId: string;
  tStart: number;
  tEnd: number;
  text: string;
  significance: "low" | "med" | "high";
  themeIds: string[];
}

export interface Theme {
  id: string;
  studyId: string;
  name: string;
  description: string;
  evidenceCount: number;
}

export interface Finding {
  id: string;
  studyId: string;
  sessionId: string | null;
  title: string;
  description: string;
  severity: "low" | "med" | "high";
  recommendation?: string;
  evidence: {
    sessionIds: string[];
    momentIds: string[];
    quoteIds: string[];
  };
  status: "new" | "reviewed" | "acted" | "dismissed";
  shareSlug?: string | null;
  shareSettings?: {
    redactFaces: boolean;
    redactEmails: boolean;
    redactCompanyNames: boolean;
  };
}
