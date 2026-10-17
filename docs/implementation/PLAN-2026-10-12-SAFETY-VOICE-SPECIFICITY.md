# Plan: safety gate, voice robustness, and answer specificity

Status: **approved 2026-10-12** (decisions recorded in §5; D2 changed by the reviewer, see §2 V2). Synthetic demo only; no HIPAA claims.

Progress (2026-10-12):
- **P1 (safety): done**, commit 65f053f.
- **P2 (voice V1): done**, commit 91868c9.
- **P3a + P3b (specificity): done in one pass.** All 22 contracts across Q02–Q19 shipped together.
  - **Source change, for a public repository:**
    - RxClass classes are not used, because D6 needs no classes. ATC, one of the RxClass sources, also carries WHO licence limits.
    - The Clinical Tables conditions list is not used, because it has no explicit redistribution grant.
    - Conditions are instead our own authored terms, validated against CMS ICD-10-CM. See `packages/clinic-reference/SOURCES.md`.
  - **Gate:**
    - 344-answer deterministic corpus. Vague recall must be at least 95%, and needless follow-ups at most 5%.
    - Two holdouts were labelled before running. The first scored 31/40 and drove general lexicon rules. The second scored 45/47 (95.7%) on first run.
    - 6 bounded live interpreter calls (qwen3.8-max). They found and fixed two real defects: a named reply raised a conflict, and "I'll bring the bottle" was marked unresolved.
- **Independent review of P1–P3 (2026-10-13):** Codex (gpt-6.1-sol, xhigh) on each commit, and cubic on PR #8. Every valid finding is fixed with a regression test that fails on the old code. Main fixes:
  - **Safety gate:**
    - A reviewer failure on an unflagged turn now goes to clinician review.
    - Gate verdicts apply after a cancelled interpretation, after a resumed eating-concern notice, to spoken replies on fixed-choice items, and on the grouped and stream paths.
    - Floor: "odd" no longer matches "OD'd". "Pain was severe" is past and goes to the model. "I told my husband about my suicidal thoughts" now pauses. Line breaks end a clause.
  - **Specificity:**
    - A qualified "yes" never confirms.
    - Codes and settled notes are bound to the exact answer.
    - Vague answers stay partial on the native final-review path too.
    - Spelling checks count toward the topic budget.
    - Numbers count only with their unit of time.
    - A time answer must mention a time.
    - Condition terms CT-0.3 code nothing more specific than the patient's words.
    - Native definition bumped to `CC-0.2.phq4.native-5`.
  - **Voice:**
    - Retrying never overwrites typed words.
    - No upload starts after a discard.
    - Send stays off while a recording is kept.
    - A corrected unit replaces the superseded one.
    - Ordinary "wait" or "sorry" is not a correction.
  - **Deferred, with reasons:**
    - Binding safety-corpus recordings to full-message hashes is gate hygiene for the next safety change.
    - The fail-closed banner staying visible is accurate (the message was flagged).
    - A queue-test timer is a test-only flake risk.
    - With no reviewer configured at all, the floor and screen are the documented fallback.
- **Codex re-review of 7da5d98:** six findings, all fixed with tests that fail on 7da5d98:
  - A current "pain was severe … still is now" pauses again.
  - Structured guided field answers are gated.
  - The stream path publishes its early reply only after the gate.
  - A first-person statement isn't scoped as media.
  - A follow-up reply that also states a new fact keeps it.
  - Settling never brings back an earlier value's code.
  - Known gap: the native final-review completeness override has no automated test. The test fixtures cannot bind a representation authority for a full first intake. It shares the same `specificityIncomplete` check as the guided path, which is tested.
- **cubic second pass (2026-10-13):** 28 findings on 533b3f8; valid ones fixed:
  - A safety verdict that can't be saved is never dropped: the signal stays open and the request returns 503 so the client retries.
  - Grouped and stream replies are gated before anything runs.
  - A follow-up settles only when the whole reply is a terminal answer; a plain "No" settles as unknown.
  - "2x" needs an interval; "after" alone isn't a time; a vague answer keeps the native response `stopped`.
  - A medicine's purpose ("heart meds", "arthritis meds") is never read as a reported condition.
  - Optional detail probes can't be nominated ahead of a required question.
