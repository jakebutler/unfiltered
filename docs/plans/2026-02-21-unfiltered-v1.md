# Unfiltered V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Repo note (2026-02-21):** The repository root is now `unfiltered/`. Ignore older bootstrap steps that create or `cd` into an `unfiltered` subdirectory.

**Goal:** Build an end-to-end AI UX interview platform that conducts live sessions, detects friction in real-time via conversation cues + multimodal signals, and produces an evidence-backed findings dashboard.

**Architecture:** Next.js 15 (App Router) + TypeScript frontend. Convex is the reactive backend — all DB writes, external API calls (FireworksAI GLM-5, MiniMax), and post-session processing happen in Convex mutations/actions. Signal extraction and Policy A are pure TypeScript functions unit-tested with Vitest. The interview room is a single client component that orchestrates Speechmatics WebSocket, camera frame capture, mouse tracking, and 15s sliding signal windows — all feeding into the Decide Engine every window cycle.

**Tech Stack:** Next.js 15 · TypeScript · shadcn/ui · Tailwind CSS · Convex · OpenAI SDK pointed at FireworksAI (GLM-5 for Policy B + labeler + themes) · OpenAI SDK pointed at MiniMax API (MiniMax Vision for camera) · Speechmatics Realtime API · Web Speech API (SpeechSynthesis for AI voice) · Vitest

**Reference Docs:**

*Product & technical specs (in `docs/`):*
- `docs/spec.md` — product spec (UX flows, features, user experience)
- `docs/techspec.md` — technical architecture, data model, API integrations, scoring formula
- `docs/feature-signal-detection.md` — signal extractor + scorer details (Tasks 8, 9, 15)
- `docs/feature-decide-engine.md` — Policy A + B decide engine details (Tasks 10, 16, 17)
- `docs/feature-camera-classifier.md` — MiniMax Vision classifier details (Task 14)
- `docs/feature-findings-dashboard.md` — post-session pipeline + dashboard details (Tasks 18–22)
- `docs/feature-speechmatics.md` — Speechmatics WebSocket + AudioWorklet details (Tasks 7, 12)

*Prompt specs and research (repo root — do not modify during build):*
- `behavioral-friction-signal-research.md` — signal formulas, thresholds, scoring
- `camera-engagement-classifier.md` — MiniMax prompt + output schema
- `decide-engine-policy-b-prompt.md` — Policy B LLM prompt
- `determinstic-decide-policy.md` — Policy A 7-step rule cascade (filename typo is intentional)
- `post-session-candidate-finding-labeler.md` — finding labeler prompt
- `multimodal-cross-reference-explainer.md` — Tier 2 (not V1)

---

## Task 0: Documentation Foundation ✅ COMPLETE

**Verification:** ✅ Manual — all files exist at the paths listed below

**Status:** Already completed in the planning session. No code changes needed.

**Files created:**
- `docs/spec.md` — product spec (UX/behavioral, source of truth for experience)
- `docs/techspec.md` — technical spec (architecture, data model, scoring, API integrations)
- `docs/feature-signal-detection.md` — signal detection feature stub
- `docs/feature-decide-engine.md` — decide engine feature stub
- `docs/feature-camera-classifier.md` — camera classifier feature stub
- `docs/feature-findings-dashboard.md` — findings dashboard feature stub
- `docs/feature-speechmatics.md` — Speechmatics integration feature stub
- `docs/changelog.md` — append-only session log (auto-updated by stop hook)
- `docs/projectstatus.md` — current session status (auto-updated by stop hook, overwritten each session)
- `CLAUDE.md` — project context for Claude Code (start here each session)
- `.claude/settings.json` — Claude Code stop hook config
- `scripts/update-docs.py` — stop hook script (calls Claude Haiku to update docs after each session)
- `DEPRECATED-spec.md` — original combined spec (do not use; superseded by docs/spec.md + docs/techspec.md)

**Key decisions recorded:**
- Friction score: numeric 0–100 → maps to LOW/MED/HIGH for display
- Camera: store full `signals` sub-object (4 booleans + notes)
- `verification_question`: computed and stored in V1; founder confirmation UI is V2
- Post-session labeler runs on ALL friction moments
- Mouse summary canonical shape: `{ inactiveSec, erraticness, repeatClicksSameRegion, scrollBursts }`
- Policy A and B share identical 5-field output schema
- AI voice: Web Speech API (SpeechSynthesis) — ElevenLabs is nice-to-have
- Policy B model: GLM-5 via FireworksAI (speed + cost); Labeler model: GLM-5 via FireworksAI (quality)

**⚠ Pre-build check before Task 14:**
- Verify MiniMax Vision model name at MiniMax API docs before Task 14 (expected: `MiniMax-VL-01`)
- Verify GLM-5 model name at `fireworks.ai/models` before Task 16 (expected: `accounts/fireworks/models/glm-5`)
- Update model names in `convex/classifyEngagement.ts` and `convex/decide.ts` / `convex/findings.ts` if needed

---

## Task 1: Project Bootstrap

**Verification:** ✅ Automated — vitest runs green

**Files:**
- Create: project root (via `create-next-app`)
- Create: `vitest.config.ts`
- Create: `.env.local`
- Create: `public/audio-processor.js`
- Create: `docs/plans/` (directory)

---

**Step 1: Scaffold Next.js app**

```bash
npx create-next-app@latest unfiltered --typescript --tailwind --app --src-dir=false --import-alias="@/*"
cd unfiltered
```

**Step 2: Install runtime dependencies**

```bash
npm install convex openai
```

**Step 3: Install dev dependencies**

```bash
npm install -D vitest @vitest/ui
```

**Step 4: Initialize Convex**

```bash
npx convex dev
```

Follow prompts: create a new project. This writes `NEXT_PUBLIC_CONVEX_URL` to `.env.local` and scaffolds `convex/`.

**Step 5: Initialize shadcn/ui**

```bash
npx shadcn@latest init
```

Accept defaults (Default style, Slate, CSS variables).

**Step 6: Add required shadcn components**

```bash
npx shadcn@latest add button card input label textarea select badge separator tabs scroll-area progress alert
```

**Step 7: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
})
```

**Step 8: Add test scripts to `package.json`**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 9: Create `.env.local`** (fill keys before running)

```env
# Auto-set by `npx convex dev`
NEXT_PUBLIC_CONVEX_URL=https://your-project.convex.cloud

SPEECHMATICS_API_KEY=your_speechmatics_api_key
FIREWORKS_API_KEY=your_fireworks_api_key
MINIMAX_API_KEY=your_minimax_api_key
```

**Step 10: Create AudioWorklet processor at `public/audio-processor.js`**

This file converts Float32 microphone audio to Int16 PCM and posts it to the main thread for the Speechmatics WebSocket. It must be a plain JS file (not TypeScript) served from the public directory.

```javascript
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const float32 = input[0];
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true; // keep processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);
```

**Step 11: Create `app/providers.tsx`** — wraps app with ConvexProvider

```typescript
"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
```

**Step 12: Update `app/layout.tsx`** to wrap children with ConvexClientProvider

```typescript
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "./providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Unfiltered",
  description: "AI UX Researcher",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
```

**Step 13: Create smoke test**

Create `tests/setup.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'

describe('setup', () => {
  it('vitest is configured', () => {
    expect(1 + 1).toBe(2)
  })
})
```

**Step 14: Run test**

```bash
npm test
```

Expected output: `✓ tests/setup.test.ts > setup > vitest is configured`

**Step 15: Create docs directory**

```bash
mkdir -p docs/plans
```

**Step 16: Commit**

```bash
git add -A
git commit -m "feat: bootstrap Next.js + Convex + shadcn + vitest"
```

---

## Task 2: Convex Schema

**Verification:** 🧪 Manual — with `npx convex dev` running, saving the file auto-pushes; verify all tables appear in the Convex dashboard at console.convex.dev

**Files:**
- Create: `convex/schema.ts`

---

**Step 1: Create `convex/schema.ts`**

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  studies: defineTable({
    title: v.string(),
    prototypeUrl: v.string(),
    prdText: v.optional(v.string()),
    tasks: v.array(v.object({ id: v.string(), label: v.string() })),
    decideMode: v.union(v.literal("A"), v.literal("B"), v.literal("AB")),
    createdAt: v.number(),
  }),

  sessions: defineTable({
    studyId: v.id("studies"),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    currentTaskIndex: v.number(),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("complete")),
    outputs: v.optional(v.object({
      themes: v.optional(v.array(v.string())),
      summary: v.optional(v.string()),
      sessionFriction: v.optional(v.number()),
    })),
  }).index("by_study", ["studyId"]),

  transcriptSegments: defineTable({
    sessionId: v.id("sessions"),
    speakerId: v.union(v.literal("participant"), v.literal("interviewer")),
    text: v.string(),
    words: v.array(v.object({
      text: v.string(),
      startTime: v.number(),
      duration: v.number(),
    })),
    startTime: v.number(),
    endTime: v.number(),
    taskId: v.optional(v.string()),
  }).index("by_session", ["sessionId"]),

  signalWindows: defineTable({
    sessionId: v.id("sessions"),
    tStart: v.number(),
    tEnd: v.number(),
    taskId: v.optional(v.string()),
    promptType: v.optional(v.union(
      v.literal("moderator_question"),
      v.literal("user_action"),
      v.literal("system_error"),
      v.literal("free_explore"),
    )),
    contextHint: v.optional(v.string()),
    computedSignals: v.object({
      filledPausePer100w: v.number(),
      hedgesPer100w: v.number(),
      explicitUncertaintyCount: v.number(),
      longPauseCount: v.number(),
      veryLongPauseCount: v.number(),
      pauseTimeRatio: v.number(),
      repairsPer100w: v.number(),
      repetitionsPer100w: v.number(),
      clarificationCount: v.number(),
      negAffectCount: v.number(),
      clarityIndex: v.number(),
      backtrackCount: v.number(),
      repeatAttemptLoopFlag: v.boolean(),
    }),
    friction0to100: v.number(),
    severityHint: v.union(v.literal("LOW"), v.literal("MED"), v.literal("HIGH")),
    flags: v.array(v.string()),
  }).index("by_session", ["sessionId"]),

  engagementEvents: defineTable({
    sessionId: v.id("sessions"),
    taskId: v.optional(v.string()),
    t: v.number(),
    state: v.union(
      v.literal("engaged_active"),
      v.literal("engaged_stuck"),
      v.literal("disengaged_away"),
      v.literal("uncertain_low_confidence"),
    ),
    confidence: v.number(),
    signals: v.object({
      facePresent: v.boolean(),
      gazeTowardScreenLikely: v.boolean(),
      attentionStableLikely: v.boolean(),
      visibleFrustrationCuesLikely: v.boolean(),
    }),
    notes: v.string(),
    frameHash: v.optional(v.string()),
  }).index("by_session", ["sessionId"]),

  mouseWindows: defineTable({
    sessionId: v.id("sessions"),
    tStart: v.number(),
    tEnd: v.number(),
    taskId: v.optional(v.string()),
    summary: v.object({
      inactiveSec: v.number(),
      erraticness: v.number(),
      repeatClicksSameRegion: v.number(),
      scrollBursts: v.number(),
    }),
    heatmapBins: v.optional(v.array(v.object({
      x: v.number(),
      y: v.number(),
      count: v.number(),
    }))),
  }).index("by_session", ["sessionId"]),

  decideEvents: defineTable({
    sessionId: v.id("sessions"),
    t: v.number(),
    policyUsed: v.union(v.literal("deterministic"), v.literal("llm")),
    inputSummary: v.string(),
    outputAction: v.union(
      v.literal("ask_followup"),
      v.literal("clarify_task"),
      v.literal("reflect_back"),
      v.literal("move_to_next_task"),
      v.literal("wait"),
    ),
    outputPrompt: v.string(),
    probeType: v.union(
      v.literal("expectation"),
      v.literal("comprehension"),
      v.literal("navigation"),
      v.literal("system_status"),
      v.literal("emotion_checkin"),
      v.literal("move_on"),
      v.literal("none"),
    ),
    confidence: v.number(),
  }).index("by_session", ["sessionId"]),

  frictionMoments: defineTable({
    sessionId: v.id("sessions"),
    taskId: v.string(),
    tStart: v.number(),
    tEnd: v.number(),
    frictionPeak: v.number(),
    evidence: v.object({
      transcriptSnippets: v.array(v.string()),
      pauseSpans: v.array(v.object({ start: v.number(), end: v.number() })),
      matchedPhrases: v.array(v.string()),
    }),
    signalTags: v.array(v.string()),
    engagementSnapshot: v.optional(v.object({
      state: v.string(),
      confidence: v.number(),
    })),
    mouseSnapshot: v.optional(v.object({
      inactiveSec: v.number(),
      erraticness: v.number(),
      repeatClicksSameRegion: v.number(),
      scrollBursts: v.number(),
    })),
    candidateFindingLabel: v.optional(v.string()),
    category: v.optional(v.union(
      v.literal("copy_language"),
      v.literal("discoverability"),
      v.literal("system_status_feedback"),
      v.literal("navigation_ia"),
      v.literal("form_field_friction"),
      v.literal("task_prompt_issue"),
      v.literal("error_recovery"),
      v.literal("other"),
    )),
    interpretation: v.optional(v.string()),
    recommendations: v.optional(v.array(v.string())),
    verificationQuestion: v.optional(v.string()),
    labelConfidence: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),
});
```

**Step 2: Verify**

Open the Convex dashboard. All 8 tables should appear: `studies`, `sessions`, `transcriptSegments`, `signalWindows`, `engagementEvents`, `mouseWindows`, `decideEvents`, `frictionMoments`.

**Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat: define Convex schema for all Unfiltered data models"
```

---

## Task 3: Convex CRUD — Studies + Sessions

**Verification:** 🧪 Manual — use the Convex dashboard "Run function" panel to call each mutation and verify rows appear in the table

**Files:**
- Create: `convex/studies.ts`
- Create: `convex/sessions.ts`
- Create: `convex/transcripts.ts`

---

**Step 1: Create `convex/studies.ts`**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    title: v.string(),
    prototypeUrl: v.string(),
    prdText: v.optional(v.string()),
    tasks: v.array(v.object({ id: v.string(), label: v.string() })),
    decideMode: v.union(v.literal("A"), v.literal("B"), v.literal("AB")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("studies", { ...args, createdAt: Date.now() });
  },
});

export const get = query({
  args: { studyId: v.id("studies") },
  handler: async (ctx, args) => ctx.db.get(args.studyId),
});

export const list = query({
  args: {},
  handler: async (ctx) => ctx.db.query("studies").order("desc").take(50),
});
```

**Step 2: Create `convex/sessions.ts`**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: { studyId: v.id("studies") },
  handler: async (ctx, args) => {
    return await ctx.db.insert("sessions", {
      studyId: args.studyId,
      currentTaskIndex: 0,
      status: "pending",
    });
  },
});

export const start = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, { status: "active", startedAt: Date.now() });
  },
});

export const end = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, { status: "complete", endedAt: Date.now() });
  },
});

export const advanceTask = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await ctx.db.patch(args.sessionId, { currentTaskIndex: session.currentTaskIndex + 1 });
  },
});

export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => ctx.db.get(args.sessionId),
});

export const getWithStudy = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const study = await ctx.db.get(session.studyId);
    return { session, study };
  },
});

