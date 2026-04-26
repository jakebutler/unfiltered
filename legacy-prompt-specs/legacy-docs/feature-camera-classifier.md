# Feature: Camera Engagement Classifier

**Status:** Implemented (camera optional + graceful fallback)
**Plan tasks:** Task 14
**Reference doc:** [`camera-engagement-classifier.md`](../camera-engagement-classifier.md)

---

## What It Does

Captures periodic webcam frames, classifies engagement state with MiniMax Vision, and stores engagement events for multimodal context.

---

## Implemented Flow

1. `hooks/useCamera.ts` captures a frame every ~4s when camera consent is enabled
2. Frame is downscaled and JPEG-encoded (base64)
3. `convex/classifyEngagement.ts` calls MiniMax Vision API
4. `convex/engagements.ts` stores `engagementEvents`
5. Decide engine consumes recent engagement state

---

## Stored Output Shape

```ts
{
  state: "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence",
  confidence: number,
  signals: {
    facePresent: boolean,
    gazeTowardScreenLikely: boolean,
    attentionStableLikely: boolean,
    visibleFrustrationCuesLikely: boolean,
  },
  notes: string,
}
```

---

## Notes

- Camera is optional; denied permissions do not block session flow
- Keep interpretation neutral; these are support signals, not diagnoses
- Confirm model identifier in MiniMax docs before production hardening