- **P4 (voice V2 hands-free): code complete (2026-10-13).**
  - The browser streams mic audio straight to Deepgram live (`nova-3-medical`). It uses a 30 s token minted per utterance at `POST /api/clinic/speech/tokens`. The server never relays audio.
  - Each mint reserves against the Deepgram budget ledger (59 s stream bound). Refused when paused, confirmed, stale, buttons-only (PHQ-4 and exact-choice items), or over budget (429).
  - Fallback to push-to-talk on a server, network or socket failure. A refusal is not a fallback.
  - Read-aloud: browser voice by default. Optional ElevenLabs Flash via `POST /api/clinic/speech/output`, authored prompts only, same ledger.
  - Verified: suites green (foundation 1849, clinic 230, hosting 28). Live, the exact streaming URL transcribed a self-correction clip as one utterance. A live browser token refusal fell back to push-to-talk, and dictation filled the box.
  - The Deepgram token grant needs a Member-role key; the hosted `DEEPGRAM_API_KEY` must be that key.
  - **Known limit:** a token is checked only when the socket opens, so the server cannot cut a stream mid-utterance. The browser enforces the 59 s cap. The server bounds exposure by bounding the number of tokens.
  - Codex review of c6f04c4: three findings fixed with failing-first tests (token re-checked after admission and before release; a cancel during admission never reaches Deepgram; a spoken "pause" is removed from the draft).
  - **Member-role key installed 2026-10-13. Live browser run against Deepgram (synthetic speech through a fake microphone):**
    - 14 consecutive hands-free turns, one token each, no errors; the intake moved through 7 questions.
    - Barge-in: speech during read-aloud stopped it within 0.5 s.
    - "Stop." paused voice, saved nothing and left the answer box empty.
    - The first run cut "ten milligrams, uh, [1.2 s] no wait, twenty milligrams" into two turns. Fixes, per the voice article review: Deepgram endpointing 800 ms with filler words kept; grace 1.0 s, or 2.5 s after a filler, correction cue or amount; a **Done speaking** button. Rerun: one turn, 3 of 3.
  - Not yet verified: the hosted deploy (P5).
- **P5: deployed 2026-10-14 (stage8).** native-5 published and qualified (39 checks, expires 2026-10-21); hosted hands-free verified. Details in `OPUS-HANDOFF.md`.
- **Earlier P5 note:** Voice article review triage: `VOICE-ARTICLE-REVIEW-2026-10-12.md`.
Constraints carried forward:
- Reasoning runs on DigitalOcean inference only.
- Authored questions only; the agent never writes clinical wording.
- Incomplete stays incomplete.
- No diagnosis, eligibility or dose advice.
- Commit with explicit pathspecs.
- Haiku subagents for bounded tasks.

---

## 0. Where we are (verified in code, 2026-10-12)

**Safety.** Tier 0 is a regex list (E-0.1) that both *detects* and *decides*. It pauses on "I have never had suicidal thoughts" and misses "chest pain right now and my left arm feels numb". Each fix is a new regex, which is whack-a-mole. It is hashed into the questionnaire definition digest, so every change needs re-qualification. Tiers 1–3 (liberal screen → background model review → clinician queue) work, but tier 2 runs *after* the turn, so an urgent message tier 0 missed is only paused about 1 s later.

**Voice.**

| | Hosted (upload / push-to-talk) | Local (stream) |
|---|---|---|
| Barge-in | Recording stops read-aloud, and so does a local voice-level detector. | Real barge-in (Deepgram `SpeechStarted` plus local detector), with hands-free turn-taking. |
| Turn-taking | None. You press Finish. | Endpointing 500 ms + 600 ms grace. |
| Stop, page hidden, mic lost, question changed | **Every recorded word is lost.** The buffer is cleared and the upload aborted (`upload-socket.ts:52-53`). | Words so far are kept as an unsent draft. |
| Network error during transcription | **Recording lost**; no retry. | Partial transcript kept. |
| "Listen to question" during a recording | **Not disabled**, so it can be recorded (`VoiceControls.tsx:20`). | Same. |
| 60 s cap | Possible race: the transport throws `voice-limit` before `finish()` and drops the clip (`voice-capture.ts:77`). | Same code path. |
| Self-correction ("500 mg, no wait, 850 mg") | Saved as **"500 mg; 850 mg"**. Two values in one message are joined (`intake-interpreter.ts:579-580`). | Same; a pause mid-correction can also end the turn early. |

