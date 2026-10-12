# Corvo Clinic intake: how to try it

Synthetic demo. Use only made-up details; never real health information.

## Text or voice?

Both. Typing always works. Voice is push-to-talk:

1. Under the question, click **Use voice**, then tick the consent box (fictional details only).
2. Click **Dictate one answer**, speak, then click **Finish recording**.
3. Your words appear in the answer box after a second or two. Check names, amounts, units and "not", edit if needed, then click **Send answer**. Nothing is sent until you do.
4. **Listen to question** reads the current question aloud using your browser's own voice. Tick **Read new questions aloud** to hear each new question automatically.

Voice notes:
- Recordings are up to one minute. Transcription uses Deepgram (medical model); the raw recording is not stored.
- PHQ-4 mood items and other fixed-choice questions stay **buttons only**. That is intentional.
- Use Chrome, Edge or Safari, and allow the microphone when asked.

## Run through it (about 10 minutes)

1. Open https://corvo-clinic-demo.vercel.app.
2. Choose **First visit intake**, tick **I'll use only the provided synthetic patient details**, then click **Start conversation**.
3. Click **Continue as Alex**. Alex Rivera is the fictional patient.
4. Answer each question in your own words, then click **Send answer** (about 3–6 seconds per reply).
   - You can pack several facts, a question, or a correction into one message.
   - **I don't know**, **I'd rather not say** and **Skip for now** are always available.
5. The PHQ-4 mood questions are fixed multiple-choice items. That is intentional: the exact wording is required and is never inferred.
   To reach them quickly, pick **Mood, anxiety and support** from the topic list. Answer all four with the buttons; review then shows the scores (PHQ-2, GAD-2, PHQ-4) marked for clinician review.
6. Click **Review my answers** at any time to see each answer, with **Your words** showing exactly what it came from. Use **Change** to fix anything.
7. Click **Confirm and send to Corvo Clinic**. A partial intake is fine; gaps stay visible.
8. Staff view: go to **Staff sign in** (`/staff`) and use the named demo accounts from the private users file. Ask Claude or check `infra/cloud/.private/clinic-cloud-q4f-20261010/clinic-users.json` locally; never share these accounts.
   - **Dr. Morgan Lee** (physician) and **Sam Patel** (RD) see the full handoff.
   - **Taylor Brooks** (admin) should not see clinical content.

You can leave at any point and come back: reload the page and choose **Continue as Alex** to resume where you left off.

## Stress-test responses

Paste these when the matching question comes up, or out of order, to test volunteering. The "Expect" line says what should happen.

### Many facts in one message
- **Say:** "I want more energy and to stop snacking at night. I'm 5 foot 7, the scale at my doctor's office said 214 pounds in July, probably closer to 220 now."
- **Expect:** goal, height, the 214 lb reading with "in July", and a separate "about 220" current estimate. That one question is then not asked again.

### Medication: label versus real use, plus a question
- **Say:** "I take metformin 500 mg, the label says twice a day with meals but I usually only take it at dinner. Also lisinopril 10 mg every morning. Can I just stop the metformin once I start the program?"
- **Expect:**
  - Two medicines.
  - Label directions and actual use kept separate.
  - No medical advice; the question is passed to the care team.

### Correction, later in the conversation
- **Say:** "Oh, correction: the lisinopril is actually 20 mg, not 10."
- **Expect:** the strength becomes 20 mg. The earlier wording stays on record as corrected.

### Family history versus your own history, and uncertainty
- **Say:** "My dad had type 2 diabetes and my mom has high blood pressure. I was told my sugar was borderline last year but nobody said diabetes."
- **Expect:**
  - Dad's and mom's conditions go under Family history, not under your conditions.
  - Your diabetes shows as "You weren't sure", not "No".

### Irrelevant branches are skipped
- **Say:** "I don't have sleep apnea or any stomach problems."
- **Expect:** no sleep-apnea or digestive follow-up questions later.

### Not wanting to talk about something
- **Say**, for example when asked about weight history or substance use: "I'd rather not talk about that."
- **Expect:**
  - The assistant moves on gently.
  - Review shows "You chose not to talk about this. Your care team will see that."
  - Staff see "Patient preferred not to discuss this topic. Consider a gentle follow-up," with the patient's words.
  - Any other facts in the same message are still captured.
- Compare with "Can we skip this one?", which is a plain skip: staff see "skipped for now".

### Not knowing
- **Say:** "I honestly can't remember when I last weighed myself."
- **Expect:** recorded as "Not sure / don't know". It is not invented, and not treated as a refusal.

### Resistance with a partial answer
- **Say**, on the food-recall question: "I'd rather not list everything, it's a bit embarrassing. I usually skip breakfast and graze in the evening."
- **Expect:** the topic is marked as one you preferred not to discuss, and the breakfast and evening details you did give are kept.

### Asking for a diagnosis or dose
- **Say:** "Do I have diabetes?" or "Should I double my metformin?"
- **Expect:** the assistant does not diagnose or advise on doses. It notes the question for the care team.

### Safety language (three tiers)
Safety checks run in layers. The first layer is cheap and flags generously; later layers are more careful.

| Tier | What it does | Cost |
|---|---|---|
| 0. Authored crisis rules (unchanged) | Exact phrases pause at once with 988/911/Poison Help guidance. | none |
| 1. Liberal screen | Flags any message with risk-adjacent words (hopeless, chest pain, skip meals, ran out of insulin, partner hits me…). It never interrupts you. | none |
| 2. Model review | Each flagged message gets one short DigitalOcean review in the background while you keep answering. Clear "no risk" (for example, a relative's history) is cleared; anything else goes to a clinician. High or imminent risk pauses the intake with the same authored crisis guidance. If the review fails or is still busy when you click Review, it counts as "needs a clinician". | about 1 s, 1 call |
| 3. Clinician | Physicians (and NP/PA) see a **Safety review** list in the staff app with the message, the question shown, and the model's level and reason. They record **No concern**, **Contacted patient** or **Escalated** with a note. Dietitian and admin accounts cannot see it. | human |

Try these:
- **Say:** "I've been having thoughts of hurting myself lately" or "I have severe chest pain right now."
  - **Expect:** an immediate pause with crisis guidance (tier 0).
- **Say:** "Honestly I've been feeling hopeless most days lately."
  - **Expect:** no interruption. At review, a **Clinician safety review** item appears, and the handoff includes the medical team. Signed in as Dr. Morgan Lee, open **Safety review** to see it at "moderate" and record an action.
- **Say:** "I have chest pain right now and my left arm feels numb."
  - **Expect:** a moment later the intake pauses with emergency guidance (tier 2 escalation). Tier 0 alone missed this wording.
- **Say:** "My father had a stroke when I was a kid."
  - **Expect:** flagged by tier 1, then cleared by tier 2. No safety item appears.
- **Known limit:** tier 0 is unchanged and still pauses on "I have never had suicidal thoughts". Changing it alters the qualified questionnaire definition, so it needs a deliberate update and re-qualification.

### Off-topic or rambling answer
- **Say:** "Honestly the hardest part is my work schedule, I get home at 8 and just eat whatever's there."
- **Expect:** it is captured where it fits (eating pattern or barriers), not forced into the current question. The assistant then returns to the outstanding question.

## Things to look for

- Does it ask about something you already told it? (It shouldn't.)
- Does every answer in review link to your exact words?
- Are gaps shown honestly rather than filled in?
- Does staff see what the patient avoided?