export const listByStudy = query({
  args: { studyId: v.id("studies") },
  handler: async (ctx, args) =>
    ctx.db.query("sessions").withIndex("by_study", (q) => q.eq("studyId", args.studyId)).collect(),
});
```

**Step 3: Create `convex/transcripts.ts`**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const addSegment = mutation({
  args: {
    sessionId: v.id("sessions"),
    speakerId: v.union(v.literal("participant"), v.literal("interviewer")),
    text: v.string(),
    words: v.array(v.object({ text: v.string(), startTime: v.number(), duration: v.number() })),
    startTime: v.number(),
    endTime: v.number(),
    taskId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("transcriptSegments", args);
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) =>
    ctx.db.query("transcriptSegments").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect(),
});
```

**Step 4: Commit**

```bash
git add convex/studies.ts convex/sessions.ts convex/transcripts.ts
git commit -m "feat: add Convex CRUD for studies, sessions, and transcripts"
```

---

## Task 4: Study Creation UI (Founder Flow)

**Verification:** 🧪 Manual — create a study, verify it appears in the Convex dashboard and on the studies list page

**Files:**
- Create: `app/page.tsx` (redirect)
- Create: `app/studies/page.tsx`
- Create: `app/studies/new/page.tsx`
- Create: `app/studies/[studyId]/page.tsx`

---

**Step 1: `app/page.tsx`** — redirect root to studies

```typescript
import { redirect } from "next/navigation";
export default function Home() { redirect("/studies"); }
```

**Step 2: `app/studies/page.tsx`** — list all studies

