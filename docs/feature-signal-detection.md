# Feature: Signal Detection

**Status:** Implemented (unit-tested)
**Plan tasks:** Task 8, Task 9, Task 15
**Reference doc:** [`behavioral-friction-signal-research.md`](../behavioral-friction-signal-research.md)

---

## What It Does

Transforms rolling transcript windows into friction scores.

1. `lib/signals/extractor.ts` extracts conversational friction cues
2. `lib/signals/scorer.ts` computes normalized friction `0-100`
3. `hooks/useSignalProcessor.ts` runs 15s windows on 5s stride and persists signal windows

---

## Implemented Files

- `lib/signals/extractor.ts`
- `lib/signals/scorer.ts`
- `hooks/useSignalProcessor.ts`
- `tests/signals/extractor.test.ts`
- `tests/signals/scorer.test.ts`

---

## Notes

- Scoring maps to `LOW/MED/HIGH` severity hints
- Signal windows are persisted to Convex table `signalWindows`
- Mouse windows are captured in the same processing loop for multimodal context