**Vague answers.** "I take a couple of pills for my heart in the morning, and arthritis meds at night":
- Can create medicine items with **no name**. Nothing stops "pills for my heart" being recorded *as* a name.
- `/\bheart\b/` can mark the patient as having heart disease, and "arthritis" as a joint condition, from medication context. That breaks the "never presume diagnosis from medication" rule.
- Both items get the **same generic, unanchored** label prompt (B02).
- Readiness is presence-only: any non-empty text counts as answered, and there is no "not specific enough" state.
- No per-item probe budget exists; the only limit is two unsuccessful turns, then "move on or come back".
- There is **no reference vocabulary** in the repo, and the DigitalOcean client **cannot do tool calling**: messages + `response_format` only.

---

## 1. Safety: replace "regex decides" with a tested safety gate

### Recommendation
Stop patching phrases. Split *detection* from *decision* and judge decisions against a labelled test corpus, not one-off reports.

1. **Hard-stop floor (deterministic, tiny).** Keep a short list of unambiguous, current, first-person emergencies ("I'm going to kill myself", "I can't breathe", "I took too many pills"). These pause instantly even if every model is down.
   - Add **attribution and negation scoping** (a NegEx-style window: negation cue, other subject, historical or hypothetical marker). It may *downgrade* a hard-stop to "model decides". It never clears a message by itself.