```typescript
"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function StudiesPage() {
  const studies = useQuery(api.studies.list);
  return (
    <div className="max-w-2xl mx-auto p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Studies</h1>
        <Button asChild><Link href="/studies/new">New Study</Link></Button>
      </div>
      <div className="space-y-3">
        {studies?.map((s) => (
          <Card key={s._id}>
            <CardHeader>
              <CardTitle>{s.title}</CardTitle>
              <CardDescription>{s.tasks.length} task(s) · Mode {s.decideMode}</CardDescription>
              <div className="flex gap-2 mt-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/studies/${s._id}`}>Manage</Link>
                </Button>
              </div>
            </CardHeader>
          </Card>
        ))}
        {studies?.length === 0 && <p className="text-muted-foreground">No studies yet.</p>}
      </div>
    </div>
  );
}
```

**Step 3: `app/studies/new/page.tsx`** — study creation form

```typescript
"use client";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NewStudyPage() {
  const router = useRouter();
  const createStudy = useMutation(api.studies.create);
  const [title, setTitle] = useState("");
  const [prototypeUrl, setPrototypeUrl] = useState("");
  const [prdText, setPrdText] = useState("");
  const [decideMode, setDecideMode] = useState<"A" | "B" | "AB">("B");
  const [tasks, setTasks] = useState([{ id: "t1", label: "" }]);
  const [loading, setLoading] = useState(false);

  const addTask = () => {
    if (tasks.length >= 3) return;
    setTasks([...tasks, { id: `t${tasks.length + 1}`, label: "" }]);
  };

  const updateTask = (index: number, label: string) => {
    const next = [...tasks];
    next[index] = { ...next[index], label };
    setTasks(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const validTasks = tasks.filter((t) => t.label.trim());
    if (!validTasks.length) { setLoading(false); return; }
    const id = await createStudy({ title, prototypeUrl, prdText: prdText || undefined, tasks: validTasks, decideMode });
    router.push(`/studies/${id}`);
  };

  return (
    <div className="max-w-xl mx-auto p-8">
      <Card>
        <CardHeader><CardTitle>New Study</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div><Label>Study Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
            <div><Label>Prototype URL (will be shown in iframe)</Label><Input value={prototypeUrl} onChange={(e) => setPrototypeUrl(e.target.value)} placeholder="https://..." required /></div>
            <div><Label>PRD / Context (optional)</Label><Textarea value={prdText} onChange={(e) => setPrdText(e.target.value)} rows={4} placeholder="Paste product context here..." /></div>
            <div>
              <Label>Tasks (1–3)</Label>
              {tasks.map((t, i) => (
                <Input key={t.id} className="mt-2" placeholder={`Task ${i + 1}…`} value={t.label} onChange={(e) => updateTask(i, e.target.value)} />
              ))}
              {tasks.length < 3 && <Button type="button" variant="outline" size="sm" className="mt-2" onClick={addTask}>+ Add Task</Button>}
            </div>
            <div>
              <Label>Decide Mode</Label>
              <Select value={decideMode} onValueChange={(v) => setDecideMode(v as "A" | "B" | "AB")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">A — Deterministic rules</SelectItem>
                  <SelectItem value="B">B — Bounded LLM (GLM-5 via FireworksAI)</SelectItem>
                  <SelectItem value="AB">A/B — Alternate sessions</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={loading} className="w-full">{loading ? "Creating…" : "Create Study"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 4: `app/studies/[studyId]/page.tsx`** — study detail with participant link

```typescript
"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Id } from "@/convex/_generated/dataModel";

export default function StudyDetailPage() {
  const params = useParams();
  const studyId = params.studyId as Id<"studies">;
  const study = useQuery(api.studies.get, { studyId });
  const sessions = useQuery(api.sessions.listByStudy, { studyId });
  const createSession = useMutation(api.sessions.create);

  if (!study) return <div className="p-8">Loading…</div>;

  const participantLink = `${window.location.origin}/join/${study._id}`;

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/studies" className="text-muted-foreground text-sm">← Studies</Link>
        <h1 className="text-2xl font-bold">{study.title}</h1>
        <Badge>Mode {study.decideMode}</Badge>
      </div>
      <Card>
        <CardHeader><CardTitle>Participant Link</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm font-mono bg-muted p-2 rounded break-all">{participantLink}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => navigator.clipboard.writeText(participantLink)}>Copy Link</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Tasks</CardTitle></CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-1">
            {study.tasks.map((t) => <li key={t.id}>{t.label}</li>)}
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Sessions ({sessions?.length ?? 0})</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {sessions?.map((s) => (
              <div key={s._id} className="flex items-center justify-between">
                <span className="text-sm font-mono">{s._id.slice(-8)}</span>
                <Badge variant={s.status === "complete" ? "default" : "secondary"}>{s.status}</Badge>
                {s.status === "complete" && (
                  <Button size="sm" asChild><Link href={`/dashboard/${s._id}`}>View Results</Link></Button>
                )}
              </div>
            ))}
            {sessions?.length === 0 && <p className="text-sm text-muted-foreground">No sessions yet. Share the participant link.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 5: Commit**

```bash
git add app/
git commit -m "feat: founder study creation UI and study detail page"
```

---

## Task 5: Participant Landing, Session Init + Consent

**Verification:** 🧪 Manual — visit `/join/[studyId]`, click through consent, verify a `sessions` row is created in Convex dashboard with `status: "active"`

**Files:**
- Create: `app/join/[studyId]/page.tsx`

---

**Step 1: Create `app/join/[studyId]/page.tsx`**

```typescript
"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Id } from "@/convex/_generated/dataModel";

export default function JoinPage() {
  const params = useParams();
  const router = useRouter();
  const studyId = params.studyId as Id<"studies">;
  const study = useQuery(api.studies.get, { studyId });
  const createSession = useMutation(api.sessions.create);
  const startSession = useMutation(api.sessions.start);

  const [micConsent, setMicConsent] = useState(false);
  const [mouseConsent, setMouseConsent] = useState(false);
  const [cameraConsent, setCameraConsent] = useState(false);
  const [starting, setStarting] = useState(false);

  if (!study) return <div className="p-8">Loading…</div>;

  const canStart = micConsent && mouseConsent;

  const handleStart = async () => {
    setStarting(true);
    const sessionId = await createSession({ studyId });
    await startSession({ sessionId });
    router.push(`/interview/${sessionId}`);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome to "{study.title}"</CardTitle>
          <CardDescription>
            You're about to participate in a UX interview session. An AI interviewer will ask you to complete a few tasks and think aloud.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm font-medium">Before we start, please confirm:</p>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Checkbox id="mic" checked={micConsent} onCheckedChange={(c) => setMicConsent(!!c)} />
              <Label htmlFor="mic" className="text-sm leading-snug">
                <strong>Microphone (required).</strong> Your voice will be transcribed in real time to support the interview.
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox id="mouse" checked={mouseConsent} onCheckedChange={(c) => setMouseConsent(!!c)} />
              <Label htmlFor="mouse" className="text-sm leading-snug">
                <strong>Mouse tracking (required).</strong> Clicks, movements, and scrolls on the prototype will be recorded for UX analysis.
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox id="camera" checked={cameraConsent} onCheckedChange={(c) => setCameraConsent(!!c)} />
              <Label htmlFor="camera" className="text-sm leading-snug">
                <strong>Camera (optional, recommended).</strong> Webcam frames are analyzed for engagement cues. No footage is stored.
              </Label>
            </div>
          </div>
          <Button className="w-full mt-4" disabled={!canStart || starting} onClick={handleStart}>
            {starting ? "Starting session…" : "I agree — Start Interview"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

Note: `Checkbox` requires `npx shadcn@latest add checkbox` if not already included. Run that now.

**Step 2: Add checkbox component**

```bash
npx shadcn@latest add checkbox
```

**Step 3: Commit**

```bash
git add app/join/
git commit -m "feat: participant landing + consent flow with session initialization"
```

---

## Task 6: Interview Room Shell

**Verification:** 🧪 Manual — visit `/interview/[sessionId]`, verify split layout renders with prototype iframe on left and interview panel on right; status indicator shows "Listening"

**Files:**
- Create: `app/interview/[sessionId]/page.tsx`
- Create: `components/interview/PrototypeFrame.tsx`
- Create: `components/interview/InterviewPanel.tsx`
- Create: `components/interview/StatusIndicator.tsx`
- Create: `components/interview/TranscriptDisplay.tsx`

---

**Step 1: Create `components/interview/StatusIndicator.tsx`**

```typescript
import { Badge } from "@/components/ui/badge";

type Status = "listening" | "thinking" | "speaking";

export function StatusIndicator({ status }: { status: Status }) {
  const config = {
    listening: { label: "Listening", className: "bg-green-100 text-green-800" },
    thinking:  { label: "Thinking…", className: "bg-yellow-100 text-yellow-800" },
    speaking:  { label: "Speaking", className: "bg-blue-100 text-blue-800" },
  };
  const { label, className } = config[status];
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${status === "listening" ? "bg-green-500" : status === "thinking" ? "bg-yellow-500" : "bg-blue-500"}`} />
      <Badge className={className}>{label}</Badge>
    </div>
  );
}
```

**Step 2: Create `components/interview/TranscriptDisplay.tsx`**

```typescript
import { ScrollArea } from "@/components/ui/scroll-area";

interface Word { text: string; startTime: number; duration: number; }
interface Segment { _id: string; speakerId: "participant" | "interviewer"; text: string; words: Word[]; startTime: number; }

export function TranscriptDisplay({ segments }: { segments: Segment[] }) {
  return (
    <ScrollArea className="h-48 border rounded p-2 bg-muted/30">
      <div className="space-y-2 text-sm">
        {segments.map((s) => (
          <div key={s._id} className={`${s.speakerId === "interviewer" ? "text-blue-700 font-medium" : "text-foreground"}`}>
            <span className="text-xs text-muted-foreground mr-1">{s.speakerId === "interviewer" ? "AI:" : "You:"}</span>
            {s.text}
          </div>
        ))}
        {segments.length === 0 && <p className="text-muted-foreground italic">Transcript will appear here…</p>}
      </div>
    </ScrollArea>
  );
}
```

**Step 3: Create `components/interview/PrototypeFrame.tsx`**

```typescript
"use client";
import { useRef, useEffect } from "react";

interface Props {
  url: string;
  onMouseEvent: (event: { type: "move" | "click" | "scroll"; x?: number; y?: number; button?: string; delta?: number; t: number }) => void;
}

export function PrototypeFrame({ url, onMouseEvent }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const toRelative = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    };

    const onMove = (e: MouseEvent) => onMouseEvent({ type: "move", ...toRelative(e), t: Date.now() });
    const onClick = (e: MouseEvent) => onMouseEvent({ type: "click", ...toRelative(e), button: e.button === 0 ? "left" : "right", t: Date.now() });
    const onScroll = (e: WheelEvent) => onMouseEvent({ type: "scroll", delta: e.deltaY, t: Date.now() });

    el.addEventListener("mousemove", onMove);
    el.addEventListener("click", onClick);
    el.addEventListener("wheel", onScroll);
    return () => { el.removeEventListener("mousemove", onMove); el.removeEventListener("click", onClick); el.removeEventListener("wheel", onScroll); };
  }, [onMouseEvent]);

  return (
    <div ref={containerRef} className="relative w-full h-full">
      <iframe src={url} className="w-full h-full border-0 rounded-l" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" title="Prototype" />
    </div>
  );
}
```

**Step 4: Create `components/interview/InterviewPanel.tsx`**

```typescript
import { StatusIndicator } from "./StatusIndicator";
import { TranscriptDisplay } from "./TranscriptDisplay";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type Status = "listening" | "thinking" | "speaking";
interface Segment { _id: string; speakerId: "participant" | "interviewer"; text: string; words: { text: string; startTime: number; duration: number }[]; startTime: number; }

interface Props {
  status: Status;
  segments: Segment[];
  currentTask: { id: string; label: string } | null;
  taskIndex: number;
  totalTasks: number;
  onEndTurn: () => void;
}

export function InterviewPanel({ status, segments, currentTask, taskIndex, totalTasks, onEndTurn }: Props) {
  const progress = totalTasks > 0 ? ((taskIndex) / totalTasks) * 100 : 0;
  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">AI Interviewer</h2>
        <StatusIndicator status={status} />
      </div>
      {currentTask && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Task {taskIndex + 1} of {totalTasks}</p>
          <Progress value={progress} className="h-1" />
          <p className="text-sm font-medium">{currentTask.label}</p>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        <TranscriptDisplay segments={segments} />
      </div>
      <Button variant="outline" size="sm" onClick={onEndTurn} className="self-start">
        End Turn →
      </Button>
    </div>
  );
}
```

**Step 5: Create `app/interview/[sessionId]/page.tsx`**

This is the main orchestration component. For now wire up the shell; the real hooks (Speechmatics, camera, mouse, decide) will be added in later tasks and imported here.

```typescript
"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { useState, useCallback } from "react";
import { Id } from "@/convex/_generated/dataModel";
import { PrototypeFrame } from "@/components/interview/PrototypeFrame";
import { InterviewPanel } from "@/components/interview/InterviewPanel";

export default function InterviewPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as Id<"sessions">;
  const data = useQuery(api.sessions.getWithStudy, { sessionId });
  const segments = useQuery(api.transcripts.listBySession, { sessionId });
  const advanceTask = useMutation(api.sessions.advanceTask);
  const endSession = useMutation(api.sessions.end);

  const [interviewerStatus, setInterviewerStatus] = useState<"listening" | "thinking" | "speaking">("listening");

  const handleMouseEvent = useCallback((event: { type: "move" | "click" | "scroll"; x?: number; y?: number; button?: string; delta?: number; t: number }) => {
    // Mouse events are buffered and processed in Task 12
    // Store in a local ref for windowed processing
  }, []);

  const handleEndTurn = useCallback(async () => {
    if (!data?.session) return;
    const { session, study } = data;
    if (!study) return;
    const nextIndex = session.currentTaskIndex + 1;
    if (nextIndex >= study.tasks.length) {
      await endSession({ sessionId });
      router.push(`/dashboard/${sessionId}`);
    } else {
      await advanceTask({ sessionId });
    }
  }, [data, sessionId, advanceTask, endSession, router]);

  if (!data?.session || !data.study) return <div className="p-8">Loading session…</div>;

  const { session, study } = data;
  const currentTask = study.tasks[session.currentTaskIndex] ?? null;

  return (
    <div className="flex h-screen">
      <div className="flex-1 bg-muted">
        <PrototypeFrame url={study.prototypeUrl} onMouseEvent={handleMouseEvent} />
      </div>
      <div className="w-80 border-l bg-background flex flex-col">
        <InterviewPanel
          status={interviewerStatus}
          segments={segments ?? []}
          currentTask={currentTask}
          taskIndex={session.currentTaskIndex}
          totalTasks={study.tasks.length}
          onEndTurn={handleEndTurn}
        />
      </div>
    </div>
  );
}
```

**Step 6: Commit**

```bash
git add app/interview/ components/interview/
git commit -m "feat: interview room shell with split layout and panel components"
```

---

## Task 7: Speechmatics JWT API Route

**Verification:** 🧪 Manual — `curl http://localhost:3000/api/speechmatics-token` should return `{"keyValue":"<JWT>"}` (requires a valid `SPEECHMATICS_API_KEY` in `.env.local`)

**Files:**
- Create: `app/api/speechmatics-token/route.ts`

---

**Step 1: Create `app/api/speechmatics-token/route.ts`**

Speechmatics requires a temporary JWT for browser WebSocket connections. This route calls the Speechmatics Management API on the server side (where the API key is safe) and returns a short-lived token.

```typescript
import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.SPEECHMATICS_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "SPEECHMATICS_API_KEY not set" }, { status: 500 });

  const res = await fetch("https://mp.speechmatics.com/v1/api_keys?type=rt", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl: 3600 }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: "Speechmatics token request failed", detail: text }, { status: 502 });
  }

  const data = await res.json();
  // Speechmatics returns { key_value: "..." }
  return NextResponse.json({ keyValue: data.key_value });
}
```

**Step 2: Test the route**

With `npm run dev` running:

```bash
curl http://localhost:3000/api/speechmatics-token
```

Expected: `{"keyValue":"eyJ..."}` (a JWT string)

**Step 3: Commit**

```bash
git add app/api/speechmatics-token/
git commit -m "feat: Speechmatics JWT token endpoint"
```

---

## Task 8: Conversation Cue Extractor — Pure Functions

**Verification:** ✅ Automated — all signal extraction tests pass

**Files:**
- Create: `lib/signals/extractor.ts`
- Create: `tests/signals/extractor.test.ts`

> Reference: `behavioral-friction-signal-research.md` — Section "Updated behavioral friction signal set"

---

**Step 1: Write failing tests first**

Create `tests/signals/extractor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractSignals } from '@/lib/signals/extractor';

const w = (text: string, startTime: number, duration = 0.3) => ({ text, startTime, duration });

describe('extractSignals', () => {
  it('counts filled pauses', () => {
    const words = [w('I', 0), w('uh', 0.5), w('um', 1.0), w('think', 1.5)];
    const result = extractSignals(words, 15);
    expect(result.filledPausePer100w).toBeGreaterThan(0);
  });

  it('counts explicit uncertainty phrases', () => {
    const words = "i don't know what to do".split(' ').map((t, i) => w(t, i * 0.5));
    const result = extractSignals(words, 15);
    expect(result.explicitUncertaintyCount).toBe(1);
  });

  it('detects long pauses from timestamp gaps', () => {
    const words = [w('okay', 0), w('so', 3.0), w('then', 3.5)]; // 2.7s gap between 'okay' and 'so'
    const result = extractSignals(words, 15);
    expect(result.longPauseCount).toBeGreaterThanOrEqual(1);
  });

  it('detects very long pauses (>=3.0s)', () => {
    const words = [w('hello', 0), w('world', 4.0)]; // 3.7s gap
    const result = extractSignals(words, 15);
    expect(result.veryLongPauseCount).toBe(1);
  });

  it('counts self-repair markers', () => {
    const words = "wait actually i mean the button".split(' ').map((t, i) => w(t, i * 0.4));
    const result = extractSignals(words, 15);
    expect(result.repairsPer100w).toBeGreaterThan(0);
  });

  it('detects repetitions within 0.3s gap', () => {
    const words = [w('click', 0, 0.2), w('click', 0.25, 0.2), w('the', 0.5, 0.2)];
    const result = extractSignals(words, 15);
    expect(result.repetitionsPer100w).toBeGreaterThan(0);
  });

  it('counts negative affect phrases', () => {
    const words = "this is so frustrating it doesn't work".split(' ').map((t, i) => w(t, i * 0.4));
    const result = extractSignals(words, 15);
    expect(result.negAffectCount).toBeGreaterThan(0);
  });

  it('flags repeat attempt loops', () => {
    const words = [w('click', 0, 0.2), w('click', 5.0, 0.2), w('click', 8.0, 0.2)];
    const result = extractSignals(words, 15);
    expect(result.repeatAttemptLoopFlag).toBe(true);
  });

  it('counts backtracking markers', () => {
    const words = "let me go back and start over".split(' ').map((t, i) => w(t, i * 0.4));
    const result = extractSignals(words, 15);
    expect(result.backtrackCount).toBeGreaterThan(0);
  });

  it('returns zero signals for empty input', () => {
    const result = extractSignals([], 15);
    expect(result.filledPausePer100w).toBe(0);
    expect(result.negAffectCount).toBe(0);
    expect(result.repeatAttemptLoopFlag).toBe(false);
  });
});
```

**Step 2: Run tests — verify they fail**

```bash
npm test -- tests/signals/extractor.test.ts
```

Expected: `FAIL — Cannot find module '@/lib/signals/extractor'`

**Step 3: Create `lib/signals/extractor.ts`**

```typescript
export interface Word {
  text: string;
  startTime: number;
  duration: number;
}

export interface SignalResult {
  filledPausePer100w: number;
  hedgesPer100w: number;
  explicitUncertaintyCount: number;
  longPauseCount: number;
  veryLongPauseCount: number;
  pauseTimeRatio: number;
  repairsPer100w: number;
  repetitionsPer100w: number;
  clarificationCount: number;
  negAffectCount: number;
  clarityIndex: number;
  backtrackCount: number;
  repeatAttemptLoopFlag: boolean;
}

const FILLED_PAUSES = new Set(["uh", "um", "er", "erm", "uhm", "umm"]);

const HEDGE_PHRASES = ["maybe", "probably", "i think", "i guess", "kind of", "sort of", "not really"];

const UNCERTAINTY_PHRASES = [
  "i don't know", "i dont know", "not sure", "no idea",
  "can't tell", "cant tell", "i'm confused", "im confused", "i don't understand", "i dont understand",
];

const REPAIR_MARKERS = ["wait", "actually", "i mean", "sorry", "let me rephrase"];

const CLARIFICATION_PHRASES = [
  "what do you mean", "huh", "can you repeat", "which one",
  "where is", "what was the task",
];

const NEG_AFFECT_PHRASES = [
  "annoying", "frustrating", "hate", "angry",
  "doesn't work", "doesnt work", "broken", "stuck", "won't let me", "wont let me",
];

const CONFIRM_WORDS = new Set([
  "got", "okay", "ok", "right", "yes", "yep", "yup", "sure",
]);

const CERTAINTY_WORDS = new Set(["definitely", "exactly", "clearly", "absolutely", "obviously"]);

const BACKTRACK_PHRASES = ["back", "go back", "undo", "cancel", "start over", "try again"];

const ACTION_VERBS = new Set(["click", "tap", "press", "submit", "open", "select", "scroll", "search", "type"]);

function countPhrase(text: string, phrases: string[]): number {
  return phrases.reduce((acc, p) => acc + (text.includes(p) ? 1 : 0), 0);
}

export function extractSignals(words: Word[], windowSec: number): SignalResult {
  if (words.length === 0) {
    return {
      filledPausePer100w: 0, hedgesPer100w: 0, explicitUncertaintyCount: 0,
      longPauseCount: 0, veryLongPauseCount: 0, pauseTimeRatio: 0,
      repairsPer100w: 0, repetitionsPer100w: 0, clarificationCount: 0,
      negAffectCount: 0, clarityIndex: 0, backtrackCount: 0,
      repeatAttemptLoopFlag: false,
    };
  }

  const tokens = words.map((w) => w.text.toLowerCase().replace(/[^a-z']/g, ""));
  const wordCount = Math.max(1, tokens.length);
  const text = tokens.join(" ");

  // 1. Filled pauses
  const filledPauseCount = tokens.filter((t) => FILLED_PAUSES.has(t)).length;
  const filledPausePer100w = (100 * filledPauseCount) / wordCount;

  // 2. Hedges
  const hedgeCount = countPhrase(text, HEDGE_PHRASES);
  const hedgesPer100w = (100 * hedgeCount) / wordCount;

  // 3. Explicit uncertainty
  const explicitUncertaintyCount = countPhrase(text, UNCERTAINTY_PHRASES);

  // 4. Silent pauses
  let longPauseCount = 0;
  let veryLongPauseCount = 0;
  let pauseTimeTotal = 0;
  for (let i = 1; i < words.length; i++) {
    const prevEnd = words[i - 1].startTime + words[i - 1].duration;
    const gap = words[i].startTime - prevEnd;
    if (gap >= 0.25) pauseTimeTotal += gap;
    if (gap >= 1.5) longPauseCount++;
    if (gap >= 3.0) veryLongPauseCount++;
  }
  const pauseTimeRatio = windowSec > 0 ? pauseTimeTotal / windowSec : 0;

  // 5. Self-repairs
  const repairCount = countPhrase(text, REPAIR_MARKERS);
  const repairsPer100w = (100 * repairCount) / wordCount;

  // 6. Repetitions / false starts (same token within 0.3s)
  let repetitionCount = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startTime - (words[i - 1].startTime + words[i - 1].duration);
    if (tokens[i] === tokens[i - 1] && gap <= 0.3) repetitionCount++;
  }
  const repetitionsPer100w = (100 * repetitionCount) / wordCount;

  // 7. Clarification initiators
  const clarificationCount = countPhrase(text, CLARIFICATION_PHRASES);

  // 9. Negative affect
  const negAffectCount = countPhrase(text, NEG_AFFECT_PHRASES);

  // 10. Clarity index
  const confirmCount = tokens.filter((t) => CONFIRM_WORDS.has(t)).length;
  const certaintyCount = tokens.filter((t) => CERTAINTY_WORDS.has(t)).length;
  const clarityIndex = confirmCount + certaintyCount - hedgeCount;

  // 11. Backtracking
  const backtrackCount = countPhrase(text, BACKTRACK_PHRASES);

  // 12. Repeat attempt loops — same action verb within 15s
  const actionTimestamps: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (ACTION_VERBS.has(tokens[i])) actionTimestamps.push(words[i].startTime);
  }
  let repeatAttemptLoopFlag = false;
  for (let i = 1; i < actionTimestamps.length; i++) {
    if (actionTimestamps[i] - actionTimestamps[0] <= 15 && actionTimestamps.length >= 2) {
      repeatAttemptLoopFlag = true;
      break;
    }
  }

  return {
    filledPausePer100w, hedgesPer100w, explicitUncertaintyCount,
    longPauseCount, veryLongPauseCount, pauseTimeRatio,
    repairsPer100w, repetitionsPer100w, clarificationCount,
    negAffectCount, clarityIndex, backtrackCount, repeatAttemptLoopFlag,
  };
}
```

**Step 4: Run tests — verify they pass**

```bash
npm test -- tests/signals/extractor.test.ts
```

Expected: all tests green.

**Step 5: Commit**

```bash
git add lib/signals/extractor.ts tests/signals/extractor.test.ts
git commit -m "feat: conversation cue extractor with 12 signals (TDD)"
```

---

## Task 9: Friction Scorer — Pure Functions

**Verification:** ✅ Automated

**Files:**
- Create: `lib/signals/scorer.ts`
- Create: `tests/signals/scorer.test.ts`

> Reference: `behavioral-friction-signal-research.md` — Section "Updated scoring approach"

---

**Step 1: Write failing tests**

Create `tests/signals/scorer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeFrictionScore, severityHint, computeSessionFriction } from '@/lib/signals/scorer';
import type { SignalResult } from '@/lib/signals/extractor';

const zeroSignals: SignalResult = {
  filledPausePer100w: 0, hedgesPer100w: 0, explicitUncertaintyCount: 0,
  longPauseCount: 0, veryLongPauseCount: 0, pauseTimeRatio: 0,
  repairsPer100w: 0, repetitionsPer100w: 0, clarificationCount: 0,
  negAffectCount: 0, clarityIndex: 3, backtrackCount: 0, repeatAttemptLoopFlag: false,
};

const highFrictionSignals: SignalResult = {
  filledPausePer100w: 8, hedgesPer100w: 10, explicitUncertaintyCount: 3,
  longPauseCount: 4, veryLongPauseCount: 2, pauseTimeRatio: 0.4,
  repairsPer100w: 5, repetitionsPer100w: 4, clarificationCount: 2,
  negAffectCount: 2, clarityIndex: -3, backtrackCount: 3, repeatAttemptLoopFlag: true,
};

describe('computeFrictionScore', () => {
  it('returns a number between 0 and 100', () => {
    const score = computeFrictionScore(zeroSignals, []);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('returns higher score for high-friction signals than zero signals', () => {
    const history = Array(5).fill(zeroSignals);
    const high = computeFrictionScore(highFrictionSignals, history);
    const low = computeFrictionScore(zeroSignals, history);
    expect(high).toBeGreaterThan(low);
  });
});

describe('severityHint', () => {
  it('returns LOW for score < 40', () => expect(severityHint(30)).toBe('LOW'));
  it('returns MED for score 40–70', () => expect(severityHint(55)).toBe('MED'));
  it('returns HIGH for score > 70', () => expect(severityHint(85)).toBe('HIGH'));
});

describe('computeSessionFriction', () => {
  it('computes weighted composite', () => {
    const scores = [60, 80, 40, 75];
    const result = computeSessionFriction(scores);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(100);
  });
});
```

**Step 2: Run — verify fail**

```bash
npm test -- tests/signals/scorer.test.ts
```

**Step 3: Create `lib/signals/scorer.ts`**

```typescript
import type { SignalResult } from './extractor';

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function robustZScore(value: number, history: number[]): number {
  if (history.length < 2) return 0;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const deviations = history.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations.length % 2 === 0
    ? (deviations[mid - 1] + deviations[mid]) / 2
    : deviations[Math.floor(deviations.length / 2)];
  return (value - median) / (mad + 0.01);
}

const WEIGHTS: Partial<Record<keyof SignalResult, number>> = {
  filledPausePer100w: 1.0,
  hedgesPer100w: 1.0,
  explicitUncertaintyCount: 1.0,
  longPauseCount: 1.0,
  veryLongPauseCount: 1.0,
  repairsPer100w: 1.0,
  repetitionsPer100w: 1.0,
  clarificationCount: 1.0,
  negAffectCount: 1.3,
  backtrackCount: 1.2,
  clarityIndex: 0.7, // inverted
};

export function computeFrictionScore(signals: SignalResult, history: SignalResult[]): number {
  let frictionRaw = 0;

  for (const [key, weight] of Object.entries(WEIGHTS) as [keyof SignalResult, number][]) {
    const currentVal = signals[key] as number;
    const hist = history.map((h) => h[key] as number);

    if (hist.length >= 2) {
      const z = robustZScore(currentVal, hist);
      frictionRaw += key === 'clarityIndex' ? weight * -z : weight * z;
    } else {
      // Early windows: crude normalization
      if (key !== 'clarityIndex') frictionRaw += weight * Math.min(currentVal / 5, 1);
      else frictionRaw += weight * Math.min(-currentVal / 5, 1);
    }
  }

  // Boolean repeat attempt loop adds fixed friction
  if (signals.repeatAttemptLoopFlag) frictionRaw += 1.2;

  return Math.round(100 * sigmoid(frictionRaw));
}

export function severityHint(score: number): 'LOW' | 'MED' | 'HIGH' {
  if (score < 40) return 'LOW';
  if (score <= 70) return 'MED';
  return 'HIGH';
}

export function computeSessionFriction(windowScores: number[]): number {
  if (windowScores.length === 0) return 0;
  const avg = windowScores.reduce((a, b) => a + b, 0) / windowScores.length;
  const peak = Math.max(...windowScores);
  const timeInHigh = (windowScores.filter((s) => s >= 75).length / windowScores.length) * 100;
  return Math.round(0.45 * avg + 0.35 * peak + 0.2 * timeInHigh);
}
```

**Step 4: Run — verify pass**

```bash
npm test -- tests/signals/scorer.test.ts
```

**Step 5: Commit**

```bash
git add lib/signals/scorer.ts tests/signals/scorer.test.ts
git commit -m "feat: friction scorer with z-score normalization and session composite (TDD)"
```

---

## Task 10: Policy A — Deterministic Decide Engine

**Verification:** ✅ Automated

**Files:**
- Create: `lib/decide/types.ts`
- Create: `lib/decide/policyA.ts`
- Create: `tests/decide/policyA.test.ts`

> Reference: `determinstic-decide-policy.md` — exact 7-step rule cascade

---

**Step 1: Create `lib/decide/types.ts`**

```typescript
export type Action = "ask_followup" | "clarify_task" | "reflect_back" | "move_to_next_task" | "wait";

export type ProbeType =
  | "expectation" | "comprehension" | "navigation"
  | "system_status" | "emotion_checkin" | "move_on" | "none";

export interface DecideInput {
  taskTimeSec: number;
  taskLabel: string;
  engagementState: {
    state: "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence";
    confidence: number;
  };
  mouseSummary: {
    inactiveSec: number;
    erraticness: number;
    repeatClicksSameRegion: number;
    scrollBursts: number;
  };
  conversationCues: {
    explicitUncertaintyCount: number;
    clarificationCount: number;
    negAffectCount: number;
    veryLongPauseCount: number;
    longPauseCount: number;
    repairsPer100w: number;
    repetitionsPer100w: number;
    hedgesPer100w: number;
    repeatAttemptLoopFlag: boolean;
    clarityIndex: number;
  };
  hardOverrides: {
    mustMoveOn: boolean;
    reason: string;
  };
}

export interface DecideOutput {
  action: Action;
  probeType: ProbeType;
  nextPrompt: string;
  rationale: string;
  confidence: number;
}
```

**Step 2: Write failing tests**

Create `tests/decide/policyA.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { runPolicyA } from '@/lib/decide/policyA';
import type { DecideInput } from '@/lib/decide/types';

const base: DecideInput = {
  taskTimeSec: 30,
  taskLabel: "Find the checkout button",
  engagementState: { state: "engaged_active", confidence: 0.8 },
  mouseSummary: { inactiveSec: 2, erraticness: 0.2, repeatClicksSameRegion: 0, scrollBursts: 0 },
  conversationCues: {
    explicitUncertaintyCount: 0, clarificationCount: 0, negAffectCount: 0,
    veryLongPauseCount: 0, longPauseCount: 0, repairsPer100w: 0,
    repetitionsPer100w: 0, hedgesPer100w: 0, repeatAttemptLoopFlag: false, clarityIndex: 2,
  },
  hardOverrides: { mustMoveOn: false, reason: "" },
};

describe('Policy A — runPolicyA', () => {
  it('Step 0: hard override forces move_to_next_task', () => {
    const result = runPolicyA({ ...base, hardOverrides: { mustMoveOn: true, reason: "timeout" } });
    expect(result.action).toBe("move_to_next_task");
    expect(result.probeType).toBe("move_on");
    expect(result.confidence).toBe(0.95);
  });

  it('Step 1: disengaged_away + inactive >= 8 → move_to_next_task', () => {
    const result = runPolicyA({
      ...base,
      engagementState: { state: "disengaged_away", confidence: 0.7 },
      mouseSummary: { ...base.mouseSummary, inactiveSec: 10 },
    });
    expect(result.action).toBe("move_to_next_task");
    expect(result.confidence).toBe(0.85);
  });

  it('Step 1: disengaged_away + inactive < 8 → reflect_back', () => {
    const result = runPolicyA({
      ...base,
      engagementState: { state: "disengaged_away", confidence: 0.7 },
      mouseSummary: { ...base.mouseSummary, inactiveSec: 3 },
    });
    expect(result.action).toBe("reflect_back");
    expect(result.probeType).toBe("emotion_checkin");
  });

  it('Step 2: neg affect → ask_followup system_status', () => {
    const result = runPolicyA({ ...base, conversationCues: { ...base.conversationCues, negAffectCount: 1 } });
    expect(result.action).toBe("ask_followup");
    expect(result.probeType).toBe("system_status");
    expect(result.confidence).toBe(0.90);
  });

  it('Step 2: repeat attempt loop → ask_followup system_status', () => {
    const result = runPolicyA({ ...base, conversationCues: { ...base.conversationCues, repeatAttemptLoopFlag: true } });
    expect(result.action).toBe("ask_followup");
    expect(result.probeType).toBe("system_status");
  });

  it('Step 3: explicit uncertainty → ask_followup comprehension', () => {
    const result = runPolicyA({ ...base, conversationCues: { ...base.conversationCues, explicitUncertaintyCount: 1 } });
    expect(result.action).toBe("ask_followup");
    expect(result.probeType).toBe("comprehension");
  });

  it('Step 4: STUCK_SCORE >= 2 → ask_followup expectation', () => {
    const result = runPolicyA({
      ...base,
      conversationCues: { ...base.conversationCues, veryLongPauseCount: 1, longPauseCount: 3 },
    });
    expect(result.action).toBe("ask_followup");
    expect(result.probeType).toBe("expectation");
  });

  it('Step 6: smooth progress → wait', () => {
    const result = runPolicyA(base); // base is all-clear
    expect(result.action).toBe("wait");
    expect(result.probeType).toBe("none");
  });
});
```

**Step 3: Run — verify fail**

```bash
npm test -- tests/decide/policyA.test.ts
```

**Step 4: Create `lib/decide/policyA.ts`**

```typescript
import type { DecideInput, DecideOutput } from './types';

export function runPolicyA(input: DecideInput): DecideOutput {
  const { taskTimeSec, taskLabel, engagementState, mouseSummary, conversationCues, hardOverrides } = input;

  // STEP 0 — Hard overrides
  if (hardOverrides.mustMoveOn) {
    return { action: "move_to_next_task", probeType: "move_on", nextPrompt: "Let's move on to the next task. No worries—what would you do next?", rationale: `Hard override: ${hardOverrides.reason}`, confidence: 0.95 };
  }

  // STEP 1 — Disengagement
  if (engagementState.state === "disengaged_away" && engagementState.confidence >= 0.65) {
    if (mouseSummary.inactiveSec >= 8) {
      return { action: "move_to_next_task", probeType: "move_on", nextPrompt: "Want to keep going, or should we move to the next task?", rationale: "disengaged_away + high mouse inactivity", confidence: 0.85 };
    }
    return { action: "reflect_back", probeType: "emotion_checkin", nextPrompt: "No rush—are you still with me? What are you looking for right now?", rationale: "disengaged_away, moderate confidence", confidence: 0.75 };
  }

  // STEP 2 — High-signal frustration / breakdown
  if (conversationCues.negAffectCount >= 1) {
    return { action: "ask_followup", probeType: "system_status", nextPrompt: "It sounds like something isn't working as expected—what did you expect to happen?", rationale: "Negative affect detected", confidence: 0.90 };
  }
  if (conversationCues.repeatAttemptLoopFlag || mouseSummary.repeatClicksSameRegion >= 2) {
    return { action: "ask_followup", probeType: "system_status", nextPrompt: "I noticed repeated attempts there—what feedback did you expect after that action?", rationale: "Repeat attempt loop or repeated clicks", confidence: 0.85 };
  }

  // STEP 3 — Explicit confusion / uncertainty
  if (conversationCues.explicitUncertaintyCount >= 1 || conversationCues.clarificationCount >= 1) {
    return { action: "ask_followup", probeType: "comprehension", nextPrompt: "What's confusing or unclear right now? What were you expecting to find?", rationale: "Explicit uncertainty or clarification request", confidence: 0.85 };
  }

  // STEP 4 — Stuck pattern (multi-signal corroboration)
  const stuckScore = [
    conversationCues.veryLongPauseCount >= 1,
    conversationCues.longPauseCount >= 2,
    conversationCues.repairsPer100w >= 3,
    conversationCues.repetitionsPer100w >= 3,
    mouseSummary.inactiveSec >= 6,
    mouseSummary.erraticness >= 0.65,
    engagementState.state === "engaged_stuck" && engagementState.confidence >= 0.60,
  ].filter(Boolean).length;

  if (stuckScore >= 2) {
    return { action: "ask_followup", probeType: "expectation", nextPrompt: "What are you trying to do right now, and what did you expect would happen?", rationale: `STUCK_SCORE=${stuckScore}`, confidence: 0.80 };
  }

  // STEP 5 — Task prompt / instruction issues (early in task)
  if (conversationCues.clarificationCount >= 1 && taskTimeSec <= 20) {
    return { action: "clarify_task", probeType: "navigation", nextPrompt: `Just to restate the task: please try to ${taskLabel}. Tell me what you're thinking as you do it.`, rationale: "Clarification requested early in task", confidence: 0.75 };
  }

  // STEP 6 — Low friction / smooth progress
  if (
    engagementState.state === "engaged_active" && engagementState.confidence >= 0.60 &&
    mouseSummary.inactiveSec < 6 &&
    conversationCues.explicitUncertaintyCount === 0 &&
    conversationCues.clarificationCount === 0 &&
    conversationCues.negAffectCount === 0 &&
    conversationCues.veryLongPauseCount === 0
  ) {
    return { action: "wait", probeType: "none", nextPrompt: "Take your time—tell me what you're thinking as you go.", rationale: "Engaged_active, low friction", confidence: 0.70 };
  }

  // STEP 7 — Default catch-all
  return { action: "ask_followup", probeType: "navigation", nextPrompt: "What would you do next, and why?", rationale: "Default fallback", confidence: 0.60 };
}
```

**Step 5: Run — verify pass**

```bash
npm test -- tests/decide/policyA.test.ts
```

**Step 6: Commit**

```bash
git add lib/decide/ tests/decide/
git commit -m "feat: Policy A deterministic decide engine (TDD, 7-step rule cascade)"
```

---

## Task 11: Convex Signal + Mouse Storage Actions

**Verification:** 🧪 Manual — after wiring into interview room, verify `signalWindows` and `mouseWindows` rows appear in Convex dashboard during a session

**Files:**
- Create: `convex/signals.ts`
- Create: `convex/mouse.ts`
- Create: `convex/engagements.ts`

---

**Step 1: Create `convex/signals.ts`**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const addWindow = mutation({
  args: {
    sessionId: v.id("sessions"),
    tStart: v.number(),
    tEnd: v.number(),
    taskId: v.optional(v.string()),
    promptType: v.optional(v.union(
      v.literal("moderator_question"), v.literal("user_action"),
      v.literal("system_error"), v.literal("free_explore"),
    )),
    contextHint: v.optional(v.string()),
    computedSignals: v.object({
      filledPausePer100w: v.number(), hedgesPer100w: v.number(),
      explicitUncertaintyCount: v.number(), longPauseCount: v.number(),
      veryLongPauseCount: v.number(), pauseTimeRatio: v.number(),
      repairsPer100w: v.number(), repetitionsPer100w: v.number(),
      clarificationCount: v.number(), negAffectCount: v.number(),
      clarityIndex: v.number(), backtrackCount: v.number(),
      repeatAttemptLoopFlag: v.boolean(),
    }),
    friction0to100: v.number(),
    severityHint: v.union(v.literal("LOW"), v.literal("MED"), v.literal("HIGH")),
    flags: v.array(v.string()),
  },
  handler: async (ctx, args) => ctx.db.insert("signalWindows", args),
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) =>
    ctx.db.query("signalWindows").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect(),
});
```

