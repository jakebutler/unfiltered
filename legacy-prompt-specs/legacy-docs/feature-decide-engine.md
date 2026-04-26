# Feature: Decide Engine

**Status:** Implemented (policy orchestration wired; behavior tuning pending)
**Plan tasks:** Task 10, Task 16, Task 17
**Reference docs:**
- [`determinstic-decide-policy.md`](../determinstic-decide-policy.md)
- [`decide-engine-policy-b-prompt.md`](../decide-engine-policy-b-prompt.md)

---

## What It Does

Chooses the next interviewer action from realtime speech, engagement, and mouse context.

---

## Implemented Policies

### Policy A (deterministic)
- File: `lib/decide/policyA.ts`
- Pure TypeScript
- Unit tested in `tests/decide/policyA.test.ts`

### Policy B (bounded LLM)
- File: `convex/decide.ts`
- Action: `runPolicyB`
- Provider/model: FireworksAI `accounts/fireworks/models/glm-5`
- Response shape normalized + guarded with fallback defaults

---

## Runtime Orchestration

- File: `hooks/useDecideEngine.ts`
- Triggered by `hooks/useSignalProcessor.ts`
- Uses shared output action set:
  - `ask_followup`
  - `clarify_task`
  - `reflect_back`
  - `move_to_next_task`
  - `wait`
- Stores events via `convex/decide.ts -> storeEvent`
- Speaks prompts with `lib/tts.ts`

---

## Input Signals Used

- Conversation cues from `lib/signals/extractor.ts`
- Friction score from `lib/signals/scorer.ts`
- Engagement state from camera classifier events
- Mouse summary from `useMouseTracker` windows

---

## Notes

- A/B mode flag exists in study/session setup (`A`, `B`, `AB`)
- Current `AB` handling in `useDecideEngine` alternates by local counter and should be hardened to server-assigned policy for deterministic session-level alternation