2. **Synchronous safety classification on the turn.** When tier 1 or the floor flags a message, call the safety classifier *in parallel with the interpreter* (both about 1–3 s). The next question is not shown until both finish, so latency is unchanged.
   - **Imminent or high:** pause with authored copy (E01–E05).
   - **Moderate or low:** continue, and queue for clinician review (today's tier 3).
   - **None:** cleared and audited.
3. **Fail-safe policy.**
   - Classifier timeout or invalid output on a *self-harm* or *medical-urgent* flag: show a non-blocking authored help banner (988 / 911 / Poison Help), keep going, and send the message to clinician review.
   - Hard-stops still pause.
   - Nothing fails silently to "clear".
4. **A safety corpus as the acceptance gate.** About 300 synthetic utterances, versioned in the repo, with expected outcomes. They cover:
   - direct statements and paraphrase;
   - slang and typos;
   - negation, historical, family or other-person, hypothetical and quoted;
   - questions about the topic ("is it normal to feel hopeless?");
   - mixed messages (a real answer plus a risk phrase);
   - speech-to-text artefacts.

   Gates:
   - **Offline:** every must-pause item pauses through floor + recorded classifier outputs, and false pauses on the negation and family sets stay at or below a target (proposed 2%).
   - **Live:** run the corpus against DigitalOcean (about 300 short calls, about $1). Re-run whenever the prompt, model or floor changes.
   - New reports become corpus rows *first*, then fixes. That ends whack-a-mole.
5. **Definition versioning.** E-0.2 pins the authored copy, the floor list, the classifier protocol id and the corpus digest into the questionnaire definition. **This is a deliberate re-qualification (decision D1).** After it, routine classifier prompt tuning only changes the corpus-gated protocol id, not the questionnaire digest.

Tier 2 stays as it is for non-urgent categories; the urgent categories move onto the synchronous path. Tier 3 is unchanged.

**Why not only a bigger model or only better regex?** Regex can't handle paraphrase or negation. A model alone has no deterministic floor when it is slow or down. The combination, measured on a corpus, gives both recall and an audit trail. Published work points the same way: negation-aware handling cuts keyword false positives, and context-aware models cut misses (Gkotsis 2016; Broadbent 2023).

**Acceptance.**
- Corpus gates pass.
- "never had suicidal thoughts" → cleared, no pause.
- "chest pain right now, arm numb" → paused before the next question.
- The hard-stop floor works with the model disabled.

**Size:** M. **DigitalOcean:** about 300 calls for corpus runs, plus 1 per flagged turn.

---

## 2. Voice: make interruptions safe, then decide on hands-free

### V1: upload-mode robustness (small; no new infrastructure)
- **Never discard speech by accident.**
  - Stop, page hidden, mic lost and question changed: transcribe what was recorded and put it in the box as an *unsent* draft with an honest notice.
  - Only an explicit **Discard recording** throws audio away.
- **One automatic retry** of a failed transcription, from the retained buffer, under a new admission attempt id. After that, keep the buffer and offer "Try again". Release it when the patient sends, discards or leaves.
- **Cap race:** end the recording at 59 s with a gentle notice, before the transport's limit can drop it.
- **No talking over a recording:** disable "Listen to question" while recording. Read-aloud already yields.
- **Self-correction in one message:**
  - The interpreter treats an in-message correction cue ("no wait", "I mean", "actually", "sorry, it's") as **replacing** the earlier value.
  - Both are kept as provenance; the earlier value is marked superseded in the same source.
  - This applies to text too, not only voice.
- **Honest copy:** fix "Your transcript remains unsent" where no transcript exists.
- **Tests:** a fake media source (the seam already exists) plus synthetic audio (macOS `say` clips) for stop, hide, question change, network failure, the cap and barge-in.

### V2: hands-free conversation on hosted (decision D2: **no new hosting cost**)
The reviewer ruled out a paid relay container. Hands-free uses only existing vendors:

- **The browser streams straight to Deepgram live** (`wss://api.deepgram.com/v1/listen`, `nova-3-medical`, endpointing, `SpeechStarted` for barge-in), authenticated with a **short-lived Deepgram token** minted per utterance by the Vercel API (`POST /api/clinic/speech/tokens`, Deepgram `/v1/auth/grant`, TTL ≤ 30 s).
- **Server-side budget instead of a relay:** each token mint is an admission reservation under the existing per-session and account Deepgram limits (requests, seconds). The server refuses tokens when the session is paused, confirmed, on a buttons-only item (PHQ-4, exact choices), or over budget.
- **Known limit, stated honestly:** a token is only checked when the socket opens, so the server cannot cut a stream mid-utterance. The client enforces the 59 s cap and closes the socket; the server bounds the number of tokens and therefore the exposure. Transcripts reach our server only as the patient's submitted turn, as today.
- Same turn semantics as local stream mode: auto-submit of clean turns after endpointing + grace, a longer grace after a correction cue or filler ("um", "wait", "I mean"), "stop"/"wait" pauses listening, and barge-in stops read-aloud.
- **Fallback:** push-to-talk (V1) stays available and is used automatically if token minting or the socket fails.
- Vapi was considered and not chosen: it would replace our interpreter and authored dialogue with its own agent loop.

**Text-to-speech (D3).** Browser `speechSynthesis` by default. Optional ElevenLabs Flash via a budgeted HTTP route (`POST /api/clinic/speech/read-aloud`) that only voices the **current authored prompt** (looked up server-side by prompt id; no arbitrary text), so it cannot be used as a general TTS proxy.

**Acceptance (V2).**
- A hosted hands-free intake of 10+ turns with barge-in.
- A self-correction pause doesn't cut the turn.
- Token minting refuses paused, buttons-only and over-budget requests.
- Disconnects keep the draft; fallback to push-to-talk works.

**Size:** V1 S–M; V2 M. No new monthly cost; Deepgram and ElevenLabs usage comes from existing credits within the admission limits.

---

## 3. Answer specificity: one mechanism for every question

### The problem, generalised
Many intake fields can get a real but non-specific answer. The patient said something important, but not enough to act on. Today every non-empty answer counts as done. The same failure shows up across the intake:

| Topic | Vague answer | What's missing | Kind of specificity |
|---|---|---|---|
| Medicines (Q08) | "a couple of pills for my heart" | identity, how many, strength | entity identity + count |
| Supplements | "some vitamins" | which ones | entity identity |
| Conditions (Q06) | "heart problems", "sugar issues", "thyroid thing" | which condition, diagnosed vs suspected | entity identity + status |
| Surgery / hospital (Q07) | "had something done on my stomach a while back" | which procedure, when | entity identity + time anchor |
| Allergies | "allergic to some antibiotic, it made me sick" | which agent, what reaction | entity identity + reaction |
| Family history (Q10) | "heart stuff runs in my family" | which condition, which relative | entity identity + relation |
| Symptoms (Q02) | "stomach issues lately" | what symptom, since when | category→detail + time |
| Weight history (Q03/Q04) | "a while ago", "around 200" | when, measured or estimated | time anchor + approximate quantity |
| Prior approaches (Q05) | "a shot from a clinic", "tried some diets" | which program or medicine, duration | entity identity + duration |
| Food recall (Q11) | "snacks", "a drink" | what, how much | category→detail + quantity |
| Activity (Q14) | "I walk sometimes" | how often, how long | frequency + duration |
| Substance use (Q17) | "I drink socially" | how often, how much | frequency + quantity |
| Sleep | "I don't sleep well" | which problem, how long | category→detail + duration |
| Care team | "my doctor" | name or practice | entity identity |

These reduce to **six kinds of specificity**:
- **entity identity** (medicine, condition, procedure, allergen, program);
- **category → detail**;
- **quantity** (numeric + unit, or labelled estimate);
- **frequency / duration**;
- **time anchor** (date, age, or relative to a stated anchor);
- **relation / attribution** (whose, which relative).

So we build **one specificity engine** and configure it per field, instead of patching each topic.

### 3.1 Specificity contracts (authored data, per field)
Each slot in `clinic-content` gains a contract, for example:
```
Q08.medicines[].name:   { kind: 'entity', domain: 'medication', sufficient: ['identified', 'patient-confirmed-match'],
                          terminal: ['unknown', 'declined', 'will-provide'], probeBudget: 2 }
Q08.medicines[].count:  { kind: 'quantity', unit: 'items', sufficient: ['numeric', 'labelled-estimate'] }
Q06.conditions[].term:  { kind: 'entity', domain: 'condition', alsoNeeds: ['status: diagnosed | suspected | told-borderline'] }
Q14.walking:            { kind: 'frequency+duration', sufficient: ['per-week', 'labelled-estimate'] }
```
Contracts are authored, reviewable and versioned. Because they change what counts as complete, they are **part of the questionnaire definition (D1, same re-qualification as safety)**.

### 3.2 Assessment: how specific is this answer?
Every recorded value gets a `specificity`:

| Value | Example |
|---|---|
| `specific` | resolved or numeric |
| `descriptive` | "pills for my heart": the patient described it but it isn't identified |
| `category` | "heart problems" |
| `approximate` | "around 200", "a couple" |
| `unanchored` | "a while ago" |
| terminal states | `unknown`, `declined`, `will-provide` ("I'll bring the bottles") |

It is assessed **deterministically first**:
- reference resolvers (3.3);
- vague-quantifier and class-word lists ("a couple", "some", "sometimes", "pills", "meds", "stuff", "issues", "thing", "problem");
- existing parsers (heights, weights, dates).

The model may *propose* a specificity, but the server validates it: the model can't claim `specific` without a resolver match or a number.

**Nothing the patient said is discarded.** "pills for my heart" is kept verbatim as the item's description, not as its name. And "heart" in a medication context no longer marks heart disease; the condition guard requires condition wording.

### 3.3 Reference resolvers ("tools")
> **Superseded in part (see Progress above and `packages/clinic-reference/SOURCES.md`):** RxClass classes, the lay-class map and the Clinical Tables conditions list were not used. Conditions are authored terms validated against CMS ICD-10-CM. The table below is the original proposal.

These are local, offline, deterministic indexes, built from free sources by a build script and bundled with the server. **No runtime calls to outside services.** That keeps latency at 0 and sends no patient text off-platform; NLM's Clinical Tables terms forbid PHI in requests anyway.

| Domain | Source (free) | What we use |
|---|---|---|
| Medications | [RxNorm Current Prescribable Content](https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html): **no UMLS license required** | ingredient, brand, synonym and strength names → RxCUI |
| Drug classes | [RxClass API](https://rxnav.nlm.nih.gov/RxClassAPIs.html), no license | precomputed at build time: ingredient → pharmacologic class (e.g. beta blocker, diuretic), for lay terms |
| Lay medication terms | authored map | "water pill" → diuretic class; "blood thinner"; "heart pills" → cardiovascular. Used only to *understand*, never to suggest a drug. |
| Conditions | [NLM Clinical Tables "conditions"](https://clinicaltables.nlm.nih.gov/apidoc/conditions/v3/doc.html): about 2,400 consumer-friendly names, synonyms, suggested ICD-10-CM codes; JSON download | consumer name ↔ ICD-10-CM suggestions |
| ICD-10-CM codes | [CMS ICD-10-CM code files](https://www.cms.gov/medicare/coding-billing/ICD-10-codes) (FY2026/27) | code validation and display text |
| Allergens | RxNorm index (drug allergens) + authored food/environment list | |
| Procedures | Clinical Tables procedures table (to verify in Phase 0) or an authored lay list | |

The resolver interface is `resolve(domain, text) → { matches: [{ system, code, display, kind: exact|synonym|spelling|class }], ambiguous }`. Phase 0 verifies each source's current terms and release before we build.

**Is there a free ICD-10 lookup?** Yes: the NLM Clinical Tables ICD-10-CM and conditions APIs, plus CMS's downloadable code files. We'd build a local index from the downloads rather than call the API at runtime.

**How the agent uses them.** The DigitalOcean client has no tool calling, and a function-calling loop would add model round trips. So it's **retrieve-then-interpret** (one model call):
1. **Before the call:** the server scans the patient message against the indexes and adds a compact REFERENCE block to the interpreter prompt ("'metoprolol' = medication ingredient; 'arthritis' = condition; 'heart pills' = lay class term, not a name").
2. **After the call:** every proposed fact is re-validated against the resolvers.

Real tool calling stays possible later if needed (D5).

### 3.4 Follow-ups
- **Authored templates per (specificity kind × gap)**, anchored with the patient's *own quoted words*, which keeps today's "no model-written clinical wording" rule:
  - *Identity:* "You mentioned «a couple of pills for your heart» in the morning. Do you know their names? They're printed on the bottle label. It's fine to say you don't know."
  - *Count:* "How many different heart medicines is that?"
  - *Category → detail:* "You said «stomach issues». What happens: pain, heartburn, nausea, or something else?"
  - *Time anchor:* "Roughly when was that: a year, or how old were you?"
  - *Frequency:* "About how many days a week do you walk, and for how long?"
- **Did-you-mean is limited to spelling.** We only confirm a resolver match for the patient's *own* string ("Did you mean metoprolol?" for "metroprolol"). We **never** suggest drugs or conditions from a class ("Is it lisinopril?"), because that leads the patient (D6).
- **Budget and courtesy.**
  - At most 2 probes per field group per item and 4 per topic. Then record it as `descriptive` and move on.
  - "I don't know", "I'll bring them" and "not sure" are terminal and respected.
  - Several vague items are probed **one at a time, each anchored** (fixes today's identical B02 probes).
- **Ordering:** at most one specificity probe per turn, and only after the authored core question for the topic is covered. That way it won't derail the flow.

### 3.5 Recording and handoff
- Each item keeps:
  - `description` (patient's words);
  - `identity` (confirmed normalised name, if any);
  - `candidates` (resolver suggestions, labelled *"suggested match, not confirmed by patient"*);
  - `specificity`;
  - codes (RxCUI / ICD-10-CM) **only when confirmed or an exact match**.
- Readiness: `descriptive`, `category` and `unanchored` count as **"needs detail"**, not complete. A terminal state counts as answered-unknown. Incomplete stays incomplete.
- Staff view shows "Patient described: «pills for my heart» · not identified · ask at visit / bring bottles", plus any suggested codes clearly marked unverified.
- The native questionnaire capture gains coded answers (`valueCoding` only when confirmed; otherwise `valueString` + description). This is part of D1.

### 3.6 Evaluation (instead of whack-a-mole)
A **specificity corpus**: about 150 synthetic answers across every topic in the table above, each with the expected items, specificity and next probe. The gates:
- **Offline:** deterministic assessment and probe selection, with recorded model outputs.
- **Live:** budgeted DigitalOcean run (about 150 calls).
- **Scripted journey:** the "heart pills / arthritis meds" journey reaches named items or an honest `descriptive` after at most 2 probes each.

**Size:** L (the largest piece). **DigitalOcean:** about 150–300 calls of eval.

---

## 4. Phases and order

| Phase | Content | Size | Depends on |
|---|---|---|---|
| **P0** | Decisions D1–D6; verify source licences and releases; author both corpora (safety, specificity) | S | none |
| **P1** | Safety gate: floor + negation scope + synchronous classifier + fail-safe banner + corpus gates; E-0.2 definition | M | D1 |
| **P2** | Voice V1 robustness, including in-message self-correction | S–M | none |
| **P3a** | Specificity engine core: contracts, assessment, probe engine, budget, readiness, staff view. First with **medications + conditions**, plus resolver build scripts (RxNorm and CMS ICD-10-CM with authored condition terms; RxClass and Clinical Tables were dropped, see §3.3) | L | D1, D5, D6 |
| **P3b** | Extend contracts and probes to every other topic in §3 (allergies, procedures, family history, symptoms, prior approaches, food, activity, substances, sleep, care team, time/quantity) | M | P3a |
| **P4** | Voice V2 hands-free: browser → Deepgram live with server-minted short-lived tokens; optional ElevenLabs read-aloud of authored prompts (D3) | M | P2 |
| **P5** | Re-qualify, deploy stage8, live corpus runs, hosted journeys, docs | S | all |

Each phase ends with the full test suites green, `tsc` clean, a commit, a push to PR #7, and an updated `DEMO-TESTING-GUIDE.md`.

**Recommended order:** P0 → P1 → P2 → P3a → P3b → P4 → P5. Safety first because it carries the most risk; voice robustness next because it's small and removes data loss.

**Delegation:** Haiku agents for resolver build scripts, corpus authoring drafts (reviewed), voice V1 client fixes and UI. Root keeps contracts, the probe engine, the safety gate and definition versioning.

---

## 5. Decisions (recorded 2026-10-12)

| # | Question | Decision |
|---|---|---|
| **D1** | Re-qualify the questionnaire definition (E-0.2 safety + specificity contracts + coded answers)? | **Yes, once, bundled** (published in P5) |
| **D2** | Hands-free voice on hosted? | **Yes, with no additional cost:** existing vendors only (Deepgram live with short-lived tokens). No App Platform relay. |
| **D3** | Read-aloud voice | **Browser by default, ElevenLabs optional** |
| **D4** | Spoken PHQ-4 answers in hands-free mode? | **No: buttons only** |
| **D5** | Retrieve-then-interpret vs tool calling | **Retrieve-then-interpret** |
| **D6** | "Did you mean…" scope | **Spelling variants of the patient's own words only**; no class-based suggestions |
| **D7** | Photo of a pill-bottle label | **Deferred** (P6) |

## Sources
- RxNorm Current Prescribable Content (no license): https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html
- RxClass API: https://rxnav.nlm.nih.gov/RxClassAPIs.html
- NLM Clinical Tables conditions API: https://clinicaltables.nlm.nih.gov/apidoc/conditions/v3/doc.html
- NLM Clinical Tables ICD-10-CM API: https://clinicaltables.nlm.nih.gov/apidoc/icd10cm/v3/doc.html
- NLM Clinical Tables RxTerms API: https://clinicaltables.nlm.nih.gov/apidoc/rxterms/v3/doc.html
- Clinical Tables FAQ (free; no PHI in requests; about 25 req/s): https://clinicaltables.nlm.nih.gov/faq.html
- CMS ICD-10 code files: https://www.cms.gov/medicare/coding-billing/ICD-10-codes
- Deepgram temporary tokens: https://developers.deepgram.com/guides/fundamentals/token-based-authentication
- Gkotsis et al. 2016, negation in suicide mentions: https://preview.aclanthology.org/fix_video/W16-0310.pdf
- Broadbent et al. 2023, crisis-text risk models: https://par.nsf.gov/biblio/10501428-machine-learning-approach-identifying-suicide-risk-among-text-based-crisis-counseling-encounters