**Step 2: Create `convex/mouse.ts`**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const addWindow = mutation({
  args: {
    sessionId: v.id("sessions"),
    tStart: v.number(),
    tEnd: v.number(),
    taskId: v.optional(v.string()),
    summary: v.object({
      inactiveSec: v.number(),
      erraticness: v.number(),
      repeatClicksSameRegion: v.number(),
      scrollBursts: v.number(),
    }),
    heatmapBins: v.optional(v.array(v.object({ x: v.number(), y: v.number(), count: v.number() }))),
  },
  handler: async (ctx, args) => ctx.db.insert("mouseWindows", args),
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) =>
    ctx.db.query("mouseWindows").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect(),
});
```

**Step 3: Create `convex/engagements.ts`**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const addEvent = mutation({
  args: {
    sessionId: v.id("sessions"),
    taskId: v.optional(v.string()),
    t: v.number(),
    state: v.union(
      v.literal("engaged_active"), v.literal("engaged_stuck"),
      v.literal("disengaged_away"), v.literal("uncertain_low_confidence"),
    ),
    confidence: v.number(),
    signals: v.object({
      facePresent: v.boolean(),
      gazeTowardScreenLikely: v.boolean(),
      attentionStableLikely: v.boolean(),
      visibleFrustrationCuesLikely: v.boolean(),
    }),
    notes: v.string(),
    frameHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => ctx.db.insert("engagementEvents", args),
});

export const getLatest = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("engagementEvents")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(1);
    return events[0] ?? null;
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) =>
    ctx.db.query("engagementEvents").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect(),
});
```

**Step 4: Commit**

```bash
git add convex/signals.ts convex/mouse.ts convex/engagements.ts
git commit -m "feat: Convex signal window, mouse window, and engagement event mutations"
```

---

## Task 12: Speechmatics Realtime Hook

**Verification:** 🧪 Manual — open interview room, grant mic, verify transcript words appear in the panel and `transcriptSegments` rows accumulate in Convex dashboard

**Files:**
- Create: `hooks/useSpeechmatics.ts`

---

**Step 1: Create `hooks/useSpeechmatics.ts`**

```typescript
"use client";
import { useRef, useCallback, useState } from "react";

interface Word { text: string; startTime: number; duration: number; }
interface TranscriptEvent { text: string; words: Word[]; startTime: number; endTime: number; isFinal: boolean; }

export function useSpeechmatics(onTranscript: (event: TranscriptEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    try {
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
          const words: Word[] = msg.results.map((r: { alternatives: { content: string }[]; start_time: number; duration: number }) => ({
            text: r.alternatives[0]?.content ?? "",
            startTime: r.start_time,
            duration: r.duration,
          })).filter((w: Word) => w.text.trim());
          if (words.length === 0) return;
          onTranscript({
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
  }, [onTranscript]);

  const startAudio = async (ws: WebSocket) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  };

  const stop = useCallback(() => {
    workletRef.current?.disconnect();
    contextRef.current?.close();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ message: "EndOfStream", last_seq_no: 0 }));
      wsRef.current.close();
    }
    setIsConnected(false);
  }, []);

  return { start, stop, isConnected, error };
}
```

**Step 2: Wire into interview room `app/interview/[sessionId]/page.tsx`**

Add these imports and hooks at the top of the component (inside the function body):

