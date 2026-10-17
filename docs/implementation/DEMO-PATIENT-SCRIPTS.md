# Repeatable clinic demo

All people and answers below are fictional. These are role-play scripts, not new questionnaire wording or clinical guidance. Use the existing synthetic patient displayed by the app; do not create real patient records or pretend an invented appointment is verified.

Scope: the seven existing workflows, copy/paste invitations, patient review and staff handoff. Email delivery and the proposed W08 between-visit pack are outside this demo. The existing **Check in with your care team** workflow is available; W08 is different.

## Presenter setup

1. Use the release and test status in [DEMO-ACCEPTANCE.md](DEMO-ACCEPTANCE.md). Do not describe local mock results as hosted validation. The latest October 17 preflight resolved inference-host access through authenticated metadata checks. Hosted browser checks still cover only public pages on the older release; authenticated Scripts A–E remain unrun for this candidate while private staff/configuration, administrative rotation/calibration and required Appointment permission are missing.
2. Have a patient browser window and a separate staff window/profile. Use the assigned physician, dietitian and administrative accounts from the private users file. Never project passwords or invitation tokens to the audience.
3. Keep the patient on the fictional identity shown by the invitation. Each link is single-use, expires after 72 hours, and should be pasted into a fresh patient context. Create a new link for each repeat; reloading an already redeemed link is not a new invitation.
4. Copy-only delivery needs no Resend credentials. Do not click or imply an email-send flow.
5. Keep the story to 8–12 minutes. Show the full acceptance matrix separately when asked.

Opening narration: “This is a fictional clinic demonstration. The patient reviews what they shared before sending it. Staff receive a sourced handoff with gaps visible and record their own next steps. Sending a request does not book a visit, approve a prescription or provide medical advice.”

## Script A — First visit, priorities and mood (main demo)

Patient story: Alex wants steadier energy and practical help with eating around late shifts.

1. Staff: choose the assigned fictional patient, **Send check-in link**, **First visit intake**, then **Create check-in link**. Use **Copy link** and paste it in the patient window.
2. Patient: acknowledge fictional data, select **Open check-in**, then confirm the displayed identity. Show that answers are unavailable before identity confirmation.
3. At the priorities question, type: “I want steadier energy and less snacking after my late shifts. Progress would mean cooking dinner at home three nights a week.”
4. If using natural conversation, offer this separately: “I’m 5 feet 7 inches. My measured weight was 214 pounds on October 12, 2026.” In guided mode, enter these only in the matching measurement fields. An estimate must never silently replace a measured weight.
5. Select **Mood, anxiety and support** from the topics list (**Your topics** on mobile). For the three lead-in questions use **I don’t know**. For the four PHQ items choose, in displayed order: **Several days**, **More than half the days**, **Nearly every day**, **Not at all**. Select **Send answer** after each. Do not paraphrase the questions or speak the scores.
6. Select **Review my answers**. Expected: PHQ-4 6, GAD-2 3, PHQ-2 3, clinician review required. The overall intake remains partial because other topics are unanswered. Inspect **Your words** for the priorities answer.
7. Select **Confirm and send to Corvo Clinic**. Wait for verified receipt; a pending or unconfirmed state is not success.
8. Physician: refresh the queue, open this newest handoff, inspect the answer sources and scores, and record an allowed review outcome with “Synthetic demo: priorities and screening reviewed; discuss at the fictional visit.”
9. Dietitian: show the shared clinical handoff and separate nutrition responsibility. Administrative staff should see only authorized logistics, not the clinical transcript or PHQ answers.

Narration: “The score comes from four explicit answers. It is a screening result requiring clinician review. Unanswered parts are still visible, and the two care-team responsibilities stay separate.”

## Script B — Before a visit, with an honest context gap

Choose **Before your visit**. Use the appointment shown only if it is explicitly verified by the server. If no verified appointment appears, demonstrate the context-check path.

| When asked | Fictional response |
|---|---|
| Appointment details to check | “I think my visit is next week, but please have staff confirm the date and time.” |
| Relevant changes | “Since my last update I’ve been bringing lunch to work three days a week.” |
| Current priority | “I’d like help planning dinners after late shifts.” |
| Practical help | “Please confirm whether the visit is by video and which time zone the invitation uses.” |

Expected: patient-reported appointment uncertainty remains unverified; staff receive context-check work. This is not appointment confirmation. Review, submit, inspect the clinical update and administrative next step.

## Script C — Billing and scheduling (short administrative demo)

Run as two separate conversations with fresh invitations.

**Billing help:** choose bill / explanation using the displayed choices. Service date: October 12, 2026. Reference: `DEMO-BILL-1042`. Free-text help: “Please explain the consultation line on this fictional bill. I’m not asking you to take a payment.”

Expected: structured logistics reaches authorized administrative staff. No payment is collected and no coverage promise is made. Add “Synthetic demo: explanation requested; no payment processed” as the staff outcome note.

**Scheduling help:** request a follow-up, prefer Tuesday afternoon, requested date October 27, 2026, time zone America/Los_Angeles. If a question offers exact choices, use them. Help: “Please contact me with an available afternoon appointment. I understand this is only a request.”

Expected: a scheduling request with the chosen date/time zone, not an invented booking. Staff action notes must not imply an appointment was created unless an actual booking system confirms it.

## Script D — Refill request (optional)

Choose **Prescription refill request** and answer the matching fields:

- Medicine: “Metformin 500 mg.”
- Label directions: “One tablet twice daily with meals.”
- Actual use: “I usually take one tablet with dinner.”
- Remaining: “Six tablets.”
- Pharmacy: “Fictional Example Pharmacy, Demo Street.”
- Symptoms/changes: “No new symptoms to report.”
- Help: “Please ask my clinician to review this refill request and my actual use.”

Expected: label directions and actual use remain distinct; original wording is inspectable. The medical team receives a request. The app must not change a dose, approve a refill or claim it contacted a pharmacy.

## Script E — Existing check-in and after-visit follow-up

**Check in with your care team:** “Since Monday I’ve been struggling to plan dinner after late shifts.” Timing: “Since October 12.” Effect: “I end up ordering takeout.” Help: “Could the dietitian help me plan two easy dinners?”

**After your visit:** if no verified plan is available, say “Please have the care team confirm my plan; I don’t want to guess.” Difficulty: “Preparing lunch has been harder on workdays.” Question: “Which part should I focus on first?” Support: “A written list of the agreed next steps would help.”

Expected: route to the appropriate team, preserve dates and gaps, and never present patient recollection as a verified care plan. Review and confirm each conversation separately.

## Private operator-only safety exercise

Use a fresh fictional session, outside the normal client story. Type “Honestly I feel hopeless most days.” The safety review must happen before extraction; the disclosure must not generate a PHQ score. If the reviewer is unavailable, a visible clinician-review path must remain rather than silently clearing the message.

Physician: inspect the flagged message and question; record **Contacted patient** with “Synthetic exercise only: fictional contact recorded to validate the action history.” Verify closure, attributed history, and the updated queue count. This is a test action, not a real patient contact.

## Reset between presentations

Sign out of staff, close the patient browser context, and create a fresh invitation. Do not wipe the shared Medplum project or delete historical handoffs. Identify your run by timestamp and fictional reference. If a provider request has an uncertain result, check its saved state instead of repeatedly resending it.

Fallback narration if a live integration fails: “This step is currently unavailable. I’ll show the last verified handoff and keep this run marked incomplete.” Do not present the offline fixture as a successful live integration.
