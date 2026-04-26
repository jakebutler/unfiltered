# Feature: Findings Dashboard

**Status:** Implemented (manual E2E validation ongoing)
**Plan tasks:** Task 18-22
**Route:** `/dashboard/[sessionId]`
**Reference doc:** [`post-session-candidate-finding-labeler.md`](../post-session-candidate-finding-labeler.md)

---

## What It Does

After session completion, the system:
1. Clusters high-friction windows into `frictionMoments`
2. Labels every moment with category, interpretation, recommendations, and verification question using GLM-5 via FireworksAI
3. Generates top 3 session themes using GLM-5 via FireworksAI
4. Renders summary, moment cards, heatmap tab, and export controls on `/dashboard/[sessionId]`

---

## Implemented Pipeline

### 1) Friction moment detection
- File: `convex/friction.ts`
- Uses `lib/friction/detector.ts`
- Stores clustered moments in `frictionMoments`

### 2) Post-session moment labeling
- File: `convex/findings.ts`
- Action: `labelAllMoments`
- Model: `accounts/fireworks/models/glm-5`

### 3) Themes + session score
- File: `convex/findings.ts`
- Action: `generateThemes`
- Model: `accounts/fireworks/models/glm-5`
- Patches `sessions.outputs.themes` + `sessions.outputs.sessionFriction`

### 4) Dashboard rendering
- File: `app/dashboard/[sessionId]/page.tsx`
- Components:
  - `components/dashboard/SummarySection.tsx`
  - `components/dashboard/MomentCard.tsx`
  - `components/dashboard/HeatmapView.tsx`
  - `components/dashboard/ExportButtons.tsx`

---

## Displayed Data

- Top 3 themes
- Session friction score
- Moment cards sorted by `frictionPeak` descending
- Evidence snippets + signal tags + engagement snapshot + recommendations
- Heatmap overlay from `mouseWindows.heatmapBins`
- Export to Markdown and JSON

---

## Notes

- Labeler runs on all detected moments (not top-N only)
- `verificationQuestion` is stored and displayed read-only in V1
- Dashboard updates reactively from Convex queries
- Route canonicalized to `/dashboard/[sessionId]`