```typescript
import { useSpeechmatics } from "@/hooks/useSpeechmatics";
import { useMutation } from "convex/react";

// Inside InterviewPage:
const addSegment = useMutation(api.transcripts.addSegment);

const handleTranscript = useCallback(async (event: { text: string; words: { text: string; startTime: number; duration: number }[]; startTime: number; endTime: number }) => {
  if (!data?.session) return;
  await addSegment({
    sessionId,
    speakerId: "participant",
    text: event.text,
    words: event.words,
    startTime: event.startTime,
    endTime: event.endTime,
    taskId: data.study?.tasks[data.session.currentTaskIndex]?.id,
  });
}, [sessionId, addSegment, data]);

const { start: startSpeechmatics, stop: stopSpeechmatics, isConnected } = useSpeechmatics(handleTranscript);

// Auto-start on mount:
useEffect(() => {
  startSpeechmatics();
  return () => stopSpeechmatics();
}, [startSpeechmatics, stopSpeechmatics]);
```

**Step 3: Commit**

```bash
git add hooks/useSpeechmatics.ts app/interview/
git commit -m "feat: Speechmatics realtime transcription hook with AudioWorklet"
```

---

## Task 13: Mouse Tracker Hook

**Verification:** ✅ Automated (mouse_summary computation) + 🧪 Manual (verify mouseWindows rows in Convex)

**Files:**
- Create: `lib/mouse/tracker.ts`
- Create: `tests/mouse/tracker.test.ts`
- Create: `hooks/useMouseTracker.ts`

---

**Step 1: Write failing tests**

Create `tests/mouse/tracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeMouseSummary, buildHeatmapBins } from '@/lib/mouse/tracker';

type MouseEv = { type: "move" | "click" | "scroll"; x?: number; y?: number; button?: string; delta?: number; t: number };

describe('computeMouseSummary', () => {
  it('detects inactivity when no events', () => {
    const result = computeMouseSummary([], 15000, 15000);
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
```

**Step 2: Create `lib/mouse/tracker.ts`**

```typescript
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
```

**Step 3: Run tests**

```bash
npm test -- tests/mouse/tracker.test.ts
```

Expected: all pass.

**Step 4: Create `hooks/useMouseTracker.ts`**

```typescript
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
    return { summary, heatmapBins, eventCount: windowEvents.length };
  }, []);

  const clear = useCallback(() => { eventsRef.current = []; }, []);

  return { recordEvent, flushWindow, clear };
}
```

**Step 5: Wire into interview room `app/interview/[sessionId]/page.tsx`**

```typescript
import { useMouseTracker } from "@/hooks/useMouseTracker";
// Inside InterviewPage:
const { recordEvent: recordMouseEvent, flushWindow: flushMouseWindow } = useMouseTracker();
// Pass recordMouseEvent to PrototypeFrame's onMouseEvent prop (already wired in Task 6)
```

**Step 6: Commit**

```bash
git add lib/mouse/ hooks/useMouseTracker.ts tests/mouse/
git commit -m "feat: mouse tracker with erraticness, repeat-click detection, heatmap bins (TDD)"
```

---

## Task 14: Camera Capture Hook + MiniMax Engagement Classifier

**Verification:** 🧪 Manual — grant camera permission, verify `engagementEvents` rows appear in Convex dashboard every ~4 seconds during a session

**Files:**
- Create: `hooks/useCamera.ts`
- Create: `convex/classifyEngagement.ts`

> Reference: `camera-engagement-classifier.md` — full system prompt and JSON schema

---

**Step 1: Create `convex/classifyEngagement.ts`** (Convex action calling MiniMax Vision via MiniMax API directly)

```typescript
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import OpenAI from "openai";

const SYSTEM_PROMPT = `You are an assistant that classifies user engagement state from a low-resolution webcam frame during a UX test.
You must be conservative: if unsure, output low confidence.
You must not infer sensitive attributes (age, race, health, etc.) or identity. Do not guess demographics.
You must not output medical/psychological claims. Only "engagement cues" relevant to usability testing.
Return ONLY valid JSON that matches the schema below. No extra keys, no markdown.

JSON_SCHEMA:
{
  "state": "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence",
  "confidence": number,
  "signals": {
    "face_present": boolean,
    "gaze_toward_screen_likely": boolean,
    "attention_stable_likely": boolean,
    "visible_frustration_cues_likely": boolean
  },
  "notes": string
}`;

export const classifyEngagement = action({
  args: {
    sessionId: v.id("sessions"),
    taskId: v.optional(v.string()),
    frameBase64: v.string(),
    recentTranscriptSnippet: v.optional(v.string()),
    taskLabel: v.optional(v.string()),
    taskTimeSec: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const client = new OpenAI({
      baseURL: "https://api.minimax.chat/v1",
      apiKey: process.env.MINIMAX_API_KEY!,
    });

    const userContent: OpenAI.ChatCompletionContentPart[] = [
      {
        type: "text",
        text: [
          `Context:`,
          `- Study: "Unfiltered" AI UX interview`,
          `- Current task: ${args.taskLabel ?? "unknown"}`,
          `- Time in task (sec): ${args.taskTimeSec ?? 0}`,
          args.recentTranscriptSnippet ? `- Recent transcript: "${args.recentTranscriptSnippet}"` : "",
          `\nAnalyze the provided webcam frame and classify engagement state. Output JSON only.`,
        ].filter(Boolean).join("\n"),
      },
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${args.frameBase64}` },
      },
    ];

    let parsed: { state: string; confidence: number; signals: { face_present: boolean; gaze_toward_screen_likely: boolean; attention_stable_likely: boolean; visible_frustration_cues_likely: boolean }; notes: string };

    try {
      const response = await client.chat.completions.create({
        // Verify model name at https://api.minimax.chat — check available vision models
        model: "MiniMax-VL-01",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        max_tokens: 256,
      });
      parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    } catch {
      // On any API or parse failure, store uncertain result rather than crashing session
      parsed = {
        state: "uncertain_low_confidence",
        confidence: 0,
        signals: { face_present: false, gaze_toward_screen_likely: false, attention_stable_likely: false, visible_frustration_cues_likely: false },
        notes: "Classification failed",
      };
    }

    const validStates = ["engaged_active", "engaged_stuck", "disengaged_away", "uncertain_low_confidence"];
    const state = validStates.includes(parsed.state) ? parsed.state : "uncertain_low_confidence";

    await ctx.runMutation(api.engagements.addEvent, {
      sessionId: args.sessionId,
      taskId: args.taskId,
      t: Date.now(),
      state: state as "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      signals: {
        facePresent: parsed.signals?.face_present ?? false,
        gazeTowardScreenLikely: parsed.signals?.gaze_toward_screen_likely ?? false,
        attentionStableLikely: parsed.signals?.attention_stable_likely ?? false,
        visibleFrustrationCuesLikely: parsed.signals?.visible_frustration_cues_likely ?? false,
      },
      notes: (parsed.notes ?? "").slice(0, 160),
    });
  },
});
```

**Step 2: Create `hooks/useCamera.ts`**

```typescript
"use client";
import { useRef, useCallback, useState } from "react";
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
      taskStartRef.current = Date.now();

      intervalRef.current = setInterval(async () => {
        const frame = captureFrame();
        if (!frame) return;
        await classifyEngagement({
          sessionId,
          taskId,
          frameBase64: frame,
          recentTranscriptSnippet: recentTranscript?.slice(-200),
          taskLabel,
          taskTimeSec: Math.round((Date.now() - taskStartRef.current) / 1000),
        });
      }, FRAME_INTERVAL_MS);
    } catch {
      // Camera permission denied or unavailable — silently skip (camera is optional)
      setCameraActive(false);
    }
  }, [sessionId, taskId, taskLabel, recentTranscript, captureFrame, classifyEngagement]);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const stream = (videoRef.current?.srcObject as MediaStream);
    stream?.getTracks().forEach(t => t.stop());
    setCameraActive(false);
  }, []);

  return { start, stop, cameraActive };
}
```

**Step 3: Wire into interview room**

Add to `app/interview/[sessionId]/page.tsx`:

```typescript
import { useCamera } from "@/hooks/useCamera";

// Inside InterviewPage, after existing hooks:
const recentTranscript = (segments ?? []).slice(-3).map(s => s.text).join(" ");
const currentTaskLabel = data?.study?.tasks[data?.session?.currentTaskIndex ?? 0]?.label;
const { start: startCamera, stop: stopCamera } = useCamera(
  sessionId,
  data?.study?.tasks[data?.session?.currentTaskIndex ?? 0]?.id,
  currentTaskLabel,
  recentTranscript,
);

// Start camera on mount (only if user gave consent — pass a prop from consent page via URL param or sessionStorage):
useEffect(() => {
  const cameraConsented = sessionStorage.getItem("cameraConsent") === "true";
  if (cameraConsented) startCamera();
  return () => stopCamera();
}, [startCamera, stopCamera]);
```

In `app/join/[studyId]/page.tsx`, before redirecting:
```typescript
sessionStorage.setItem("cameraConsent", String(cameraConsent));
```

**Step 4: Commit**

```bash
git add convex/classifyEngagement.ts hooks/useCamera.ts app/interview/ app/join/
git commit -m "feat: camera capture hook and MiniMax engagement classifier via MiniMax API"
```

---

## Task 15: Signal Window Processor (Client Orchestrator)

**Verification:** 🧪 Manual — verify `signalWindows` rows appear every ~5 seconds during a session; check `friction0to100` values in Convex dashboard

**Files:**
- Create: `hooks/useSignalProcessor.ts`

---

**Step 1: Create `hooks/useSignalProcessor.ts`**

This hook runs every 5 seconds, extracts the last 15 seconds of transcript from local buffers, computes signals and friction score, then stores the result as a `SignalWindow`.

```typescript
"use client";
import { useRef, useCallback, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { extractSignals } from "@/lib/signals/extractor";
import { computeFrictionScore, severityHint } from "@/lib/signals/scorer";
import type { SignalResult } from "@/lib/signals/extractor";
import type { MouseEvent as MouseEv } from "@/lib/mouse/tracker";

const WINDOW_SEC = 15;
const STRIDE_SEC = 5;

interface Word { text: string; startTime: number; duration: number; }

interface Props {
  sessionId: Id<"sessions">;
  taskId?: string;
  getWords: () => { words: Word[]; sessionOffsetSec: number }; // returns all buffered participant words + current session time
  getMouseFlush: (startMs: number, endMs: number) => { summary: { inactiveSec: number; erraticness: number; repeatClicksSameRegion: number; scrollBursts: number }; heatmapBins: { x: number; y: number; count: number }[] };
  onWindow: (friction0to100: number, signals: SignalResult) => void; // callback for decide engine
}

export function useSignalProcessor({ sessionId, taskId, getWords, getMouseFlush, onWindow }: Props) {
  const addSignalWindow = useMutation(api.signals.addWindow);
  const addMouseWindow = useMutation(api.mouse.addWindow);
  const historyRef = useRef<SignalResult[]>([]);
  const sessionStartRef = useRef<number>(Date.now());

  const processWindow = useCallback(async () => {
    const { words, sessionOffsetSec } = getWords();
    const windowEnd = sessionOffsetSec;
    const windowStart = Math.max(0, windowEnd - WINDOW_SEC);
    const tNow = Date.now();

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
    const { summary: mouseSummary, heatmapBins } = getMouseFlush(tNow - WINDOW_SEC * 1000, tNow);
    await addMouseWindow({ sessionId, tStart: tNow - WINDOW_SEC * 1000, tEnd: tNow, taskId, summary: mouseSummary, heatmapBins });

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

    onWindow(score, signals);
  }, [sessionId, taskId, getWords, getMouseFlush, addSignalWindow, addMouseWindow, onWindow]);

  useEffect(() => {
    sessionStartRef.current = Date.now();
    const interval = setInterval(processWindow, STRIDE_SEC * 1000);
    return () => clearInterval(interval);
  }, [processWindow]);
}
```

**Step 2: Wire into interview room**

The interview room page needs to maintain a transcript word buffer and pass a `getWords` accessor into `useSignalProcessor`. Add to `app/interview/[sessionId]/page.tsx`:

```typescript
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useMouseTracker } from "@/hooks/useMouseTracker";

// Inside InterviewPage:
const wordBufferRef = useRef<{ text: string; startTime: number; duration: number }[]>([]);
const sessionStartRef = useRef<number>(Date.now());

// In handleTranscript callback, also push to local buffer:
// wordBufferRef.current.push(...event.words);

const { recordEvent: recordMouseEvent, flushWindow: flushMouseWindow } = useMouseTracker();

const [latestFriction, setLatestFriction] = useState(0);
const [latestSignals, setLatestSignals] = useState<SignalResult | null>(null);

const currentTaskId = data?.study?.tasks[data?.session?.currentTaskIndex ?? 0]?.id;

useSignalProcessor({
  sessionId,
  taskId: currentTaskId,
  getWords: () => ({
    words: wordBufferRef.current,
    sessionOffsetSec: (Date.now() - sessionStartRef.current) / 1000,
  }),
  getMouseFlush: flushMouseWindow,
  onWindow: (score, signals) => {
    setLatestFriction(score);
    setLatestSignals(signals);
  },
});
```

**Step 3: Commit**

```bash
git add hooks/useSignalProcessor.ts app/interview/
git commit -m "feat: 15s sliding signal window processor with stride-5s Convex storage"
```

---

## Task 16: Policy B — GLM-5 LLM Decide Engine

**Verification:** 🧪 Manual — run a session with Mode B, verify `decideEvents` rows appear with `policyUsed: "llm"` and valid JSON fields

**Files:**
- Create: `convex/decide.ts`

> Reference: `decide-engine-policy-b-prompt.md` — exact prompt template and JSON schema

---

**Step 1: Create `convex/decide.ts`**

```typescript
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import OpenAI from "openai";

const SYSTEM_PROMPT = `You are the "Unfiltered" interviewer policy module.
You must choose the next interviewer action using only the ALLOWED_ACTIONS.
You must be helpful, non-leading, and neutral. Do not shame the participant.
You must not ask for personal/sensitive information.
You must keep prompts short, plain-language, and task-oriented.
If the participant seems disengaged, offer an easy out or move on.
Return ONLY valid JSON with the exact keys in the schema. No extra keys, no markdown.

CRITICAL:
- Do NOT invent UI details that are not provided in context.
- Do NOT claim certainty about emotions. Treat engagement as an approximate cue.
- Prefer follow-ups that elicit expectations: "What did you expect would happen?"

JSON_SCHEMA:
{
  "action": "ask_followup" | "clarify_task" | "reflect_back" | "move_to_next_task" | "wait",
  "next_prompt": string,
  "rationale": string,
  "probe_type": "expectation" | "comprehension" | "navigation" | "system_status" | "emotion_checkin" | "move_on" | "none",
  "confidence": number
}`;

const ALLOWED_ACTIONS = ["ask_followup", "clarify_task", "reflect_back", "move_to_next_task", "wait"];

