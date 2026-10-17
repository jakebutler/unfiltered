# Clinic acceptance walkthrough

This is the repeatable validation checklist for the current clinic release. No checklist establishes “100% bug-free.” A passed offline browser run does not verify live AI, microphone transcription, Medplum authorization, hosted persistence or production latency.

Use [DEMO-PATIENT-SCRIPTS.md](DEMO-PATIENT-SCRIPTS.md) for fictional answers and [DEMO-RELEASE-RUNBOOK.md](DEMO-RELEASE-RUNBOOK.md) for the release prerequisites. Current release status belongs in [HANDOFF-CURRENT-WORK.md](HANDOFF-CURRENT-WORK.md).

## Verification boundary for this release candidate

| Area | October 17, 2026 result |
|---|---|
| Foundation / clinic / hosting suites | 2,266 / 345 / 31 passed; all required typechecks passed |
| Desktop and 390/360 px browser journeys | Offline harness; seven partial workflows, PHQ, invitations and safety actions tested |
| Generated deployment package | Local Node startup/assets/security checks passed; no outbound provider calls |
| Hosted patient-to-staff journey, native role permissions | Not yet verified for this candidate |
| Real microphone, adaptive provider behavior, hosted latency | Not yet verified for this candidate |
| Physical phone keyboard / mobile browser behavior | Not yet verified; viewport emulation is not a physical-device check |
| Deployment / qualification renewal / secret rotation | Not performed; see release runbook for exact missing access and inputs |

## Automated local browser run

Requires Node 22, root dependencies (`npm ci`), and Chromium. Run from the repository root in three terminals. The backend is disposable and all records disappear when it stops. Never point this fixture at a real FHIR server.

Terminal 1:

```sh
npx tsx scripts/dev/invitations-local-smoke.mts --serve-local
```

Terminal 2:

```sh
npm run clinic:dev
```

Terminal 3 (install browser tooling once into ignored tooling storage):

```sh
npm install --prefix .factory/browser-tools --no-save --package-lock=false --ignore-scripts playwright@1.57.0
.factory/browser-tools/node_modules/.bin/playwright install chromium
NODE_PATH="$PWD/.factory/browser-tools/node_modules" node scripts/dev/clinic-browser-smoke.cjs
```

If using an existing Chromium installation, omit the browser download and set `CHROMIUM_PATH` to its executable when running the suite. Evidence defaults to `.factory/browser-evidence`; `CLINIC_BROWSER_OUTPUT` can select a private evidence directory. Do not commit screenshots or runtime artifacts. The runner allows only the local app origin and accepts no hosted URL.

The suite tests 1365×1000, 390×844 and 360×740 layouts: all seven workflows with deliberate skip → reload → reconfirm identity → partial review → verified in-memory delivery; PHQ choices and scores in patient/staff views; copy-only invitation acknowledgement, identity binding and rejection after use; fail-closed safety review, an intentionally lost action acknowledgement, idempotent retry, disabled navigation during an in-flight action, action history, queue refresh and no horizontal page overflow. It records screenshots and a JSON report. It does not simulate a physical phone keyboard or microphone.

Local physician login only: `synthetic-md@example.invalid` / `local-smoke-only`. These credentials do not work on the hosted site. The offline backend deliberately has no model reviewer: flagged free text exercises the unavailable-reviewer path.

## Before hosted acceptance

Record the exact deployed commit, canonical URL, qualification expiry, browser/version, device, time and fictional patient for each run. Use separate patient/staff browser profiles. The run is blocked if qualification is expired, identity is wrong, staff scope is wrong, or the backend is unavailable. Do not count a successful static page load as a successful release.

Required evidence fields:

| Test | Environment/commit | Device/browser | Actual result | Pass/fail/blocked | Evidence/run time |
|---|---|---|---|---|---|
| Example: invitation → first intake | Fill before running | Fill before running | Observed outcome, not expected outcome | Unrun initially | Private screenshot/log path |

## 1. Entry, identity and invitation links

1. Open `/staff`, sign in as the assigned physician and select the intended fictional patient.
2. Create a **Before your visit** invitation; copy the displayed link. Expected: copy-only receipt, expiry shown, no email delivery claim.
3. Open in a fresh patient profile. Expected: token fragment disappears from the address bar; acknowledgement is required before redemption; patient identity confirmation appears before any answer control.
4. Check the displayed fictional identity and workflow. Confirm and enter the conversation.
5. Open the same invitation in a second fresh profile. Expected: expired/used link feedback, no second patient session.
6. Test an invalid token and, with an expired fixture, an expired link. Expected: safe failure without revealing another patient's identity.
7. Use **This isn’t me**. Expected: browser access clears and no clinical answers are available. Use a fresh invitation for the next run.
8. Disable clipboard permission and use **Copy link**. Expected: understandable fallback allowing manual selection/copy of the displayed link.

## 2. Patient answers and confirmation

Run Scripts A–E across all seven workflows. For each:

1. Verify the heading and first question match the chosen workflow.
2. Give at least one relevant answer using the displayed field/button; inspect **Your words** in review.
3. Test **I don’t know**, **I’d rather not say** and **Skip for now** separately. Unknown, declined and skipped must remain distinguishable.
4. Edit an answer in review. Expected: correction retained with source attribution; no silent replacement of unrelated facts.
5. Reload after a saved answer and reconfirm identity. Expected: saved draft persists, no duplicate answer and no other patient's draft.
6. Review while other required topics remain unanswered. Expected: partial status and explicit gaps.
7. Confirm once. Expected: verified receipt; pending, unknown or failed delivery must remain visibly distinct. Reload and inspect status before retrying an uncertain operation.
8. Verify no fabricated appointment, care plan, diagnosis, dose recommendation, coverage decision, booking or refill approval.

## 3. PHQ and exact-choice controls

1. Follow Script A’s topic navigation and four explicit choices.
2. Expected: PHQ-4 6, GAD-2 3, PHQ-2 3 in both patient review and assigned clinician view; clinician review required; incomplete overall intake stays partial.
3. Repeat in a fresh session with only three PHQ items answered. Expected: screening incomplete and no full PHQ-4 score.
4. Say or type a mood narrative elsewhere. Expected: no invented PHQ answer or score.
5. On an ordinary yes/no question, select a choice and confirm as required. For speech choices, try “yes … actually no.” Expected: explicit correction/confirmation, no ambiguous answer saved.
6. Verify exact PHQ questions require buttons even during hands-free voice.

## 4. Staff handoff and permissions

1. Physician: refresh, open the new handoff, verify workflow, completeness, sources and allowed actions. Record an outcome with a unique fictional note.
2. Reload: the outcome and actor attribution persist. A retry after an uncertain response must reconcile the original action rather than duplicate it.
3. Assigned dietitian: verify clinical answers are available while the nutrition responsibility remains independently actionable.
4. Administrative staff: verify only authorized logistics are visible. Clinical answers, transcript, PHQ and safety review must not leak.
5. Unrelated clinician: verify the patient and handoff cannot be opened, including direct API access. Do not accept UI hiding as authorization proof.
6. Sign out; browser back/reload must not restore authenticated access.

## 5. Safety and recovery

1. Use the private safety exercise in the patient scripts. Verify the original disclosure, question and review state in the physician safety detail.
2. Record an outcome and note. Expected: review closes, history attributes the action, queue count updates without a full-page reload. Closed items leave the active queue and remain accessible under **Reviewed safety messages**.
3. Repeat on mobile: selecting a review must hide the queue and reveal the detail. **Safety review list** returns to the queue.
4. Use the already-authored deterministic phrase “I may hurt myself tonight.” Expected: routine questions pause and authored help guidance appears; no model-generated clinical advice.
5. Test negated, historical and family wording from the existing safety testing guide. Do not equate a keyword match with current patient risk.
6. In the offline harness, verify unavailable reviewer feedback. In live testing, provider errors must fail toward human review rather than silently clear a concern.
7. Simulate a failed queue fetch in browser devtools. Expected: unavailable/stale message with retry, not a false empty queue.
8. Simulate a dropped confirmation/action response. Check authenticated saved state before retrying. No duplicate handoff or staff action should result.

## 6. Real voice and latency — hosted-only gate

Use Chrome/Edge desktop and a physical mobile browser with a working microphone. Offline browser results do not satisfy this section.

1. Allow microphone, opt in to synthetic voice, dictate a short answer and finish. Inspect transcript before sending.
2. Dictate “five feet seven inches, two hundred fourteen pounds, measured October twelfth.” Verify units/date and explicit confirmation; do not accept silently guessed values.
3. Test permission denied, stop, tab switch, interruption and provider failure. Typed answers remain usable; retained audio/transcript has explicit retry/discard behavior.
4. Test hands-free pause/resume, speech over playback, a mid-sentence correction and a connection loss. PHQ pauses voice for buttons.
5. Read questions aloud. Browser speech is the default; do not make ElevenLabs a prerequisite for the agreed demo.
6. Record visible feedback, provider completion and next-render latency for guided and adaptive turns, including a cold start. Inspect numeric `Server-Timing`/`window.__corvoTurnTimings` without exporting patient wording or secrets.
7. Flag stalls, duplicate transcript, lost correction, repeated prompts, false progress or unexplained fallback as failures. A unit-test timing result is not hosted latency evidence.

## 7. Mobile and accessibility

Repeat at 390×844 and 360×740, then on a physical phone with the keyboard open:

- No horizontal page scroll on entry, choices, review, receipt, invitation, staff queue or safety detail.
- Input and send controls remain reachable with the keyboard; focus does not disappear behind overlays.
- Topic drawer opens/closes and returns focus; review and back controls remain usable.
- Exact choices wrap legibly; voice controls remain reachable when enabled.
- Keyboard-only navigation reaches primary actions; required field labels and errors are understandable.
- Refresh/failure messages distinguish stale data from a genuinely empty queue.

## Sign-off

A release is client-demo ready only after the current build has a valid qualification, the relevant live journeys above have passed, and failures are either fixed or explicitly excluded from the demo story. Keep unrun tests marked **unrun**. Record the final deployment URL and commit alongside the evidence; do not reuse receipts from an older release.