export const runPolicyB = action({
  args: {
    sessionId: v.id("sessions"),
    prototypeUrl: v.string(),
    taskList: v.array(v.object({ id: v.string(), label: v.string() })),
    currentTask: v.object({ id: v.string(), label: v.string() }),
    taskTimeSec: v.number(),
    conversationCues: v.any(),
    engagementState: v.any(),
    mouseSummary: v.any(),
    lastInterviewerPrompt: v.string(),
    lastParticipantUtterance: v.string(),
    transcriptTail: v.string(),
    hardOverrides: v.object({ mustMoveOn: v.boolean(), reason: v.string() }),
  },
  handler: async (ctx, args) => {
    const client = new OpenAI({
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKey: process.env.FIREWORKS_API_KEY!,
    });

    const userMessage = `You are running a live UX test. Decide the NEXT action and prompt.

STUDY_CONTEXT:
- prototype_url: ${args.prototypeUrl}
- task_list: ${JSON.stringify(args.taskList)}
- current_task: ${JSON.stringify(args.currentTask)}
- task_time_sec: ${args.taskTimeSec}
- policy_mode: "bounded_llm"

REALTIME_SIGNALS (most recent window):
- conversation_cues: ${JSON.stringify(args.conversationCues)}
- engagement_state: ${JSON.stringify(args.engagementState)}
- mouse_summary: ${JSON.stringify(args.mouseSummary)}

TRANSCRIPT_CONTEXT:
- last_interviewer_prompt: "${args.lastInterviewerPrompt}"
- last_participant_utterance: "${args.lastParticipantUtterance}"
- transcript_tail: "${args.transcriptTail}"

GUARDRAILS:
- allowed_actions: ${JSON.stringify(ALLOWED_ACTIONS)}
- hard_overrides: ${JSON.stringify(args.hardOverrides)}

Output JSON only.`;

    let parsed: { action: string; next_prompt: string; rationale: string; probe_type: string; confidence: number };

    try {
      const response = await client.chat.completions.create({
        // Verify model name at https://fireworks.ai/models — search "glm"
        model: "accounts/fireworks/models/glm-5",
        max_tokens: 512,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMessage }],
        response_format: { type: "json_object" },
      });
      const text = response.choices[0].message.content ?? "{}";
      parsed = JSON.parse(text);
    } catch {
      parsed = { action: "wait", next_prompt: "Take your time—tell me what you're thinking.", rationale: "LLM call failed, defaulting to wait", probe_type: "none", confidence: 0.5 };
    }

    const validActions = ALLOWED_ACTIONS;
    const validProbes = ["expectation", "comprehension", "navigation", "system_status", "emotion_checkin", "move_on", "none"];
    const action = validActions.includes(parsed.action) ? parsed.action : "wait";
    const probeType = validProbes.includes(parsed.probe_type) ? parsed.probe_type : "none";

    await ctx.runMutation(api.decide.storeEvent, {
      sessionId: args.sessionId,
      policyUsed: "llm",
      inputSummary: JSON.stringify({ cues: args.conversationCues, engagement: args.engagementState?.state }),
      outputAction: action as "ask_followup" | "clarify_task" | "reflect_back" | "move_to_next_task" | "wait",
      outputPrompt: (parsed.next_prompt ?? "").slice(0, 220),
      probeType: probeType as "expectation" | "comprehension" | "navigation" | "system_status" | "emotion_checkin" | "move_on" | "none",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    });

    return { action, nextPrompt: (parsed.next_prompt ?? "").slice(0, 220), probeType, confidence: parsed.confidence };
  },
});

export const storeEvent = mutation({
  args: {
    sessionId: v.id("sessions"),
    policyUsed: v.union(v.literal("deterministic"), v.literal("llm")),
    inputSummary: v.string(),
    outputAction: v.union(v.literal("ask_followup"), v.literal("clarify_task"), v.literal("reflect_back"), v.literal("move_to_next_task"), v.literal("wait")),
    outputPrompt: v.string(),
    probeType: v.union(v.literal("expectation"), v.literal("comprehension"), v.literal("navigation"), v.literal("system_status"), v.literal("emotion_checkin"), v.literal("move_on"), v.literal("none")),
    confidence: v.number(),
  },
  handler: async (ctx, args) => ctx.db.insert("decideEvents", { ...args, t: Date.now() }),
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) =>
    ctx.db.query("decideEvents").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect(),
});
```

**Step 2: Commit**

```bash
git add convex/decide.ts
git commit -m "feat: Policy B GLM-5 (FireworksAI) decide engine as Convex action"
```

---

## Task 17: Decide Engine Orchestrator + AI Interviewer Voice

**Verification:** 🧪 Manual — run a session, speak the words "I'm confused" into the mic, verify the AI interviewer speaks a follow-up within ~10 seconds and a `decideEvents` row appears in Convex

**Files:**
- Create: `hooks/useDecideEngine.ts`
- Create: `lib/tts.ts`

---

**Step 1: Create `lib/tts.ts`** (Web Speech API wrapper)

```typescript
export function speak(text: string, onStart?: () => void, onEnd?: () => void): void {
  if (!("speechSynthesis" in window)) { onEnd?.(); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.pitch = 1.0;
  // Pick a non-robotic voice if available
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => v.name.includes("Samantha") || v.name.includes("Google") || v.lang === "en-US");
  if (preferred) utterance.voice = preferred;
  utterance.onstart = () => onStart?.();
  utterance.onend = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
}
```

**Step 2: Create `hooks/useDecideEngine.ts`**

```typescript
"use client";
import { useCallback, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { runPolicyA } from "@/lib/decide/policyA";
import { speak } from "@/lib/tts";
import type { SignalResult } from "@/lib/signals/extractor";

interface Props {
  sessionId: Id<"sessions">;
  decideMode: "A" | "B" | "AB";
  prototypeUrl: string;
  taskList: { id: string; label: string }[];
  currentTask: { id: string; label: string } | null;
  taskTimeSec: number;
  getLatestEngagement: () => { state: string; confidence: number } | null;
  getLatestMouseSummary: () => { inactiveSec: number; erraticness: number; repeatClicksSameRegion: number; scrollBursts: number };
  getTranscriptTail: () => string;
  onStatusChange: (status: "listening" | "thinking" | "speaking") => void;
  onTaskAdvance: () => void;
  storeDecideEvent: (event: { policyUsed: "deterministic" | "llm"; inputSummary: string; outputAction: string; outputPrompt: string; probeType: string; confidence: number }) => Promise<void>;
}

export function useDecideEngine(props: Props) {
  const runPolicyBAction = useAction(api.decide.runPolicyB);
  const isSpeakingRef = useRef(false);
  const sessionCountRef = useRef(0); // for A/B alternation

  const triggerDecide = useCallback(async (signals: SignalResult, friction0to100: number) => {
    if (isSpeakingRef.current || !props.currentTask) return;
    // Only trigger if friction is MED or HIGH, or specific high-priority signals fire
    const shouldDecide =
      friction0to100 >= 40 ||
      signals.negAffectCount >= 1 ||
      signals.explicitUncertaintyCount >= 1 ||
      signals.repeatAttemptLoopFlag;
    if (!shouldDecide) return;

    props.onStatusChange("thinking");
    const engagement = props.getLatestEngagement();
    const mouse = props.getLatestMouseSummary();

    const hardOverrides = { mustMoveOn: false, reason: "" };

    let result: { action: string; nextPrompt: string; probeType: string; confidence: number };

    // Determine effective policy (AB alternates per session)
    let effectivePolicy = props.decideMode;
    if (props.decideMode === "AB") {
      effectivePolicy = sessionCountRef.current % 2 === 0 ? "A" : "B";
    }

    if (effectivePolicy === "A") {
      const output = runPolicyA({
        taskTimeSec: props.taskTimeSec,
        taskLabel: props.currentTask.label,
        engagementState: {
          state: (engagement?.state ?? "uncertain_low_confidence") as "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence",
          confidence: engagement?.confidence ?? 0,
        },
        mouseSummary: mouse,
        conversationCues: {
          explicitUncertaintyCount: signals.explicitUncertaintyCount,
          clarificationCount: signals.clarificationCount,
          negAffectCount: signals.negAffectCount,
          veryLongPauseCount: signals.veryLongPauseCount,
          longPauseCount: signals.longPauseCount,
          repairsPer100w: signals.repairsPer100w,
          repetitionsPer100w: signals.repetitionsPer100w,
          hedgesPer100w: signals.hedgesPer100w,
          repeatAttemptLoopFlag: signals.repeatAttemptLoopFlag,
          clarityIndex: signals.clarityIndex,
        },
        hardOverrides,
      });
      result = { action: output.action, nextPrompt: output.nextPrompt, probeType: output.probeType, confidence: output.confidence };

      await props.storeDecideEvent({
        policyUsed: "deterministic",
        inputSummary: JSON.stringify({ friction0to100, signals: { negAffectCount: signals.negAffectCount } }),
        outputAction: output.action,
        outputPrompt: output.nextPrompt,
        probeType: output.probeType,
        confidence: output.confidence,
      });
    } else {
      // Policy B — Convex action
      const raw = await runPolicyBAction({
        sessionId: props.sessionId,
        prototypeUrl: props.prototypeUrl,
        taskList: props.taskList,
        currentTask: props.currentTask,
        taskTimeSec: props.taskTimeSec,
        conversationCues: signals,
        engagementState: engagement ?? { state: "uncertain_low_confidence", confidence: 0 },
        mouseSummary: mouse,
        lastInterviewerPrompt: "",
        lastParticipantUtterance: props.getTranscriptTail().slice(-200),
        transcriptTail: props.getTranscriptTail().slice(-500),
        hardOverrides,
      });
      result = raw as { action: string; nextPrompt: string; probeType: string; confidence: number };
    }

    if (result.action === "move_to_next_task") {
      props.onTaskAdvance();
    }

    if (result.action !== "wait") {
      props.onStatusChange("speaking");
      isSpeakingRef.current = true;
      speak(result.nextPrompt, undefined, () => {
        isSpeakingRef.current = false;
        props.onStatusChange("listening");
      });
    } else {
      props.onStatusChange("listening");
    }
  }, [props, runPolicyBAction]);

  return { triggerDecide };
}
```

**Step 3: Wire into interview room**

In `app/interview/[sessionId]/page.tsx`, add the decide engine and connect it to `onWindow` from `useSignalProcessor`:

```typescript
import { useDecideEngine } from "@/hooks/useDecideEngine";
import { useMutation } from "convex/react";

// Inside InterviewPage:
const storeDecideEvent = useMutation(api.decide.storeEvent);
const latestEngagementRef = useRef<{ state: string; confidence: number } | null>(null);
const latestMouseRef = useRef({ inactiveSec: 0, erraticness: 0, repeatClicksSameRegion: 0, scrollBursts: 0 });

const { triggerDecide } = useDecideEngine({
  sessionId,
  decideMode: data?.study?.decideMode ?? "B",
  prototypeUrl: data?.study?.prototypeUrl ?? "",
  taskList: data?.study?.tasks ?? [],
  currentTask: data?.study?.tasks[data?.session?.currentTaskIndex ?? 0] ?? null,
  taskTimeSec: Math.round((Date.now() - sessionStartRef.current) / 1000),
  getLatestEngagement: () => latestEngagementRef.current,
  getLatestMouseSummary: () => latestMouseRef.current,
  getTranscriptTail: () => (segments ?? []).slice(-5).map(s => s.text).join(" "),
  onStatusChange: setInterviewerStatus,
  onTaskAdvance: handleEndTurn,
  storeDecideEvent: async (event) => { await storeDecideEvent({ sessionId, t: Date.now(), ...event as any }); },
});

// Pass triggerDecide as the onWindow callback in useSignalProcessor
```

**Step 4: Speak the opening prompt on session start**

Add to interview room `useEffect` (after Speechmatics start):

```typescript
useEffect(() => {
  if (!data?.study) return;
  const task = data.study.tasks[0];
  if (!task) return;
  const intro = `Hi! I'm your AI interviewer. Let's get started. Your first task is: ${task.label}. Please think out loud as you work through it. Take your time.`;
  setInterviewerStatus("speaking");
  speak(intro, undefined, () => setInterviewerStatus("listening"));
}, [data?.study?.tasks[0]?.label]); // fire once when task label loads
```

**Step 5: Commit**

```bash
git add hooks/useDecideEngine.ts lib/tts.ts app/interview/
git commit -m "feat: decide engine orchestrator + Web Speech API AI interviewer voice"
```

---

## Task 18: Session End + Friction Moment Detection

**Verification:** ✅ Automated (clustering logic) + 🧪 Manual (verify `frictionMoments` rows appear in Convex after ending a session)

**Files:**
- Create: `lib/friction/detector.ts`
- Create: `tests/friction/detector.test.ts`
- Create: `convex/friction.ts`

---

**Step 1: Write failing tests**

Create `tests/friction/detector.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { clusterFrictionWindows } from '@/lib/friction/detector';

describe('clusterFrictionWindows', () => {
  const mkWindow = (tStart: number, tEnd: number, score: number, taskId = "t1") => ({
    tStart, tEnd, friction0to100: score, taskId,
    severityHint: score >= 70 ? "HIGH" : score >= 40 ? "MED" : "LOW",
    computedSignals: {
      negAffectCount: 0, explicitUncertaintyCount: 0, clarificationCount: 0,
      veryLongPauseCount: 0, longPauseCount: 0, repairsPer100w: 0,
      repetitionsPer100w: 0, hedgesPer100w: 0, filledPausePer100w: 0,
      backtrackCount: 0, pauseTimeRatio: 0, clarityIndex: 0, repeatAttemptLoopFlag: false,
    },
    flags: [],
  });

  it('clusters adjacent high-friction windows into a single moment', () => {
    const windows = [
      mkWindow(0, 15, 75),
      mkWindow(5, 20, 80),
      mkWindow(10, 25, 72),
    ];
    const moments = clusterFrictionWindows(windows, 40);
    expect(moments).toHaveLength(1);
    expect(moments[0].frictionPeak).toBe(80);
  });

  it('produces separate moments for non-adjacent high-friction windows', () => {
    const windows = [
      mkWindow(0, 15, 80),
      mkWindow(60, 75, 78), // gap > 30s
    ];
    const moments = clusterFrictionWindows(windows, 40);
    expect(moments).toHaveLength(2);
  });

  it('ignores low-friction windows', () => {
    const windows = [mkWindow(0, 15, 25), mkWindow(5, 20, 30)];
    const moments = clusterFrictionWindows(windows, 40);
    expect(moments).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(clusterFrictionWindows([], 40)).toHaveLength(0);
  });
});
```

**Step 2: Run — verify fail**

```bash
npm test -- tests/friction/detector.test.ts
```

**Step 3: Create `lib/friction/detector.ts`**

```typescript
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
```

**Step 4: Run — verify pass**

```bash
npm test -- tests/friction/detector.test.ts
```

**Step 5: Create `convex/friction.ts`**

```typescript
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { clusterFrictionWindows } from "../lib/friction/detector";

export const detectAndStore = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    // Load all signal windows for this session
    const windows = await ctx.runQuery(api.signals.listBySession, { sessionId: args.sessionId });
    const transcripts = await ctx.runQuery(api.transcripts.listBySession, { sessionId: args.sessionId });
    const engagements = await ctx.runQuery(api.engagements.listBySession, { sessionId: args.sessionId });
    const mouseWindows = await ctx.runQuery(api.mouse.listBySession, { sessionId: args.sessionId });

    const clusters = clusterFrictionWindows(windows, 40);

    for (const cluster of clusters) {
      // Extract transcript snippets that fall within this cluster
      const relevantSegments = transcripts
        .filter((s) => s.speakerId === "participant" && s.startTime >= cluster.tStart && s.startTime <= cluster.tEnd)
        .map((s) => s.text)
        .slice(0, 3);

      // Extract pause spans from words
      const allWords = transcripts
        .filter((s) => s.speakerId === "participant" && s.startTime >= cluster.tStart)
        .flatMap((s) => s.words);
      const pauseSpans: { start: number; end: number }[] = [];
      for (let i = 1; i < allWords.length; i++) {
        const prevEnd = allWords[i - 1].startTime + allWords[i - 1].duration;
        const gap = allWords[i].startTime - prevEnd;
        if (gap >= 1.5) pauseSpans.push({ start: prevEnd, end: allWords[i].startTime });
      }

      // Find nearest engagement snapshot
      const nearestEngagement = engagements
        .filter((e) => e.t >= cluster.tStart * 1000 && e.t <= cluster.tEnd * 1000)
        .sort((a, b) => b.confidence - a.confidence)[0];

      // Find nearest mouse window
      const nearestMouse = mouseWindows
        .find((m) => m.tStart <= cluster.tEnd * 1000 && m.tEnd >= cluster.tStart * 1000);

      await ctx.runMutation(api.friction.storeMoment, {
        sessionId: args.sessionId,
        taskId: cluster.taskId,
        tStart: cluster.tStart,
        tEnd: cluster.tEnd,
        frictionPeak: cluster.frictionPeak,
        evidence: {
          transcriptSnippets: relevantSegments,
          pauseSpans: pauseSpans.slice(0, 5),
          matchedPhrases: [],
        },
        signalTags: cluster.signalTags,
        engagementSnapshot: nearestEngagement ? { state: nearestEngagement.state, confidence: nearestEngagement.confidence } : undefined,
        mouseSnapshot: nearestMouse ? nearestMouse.summary : undefined,
      });
    }

    return { momentsCreated: clusters.length };
  },
});

export const storeMoment = mutation({
  args: {
    sessionId: v.id("sessions"),
    taskId: v.string(),
    tStart: v.number(),
    tEnd: v.number(),
    frictionPeak: v.number(),
    evidence: v.object({
      transcriptSnippets: v.array(v.string()),
      pauseSpans: v.array(v.object({ start: v.number(), end: v.number() })),
      matchedPhrases: v.array(v.string()),
    }),
    signalTags: v.array(v.string()),
    engagementSnapshot: v.optional(v.object({ state: v.string(), confidence: v.number() })),
    mouseSnapshot: v.optional(v.object({
      inactiveSec: v.number(), erraticness: v.number(),
      repeatClicksSameRegion: v.number(), scrollBursts: v.number(),
    })),
  },
  handler: async (ctx, args) => ctx.db.insert("frictionMoments", args),
});

export const patchLabel = mutation({
  args: {
    momentId: v.id("frictionMoments"),
    candidateFindingLabel: v.string(),
    category: v.union(
      v.literal("copy_language"), v.literal("discoverability"), v.literal("system_status_feedback"),
      v.literal("navigation_ia"), v.literal("form_field_friction"), v.literal("task_prompt_issue"),
      v.literal("error_recovery"), v.literal("other"),
    ),
    interpretation: v.string(),
    recommendations: v.array(v.string()),
    verificationQuestion: v.string(),
    labelConfidence: v.number(),
  },
  handler: async (ctx, args) => {
    const { momentId, ...fields } = args;
    await ctx.db.patch(momentId, fields);
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) =>
    ctx.db.query("frictionMoments").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect(),
});
```

**Step 6: Trigger from session end**

In `app/interview/[sessionId]/page.tsx`, update `handleEndTurn` to detect friction after last task:

```typescript
import { useAction } from "convex/react";
// Inside component:
const detectFriction = useAction(api.friction.detectAndStore);

const handleEndTurn = useCallback(async () => {
  if (!data?.session || !data.study) return;
  const nextIndex = data.session.currentTaskIndex + 1;
  if (nextIndex >= data.study.tasks.length) {
    await endSession({ sessionId });
    await detectFriction({ sessionId }); // kick off post-session pipeline
    router.push(`/dashboard/${sessionId}`);
  } else {
    await advanceTask({ sessionId });
  }
}, [data, sessionId, advanceTask, endSession, detectFriction, router]);
```

**Step 7: Commit**

```bash
git add lib/friction/ tests/friction/ convex/friction.ts app/interview/
git commit -m "feat: friction moment detection with sliding-window clustering (TDD)"
```

---

## Task 19: Post-Session Finding Labeler

**Verification:** 🧪 Manual — after session end, verify each `frictionMoments` row in Convex gets `candidateFindingLabel`, `category`, `recommendations` patched by GLM-5

**Files:**
- Create: `convex/findings.ts`

> Reference: `post-session-candidate-finding-labeler.md` — exact system prompt and JSON schema

---

**Step 1: Create `convex/findings.ts`**

```typescript
import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { api } from "./_generated/api";
import OpenAI from "openai";

const LABELER_SYSTEM = `You are a UX research synthesis assistant for "Unfiltered."
You convert a single friction moment (timestamped evidence) into a candidate UX finding label and recommendation.
You must be conservative, evidence-first, and avoid overclaiming.
Do not assume the UI; only use what is in the evidence.
Return ONLY valid JSON matching the schema below. No extra keys, no markdown.

IMPORTANT:
- Provide recommendations as hypotheses to test.
- If evidence points to script/task wording rather than product, say so.
- If uncertainty is high, mark low confidence and request verification.

JSON_SCHEMA:
{
  "candidate_finding_label": string,
  "category": "copy_language" | "discoverability" | "system_status_feedback" | "navigation_ia" | "form_field_friction" | "task_prompt_issue" | "error_recovery" | "other",
  "evidence": {
    "timestamp_range": {"start_sec": number, "end_sec": number},
    "quotes": string[],
    "signal_tags": string[],
    "metrics": object
  },
  "interpretation": string,
  "recommendations": string[],
  "verification_question": string,
  "confidence": number
}`;

const VALID_CATEGORIES = ["copy_language", "discoverability", "system_status_feedback", "navigation_ia", "form_field_friction", "task_prompt_issue", "error_recovery", "other"];

export const labelAllMoments = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const moments = await ctx.runQuery(api.friction.listBySession, { sessionId: args.sessionId });
    const session = await ctx.runQuery(api.sessions.get, { sessionId: args.sessionId });
    if (!session) return;
    const study = await ctx.runQuery(api.studies.get, { studyId: session.studyId });
    const client = new OpenAI({
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKey: process.env.FIREWORKS_API_KEY!,
    });

    for (const moment of moments) {
      const task = study?.tasks.find((t) => t.id === moment.taskId) ?? { id: moment.taskId, label: "Unknown task" };

      const userMessage = `Generate a candidate UX finding for this friction moment.

MOMENT:
- task: ${JSON.stringify(task)}
- timestamp_range_sec: {"start": ${moment.tStart}, "end": ${moment.tEnd}}
- transcript_snippets: ${JSON.stringify(moment.evidence.transcriptSnippets)}
- conversation_signal_summary: ${JSON.stringify({ signal_tags: moment.signalTags })}
- mouse_summary_near_moment: ${JSON.stringify(moment.mouseSnapshot ?? {})}
- engagement_state_near_moment: ${JSON.stringify(moment.engagementSnapshot ?? {})}

Guidance:
Use these mapping heuristics (choose best fit):
- High hedges + explicit uncertainty + clarification → copy/terminology unclear OR task prompt unclear
- Repeat attempt loop + "did that work?" + pauses → system status/feedback unclear
- "where is…" + backtracking + long pauses → discoverability/navigation issue
- Many pauses/hesitation on form fields → form field friction/micro-friction
- Confusion immediately after interviewer task prompt → task_prompt_issue

Output JSON only.`;

      let parsed: Record<string, unknown>;
      try {
        const response = await client.chat.completions.create({
          // Verify model name at https://fireworks.ai/models — search "glm"
          model: "accounts/fireworks/models/glm-5",
          max_tokens: 1024,
          messages: [{ role: "system", content: LABELER_SYSTEM }, { role: "user", content: userMessage }],
          response_format: { type: "json_object" },
        });
        const text = response.choices[0].message.content ?? "{}";
        parsed = JSON.parse(text);
      } catch {
        continue; // skip this moment on failure; don't crash the whole pipeline
      }

      const category = VALID_CATEGORIES.includes(parsed.category as string) ? parsed.category as string : "other";

      await ctx.runMutation(api.friction.patchLabel, {
        momentId: moment._id,
        candidateFindingLabel: ((parsed.candidate_finding_label as string) ?? "").slice(0, 90),
        category: category as "copy_language" | "discoverability" | "system_status_feedback" | "navigation_ia" | "form_field_friction" | "task_prompt_issue" | "error_recovery" | "other",
        interpretation: ((parsed.interpretation as string) ?? "").slice(0, 260),
        recommendations: Array.isArray(parsed.recommendations) ? (parsed.recommendations as string[]).slice(0, 4) : [],
        verificationQuestion: (parsed.verification_question as string) ?? "",
        labelConfidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      });
    }
  },
});

export const generateThemes = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const moments = await ctx.runQuery(api.friction.listBySession, { sessionId: args.sessionId });
    if (moments.length === 0) return;

    const client = new OpenAI({
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKey: process.env.FIREWORKS_API_KEY!,
    });
    const summaryInput = moments
      .filter((m) => m.candidateFindingLabel)
      .map((m) => `- [${m.category}] ${m.candidateFindingLabel}: ${m.interpretation}`)
      .join("\n");

    const response = await client.chat.completions.create({
      model: "accounts/fireworks/models/glm-5",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: `From these UX findings, identify the top 3 friction themes. Return a JSON array of 3 short strings (each ≤80 chars). No extra keys.\n\nFindings:\n${summaryInput}\n\nReturn: ["theme 1", "theme 2", "theme 3"]`,
      }],
    });

    let themes: string[] = [];
    try {
      const text = response.choices[0].message.content ?? "[]";
      themes = JSON.parse(text);
      if (!Array.isArray(themes)) themes = [];
    } catch { themes = []; }

    // Compute session friction score
    const allScores = await ctx.runQuery(api.signals.listBySession, { sessionId: args.sessionId });
    const scores = allScores.map((w) => w.friction0to100);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const peak = scores.length ? Math.max(...scores) : 0;
    const timeInHigh = scores.length ? (scores.filter((s) => s >= 75).length / scores.length) * 100 : 0;
    const sessionFriction = Math.round(0.45 * avg + 0.35 * peak + 0.2 * timeInHigh);

    await ctx.runMutation(api.findings.patchOutputs, {
      sessionId: args.sessionId,
      themes: themes.slice(0, 3),
      sessionFriction,
    });
  },
});

export const patchOutputs = mutation({
  args: {
    sessionId: v.id("sessions"),
    themes: v.array(v.string()),
    sessionFriction: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      outputs: { themes: args.themes, sessionFriction: args.sessionFriction },
    });
  },
});
```

**Step 2: Chain into session-end flow**

In `app/interview/[sessionId]/page.tsx`, update the last-task branch:

```typescript
const labelMoments = useAction(api.findings.labelAllMoments);
const generateThemes = useAction(api.findings.generateThemes);

// In handleEndTurn, after detectFriction:
await detectFriction({ sessionId });
await labelMoments({ sessionId });
await generateThemes({ sessionId });
router.push(`/dashboard/${sessionId}`);
```

**Step 3: Commit**

```bash
git add convex/findings.ts app/interview/
git commit -m "feat: post-session GLM-5 (FireworksAI) labeler + themes generator"
```

---

## Task 20: Findings Dashboard — Summary + Moment Cards

**Verification:** 🧪 Manual — complete a session end-to-end, navigate to `/dashboard/[sessionId]`, verify themes, friction score, moment cards with labels and recommendations all render

**Files:**
- Create: `app/dashboard/[sessionId]/page.tsx`
- Create: `components/dashboard/SummarySection.tsx`
- Create: `components/dashboard/MomentCard.tsx`

---

**Step 1: Create `components/dashboard/SummarySection.tsx`**

```typescript
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

interface Props {
  themes: string[];
  sessionFriction: number;
  momentCount: number;
  taskCount: number;
}

export function SummarySection({ themes, sessionFriction, momentCount, taskCount }: Props) {
  const severity = sessionFriction >= 70 ? "HIGH" : sessionFriction >= 40 ? "MED" : "LOW";
  const severityColor = { HIGH: "destructive", MED: "secondary", LOW: "outline" } as const;
  return (
    <div className="grid grid-cols-3 gap-4">
      <Card className="col-span-2">
        <CardHeader><CardTitle>Top Friction Themes</CardTitle></CardHeader>
        <CardContent>
          {themes.length > 0 ? (
            <ol className="list-decimal list-inside space-y-2">
              {themes.map((t, i) => <li key={i} className="text-sm">{t}</li>)}
            </ol>
          ) : <p className="text-sm text-muted-foreground">Themes not yet generated.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Session Score</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-3xl font-bold">{sessionFriction}</span>
            <Badge variant={severityColor[severity]}>{severity}</Badge>
          </div>
          <Progress value={sessionFriction} className="h-2" />
          <p className="text-xs text-muted-foreground">{momentCount} friction moment(s) across {taskCount} task(s)</p>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 2: Create `components/dashboard/MomentCard.tsx`**

```typescript
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const CATEGORY_LABELS: Record<string, string> = {
  copy_language: "Copy / Language",
  discoverability: "Discoverability",
  system_status_feedback: "System Feedback",
  navigation_ia: "Navigation / IA",
  form_field_friction: "Form Field",
  task_prompt_issue: "Task Prompt",
  error_recovery: "Error Recovery",
  other: "Other",
};

interface Props {
  moment: {
    _id: string;
    tStart: number;
    tEnd: number;
    taskId: string;
    frictionPeak: number;
    signalTags: string[];
    candidateFindingLabel?: string;
    category?: string;
    interpretation?: string;
    recommendations?: string[];
    verificationQuestion?: string;
    labelConfidence?: number;
    evidence: { transcriptSnippets: string[] };
    engagementSnapshot?: { state: string; confidence: number };
  };
  taskLabel?: string;
}

export function MomentCard({ moment, taskLabel }: Props) {
  const severity = moment.frictionPeak >= 70 ? "HIGH" : moment.frictionPeak >= 40 ? "MED" : "LOW";
  const severityVariant = { HIGH: "destructive", MED: "secondary", LOW: "outline" } as const;
  const formatTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

  return (
    <Card className="border-l-4 border-l-orange-400">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">{formatTime(moment.tStart)} – {formatTime(moment.tEnd)} · {taskLabel ?? moment.taskId}</p>
            <CardTitle className="text-base mt-1">{moment.candidateFindingLabel ?? "Friction moment"}</CardTitle>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Badge variant={severityVariant[severity]}>{severity} {moment.frictionPeak}</Badge>
            {moment.category && <Badge variant="outline">{CATEGORY_LABELS[moment.category] ?? moment.category}</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {moment.evidence.transcriptSnippets.length > 0 && (
          <blockquote className="border-l-2 pl-3 italic text-muted-foreground">
            "{moment.evidence.transcriptSnippets[0]}"
          </blockquote>
        )}
        {moment.signalTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {moment.signalTags.map((tag) => <Badge key={tag} variant="outline" className="text-xs">{tag.replace(/_/g, " ")}</Badge>)}
          </div>
        )}
        {moment.interpretation && <p className="text-muted-foreground">{moment.interpretation}</p>}
        {moment.engagementSnapshot && (
          <p className="text-xs text-muted-foreground">Camera: {moment.engagementSnapshot.state.replace(/_/g, " ")} ({Math.round(moment.engagementSnapshot.confidence * 100)}% confidence)</p>
        )}
        {moment.recommendations && moment.recommendations.length > 0 && (
          <div>
            <p className="font-medium text-xs uppercase tracking-wide mb-1">Recommendations</p>
            <ul className="list-disc list-inside space-y-1">
              {moment.recommendations.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}
        {moment.verificationQuestion && (
          <p className="text-xs bg-muted rounded p-2"><span className="font-medium">Verify: </span>{moment.verificationQuestion}</p>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 3: Create `app/dashboard/[sessionId]/page.tsx`**

```typescript
"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams } from "next/navigation";
import { Id } from "@/convex/_generated/dataModel";
import { SummarySection } from "@/components/dashboard/SummarySection";
import { MomentCard } from "@/components/dashboard/MomentCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function DashboardPage() {
  const params = useParams();
  const sessionId = params.sessionId as Id<"sessions">;
  const data = useQuery(api.sessions.getWithStudy, { sessionId });
  const moments = useQuery(api.friction.listBySession, { sessionId });

  if (!data?.session || !data.study) return <div className="p-8">Loading results…</div>;

  const { session, study } = data;
  const themes = session.outputs?.themes ?? [];
  const sessionFriction = session.outputs?.sessionFriction ?? 0;
  const sortedMoments = [...(moments ?? [])].sort((a, b) => b.frictionPeak - a.frictionPeak);

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/studies/${study._id}`} className="text-sm text-muted-foreground">← {study.title}</Link>
          <h1 className="text-2xl font-bold mt-1">Session Results</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" id="export-btn">Export</Button>
        </div>
      </div>

      <SummarySection
        themes={themes}
        sessionFriction={sessionFriction}
        momentCount={sortedMoments.length}
        taskCount={study.tasks.length}
      />

      <Tabs defaultValue="moments">
        <TabsList>
          <TabsTrigger value="moments">Friction Moments ({sortedMoments.length})</TabsTrigger>
          <TabsTrigger value="heatmap">Heatmap</TabsTrigger>
        </TabsList>
        <TabsContent value="moments" className="space-y-4 mt-4">
          {sortedMoments.length === 0 && (
            <p className="text-muted-foreground text-sm">No friction moments detected — great session!</p>
          )}
          {sortedMoments.map((m) => (
            <MomentCard
              key={m._id}
              moment={m}
              taskLabel={study.tasks.find((t) => t.id === m.taskId)?.label}
            />
          ))}
        </TabsContent>
        <TabsContent value="heatmap">
          <p className="text-sm text-muted-foreground mt-4">Heatmap renders in Task 21.</p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

**Step 4: Commit**

```bash
git add app/dashboard/ components/dashboard/SummarySection.tsx components/dashboard/MomentCard.tsx
git commit -m "feat: findings dashboard with summary section and moment cards"
```

---

## Task 21: Heatmap View

**Verification:** 🧪 Manual — on the dashboard heatmap tab, verify a canvas overlay renders showing click density over the prototype area

**Files:**
- Create: `components/dashboard/HeatmapView.tsx`

---

**Step 1: Install simpleheat**

```bash
npm install simpleheat
npm install -D @types/simpleheat
```

If `@types/simpleheat` is not available, create a local type declaration at `types/simpleheat.d.ts`:

```typescript
declare module 'simpleheat' {
  interface SimpleHeat {
    data(data: [number, number, number][]): this;
    max(value: number): this;
    radius(r: number, blur?: number): this;
    draw(minOpacity?: number): this;
    resize(): void;
    clear(): void;
  }
  function simpleheat(canvas: HTMLCanvasElement): SimpleHeat;
  export = simpleheat;
}
```

**Step 2: Create `components/dashboard/HeatmapView.tsx`**

```typescript
"use client";
import { useEffect, useRef } from "react";
import simpleheat from "simpleheat";

interface HeatmapBin { x: number; y: number; count: number; }

interface Props {
  bins: HeatmapBin[];
  prototypeUrl: string;
  width?: number;
  height?: number;
}

export function HeatmapView({ bins, prototypeUrl, width = 800, height = 500 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || bins.length === 0) return;
    const heat = simpleheat(canvas);
    // bins have x/y as 0-1 fractions of the prototype area
    const points: [number, number, number][] = bins.map(b => [
      b.x * width,
      b.y * height,
      b.count,
    ]);
    heat.data(points).max(Math.max(...bins.map(b => b.count)));
    heat.radius(25, 15);
    heat.draw(0.05);
  }, [bins, width, height]);

  return (
    <div className="relative rounded overflow-hidden border" style={{ width, height }}>
      <iframe
        src={prototypeUrl}
        className="absolute inset-0 w-full h-full border-0 opacity-60"
        sandbox="allow-scripts allow-same-origin"
        title="Prototype heatmap background"
      />
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="absolute inset-0 pointer-events-none"
      />
    </div>
  );
}
```

**Step 3: Wire into dashboard**

Update `app/dashboard/[sessionId]/page.tsx` to load mouse windows and pass bins to HeatmapView:

```typescript
import { HeatmapView } from "@/components/dashboard/HeatmapView";

// Inside DashboardPage:
const mouseWindows = useQuery(api.mouse.listBySession, { sessionId });
const allBins = (mouseWindows ?? []).flatMap(w => w.heatmapBins ?? []);

// In the heatmap TabsContent:
<TabsContent value="heatmap">
  {allBins.length > 0 ? (
    <HeatmapView bins={allBins} prototypeUrl={study.prototypeUrl} />
  ) : (
    <p className="text-sm text-muted-foreground mt-4">No mouse data captured.</p>
  )}
</TabsContent>
```

**Step 4: Commit**

```bash
git add components/dashboard/HeatmapView.tsx app/dashboard/ types/
git commit -m "feat: heatmap view with simpleheat canvas overlay"
```

---

## Task 22: Export — Markdown + JSON

**Verification:** ✅ Automated (markdown generation logic) + 🧪 Manual (click Export in browser, verify file downloads)

**Files:**
- Create: `lib/export/report.ts`
- Create: `tests/export/report.test.ts`
- Create: `components/dashboard/ExportButtons.tsx`

---

**Step 1: Write failing tests**

Create `tests/export/report.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateMarkdownReport } from '@/lib/export/report';

const mockReport = {
  studyTitle: "Checkout Flow Test",
  sessionId: "abc123",
  endedAt: 1700000000000,
  themes: ["Users struggle to find checkout", "Form labels unclear"],
  sessionFriction: 72,
  moments: [
    {
      tStart: 45,
      tEnd: 75,
      taskId: "t1",
      taskLabel: "Complete checkout",
      frictionPeak: 85,
      candidateFindingLabel: "Checkout button not discoverable",
      category: "discoverability",
      interpretation: "User spent 30s searching for checkout.",
      recommendations: ["Make checkout CTA more prominent", "Use contrasting color"],
      signalTags: ["long_pause", "backtracking"],
      evidence: { transcriptSnippets: ["where is the checkout button"] },
    },
  ],
};

describe('generateMarkdownReport', () => {
  it('includes study title', () => {
    const md = generateMarkdownReport(mockReport);
    expect(md).toContain("Checkout Flow Test");
  });

  it('includes top themes', () => {
    const md = generateMarkdownReport(mockReport);
    expect(md).toContain("Users struggle to find checkout");
  });

  it('includes friction moment label', () => {
    const md = generateMarkdownReport(mockReport);
    expect(md).toContain("Checkout button not discoverable");
  });

  it('includes transcript quote', () => {
    const md = generateMarkdownReport(mockReport);
    expect(md).toContain("where is the checkout button");
  });
});
```

**Step 2: Run — verify fail**

```bash
npm test -- tests/export/report.test.ts
```

**Step 3: Create `lib/export/report.ts`**

```typescript
export interface MomentExport {
  tStart: number;
  tEnd: number;
  taskId: string;
  taskLabel?: string;
  frictionPeak: number;
  candidateFindingLabel?: string;
  category?: string;
  interpretation?: string;
  recommendations?: string[];
  signalTags: string[];
  evidence: { transcriptSnippets: string[] };
}

export interface ReportData {
  studyTitle: string;
  sessionId: string;
  endedAt: number;
  themes: string[];
  sessionFriction: number;
  moments: MomentExport[];
}

const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export function generateMarkdownReport(data: ReportData): string {
  const date = new Date(data.endedAt).toLocaleDateString();
  const lines: string[] = [
    `# Unfiltered — UX Research Report`,
    ``,
    `**Study:** ${data.studyTitle}  `,
    `**Session:** ${data.sessionId}  `,
    `**Date:** ${date}  `,
    `**Session Friction Score:** ${data.sessionFriction}/100`,
    ``,
    `---`,
    ``,
    `## Top Friction Themes`,
    ``,
    ...data.themes.map((t, i) => `${i + 1}. ${t}`),
    ``,
    `---`,
    ``,
    `## Friction Moments (${data.moments.length})`,
    ``,
  ];

  for (const m of data.moments) {
    lines.push(`### ${m.candidateFindingLabel ?? "Friction Moment"}`);
    lines.push(`**Time:** ${fmtTime(m.tStart)} – ${fmtTime(m.tEnd)} · **Task:** ${m.taskLabel ?? m.taskId} · **Peak:** ${m.frictionPeak}/100`);
    if (m.category) lines.push(`**Category:** ${m.category.replace(/_/g, " ")}`);
    if (m.interpretation) lines.push(`\n${m.interpretation}`);
    if (m.evidence.transcriptSnippets[0]) lines.push(`\n> "${m.evidence.transcriptSnippets[0]}"`);
    if (m.signalTags.length) lines.push(`\n**Signals:** ${m.signalTags.join(", ")}`);
    if (m.recommendations?.length) {
      lines.push(`\n**Recommendations:**`);
      for (const r of m.recommendations) lines.push(`- ${r}`);
    }
    lines.push(`\n---\n`);
  }

  lines.push(`*Generated by Unfiltered — probabilistic attention flags, not diagnoses.*`);
  return lines.join("\n");
}
```

**Step 4: Run — verify pass**

```bash
npm test -- tests/export/report.test.ts
```

**Step 5: Create `components/dashboard/ExportButtons.tsx`**

```typescript
"use client";
import { Button } from "@/components/ui/button";
import { generateMarkdownReport } from "@/lib/export/report";
import type { ReportData } from "@/lib/export/report";

function downloadText(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportButtons({ reportData }: { reportData: ReportData }) {
  const handleMarkdown = () => {
    const md = generateMarkdownReport(reportData);
    downloadText(md, `unfiltered-report-${reportData.sessionId.slice(-8)}.md`, "text/markdown");
  };

  const handleJson = () => {
    downloadText(JSON.stringify(reportData, null, 2), `unfiltered-report-${reportData.sessionId.slice(-8)}.json`, "application/json");
  };

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={handleMarkdown}>Export Markdown</Button>
      <Button variant="outline" size="sm" onClick={handleJson}>Export JSON</Button>
    </div>
  );
}
```

**Step 6: Wire into dashboard**

Replace the placeholder `<Button>Export</Button>` in `app/dashboard/[sessionId]/page.tsx`:

```typescript
import { ExportButtons } from "@/components/dashboard/ExportButtons";

// Build reportData from existing queries:
const reportData = {
  studyTitle: study.title,
  sessionId: String(sessionId),
  endedAt: session.endedAt ?? Date.now(),
  themes: session.outputs?.themes ?? [],
  sessionFriction: session.outputs?.sessionFriction ?? 0,
  moments: sortedMoments.map(m => ({
    tStart: m.tStart,
    tEnd: m.tEnd,
    taskId: m.taskId,
    taskLabel: study.tasks.find(t => t.id === m.taskId)?.label,
    frictionPeak: m.frictionPeak,
    candidateFindingLabel: m.candidateFindingLabel,
    category: m.category,
    interpretation: m.interpretation,
    recommendations: m.recommendations,
    signalTags: m.signalTags,
    evidence: m.evidence,
  })),
};

// Replace Export button with:
<ExportButtons reportData={reportData} />
```

**Step 7: Commit**

```bash
git add lib/export/ tests/export/ components/dashboard/ExportButtons.tsx app/dashboard/
git commit -m "feat: markdown and JSON export with report generator (TDD)"
```

---

## Task 23: Final Integration Smoke Test + Environment Checklist

**Verification:** 🧪 Manual — run a complete end-to-end session and verify every system works together

**Files:**
- No new files — this is a manual integration checkpoint

---

**Pre-flight checklist (confirm before running):**

- [ ] `SPEECHMATICS_API_KEY` set in `.env.local`
- [ ] `FIREWORKS_API_KEY` set in `.env.local`
- [ ] `MINIMAX_API_KEY` set in `.env.local`
- [ ] Convex dev server running (`npx convex dev`)
- [ ] Next.js dev server running (`npm run dev`)
- [ ] Browser: Chrome or Edge (AudioWorklet + WebSpeech most reliable)
- [ ] GLM-5 model name verified at `fireworks.ai/models` (search "glm"); update `convex/decide.ts` and `convex/findings.ts` if needed
- [ ] MiniMax Vision model name verified at MiniMax API docs; update `convex/classifyEngagement.ts` if needed

**End-to-end test script:**

1. Navigate to `http://localhost:3000/studies/new`
2. Create a study: Title "Checkout Test", Prototype URL (use any public URL, e.g. `https://example.com`), 2 tasks: "Find the pricing page" / "Complete signup", Mode B
3. On the study detail page, copy the participant link
4. Open participant link in a new tab
5. Check Microphone + Mouse Tracking consent, optionally check Camera. Click Start
6. In the interview room, wait for the AI to speak the intro task
7. Speak out loud: "I'm not sure where to go, I don't see the pricing… uh, let me try this button"
8. Wait ~10 seconds — the AI should respond with a follow-up question
9. Continue for ~2 minutes, then click "End Turn →" twice to advance through tasks and end the session
10. Verify you are redirected to `/dashboard/[sessionId]`
11. Verify: themes are shown, at least 1 friction moment card appears with label + recommendations
12. Click "Export Markdown" — verify file downloads with content

**All automated tests:**

```bash
npm test
```

Expected: all test files pass (extractor, scorer, policyA, mouseTracker, frictionDetector, markdownReport).

**Commit (if any final fixes needed):**

```bash
git add -A
git commit -m "fix: integration smoke test fixes"
```

---

## Test Coverage Summary

| Task | File | Verification |
|---|---|---|
| 1 | `tests/setup.test.ts` | ✅ Automated |
| 8 | `tests/signals/extractor.test.ts` | ✅ Automated |
| 9 | `tests/signals/scorer.test.ts` | ✅ Automated |
| 10 | `tests/decide/policyA.test.ts` | ✅ Automated |
| 13 | `tests/mouse/tracker.test.ts` | ✅ Automated |
| 18 | `tests/friction/detector.test.ts` | ✅ Automated |
| 22 | `tests/export/report.test.ts` | ✅ Automated |
| 2 | Convex dashboard | 🧪 Manual |
| 3 | Convex dashboard | 🧪 Manual |
| 4 | Browser — create study | 🧪 Manual |
| 5 | Browser — consent flow | 🧪 Manual |
| 6 | Browser — interview shell | 🧪 Manual |
| 7 | `curl` token endpoint | 🧪 Manual |
| 11 | Convex dashboard | 🧪 Manual |
| 12 | Browser — speak + see transcript | 🧪 Manual |
| 14 | Convex dashboard — engagement rows | 🧪 Manual |
| 15 | Convex dashboard — signal windows | 🧪 Manual |
| 16 | Convex dashboard — decide events | 🧪 Manual |
| 17 | Browser — AI speaks follow-up | 🧪 Manual |
| 18 | `tests/friction/detector.test.ts` + Convex | 🔀 Both |
| 19 | Convex — labeled frictionMoments | 🧪 Manual |
| 20 | Browser — dashboard renders | 🧪 Manual |
| 21 | Browser — heatmap canvas renders | 🧪 Manual |
| 22 | `tests/export/report.test.ts` + download | 🔀 Both |
| 23 | Full E2E run | 🧪 Manual |

---

*Plan complete. Implement task-by-task in order — each task's output is consumed by later tasks.*
