# Voice-agent article review (2026-10-12)

Source: "Where voice agents actually break" (The Nuanced Perspective, Substack). The review was done by a Haiku subagent from WebFetch plus the user's full-page screenshot. Triage is in the last section.

## Article claims (summary)

- A clean transcript can hide a wrong action: the caller corrects Tuesday to Thursday, but the tool still commits Tuesday.
- Quality has five dimensions: perception, turn-taking, latency, action and recovery.
- Three failure modes: disfluency at the tool boundary, self-correction during planning, and backchannel versus barge-in.
- Score the tool call by exact match, treat each real-time loop (one correlation ID) as the unit of quality, and use a release scorecard of non-compensable gates rather than one averaged score.
- Fixed silence thresholds (500–800 ms) misread pauses. Keep VAD as a streaming gate and add a context-aware turn model.
- WER misses meaning flips such as dropped negations.
- Irreversible actions need confirmation, server-side checks, idempotency and outcome verification. A partial utterance never authorizes one.

The article is about contact-center and booking agents. Clinical safety, medication names and crisis gating are our extrapolation.

## Findings applied to the clinic intake

| Finding | Applies? | Recommendation | Priority | Area |
|---|---|---|---|---|
| Partial speech must not drive a commit | V2 only. V1 transcribes after stop. | V2 interprets and writes only on final segments. Partials are display text. | P0 | ASR, recovery |
| Self-correction | Partly. V1 handles it within one message. | Add cases for corrections that arrive after the field is written. | P1 | Perception, eval |
| Negation and number flips invisible to WER | Yes. A dropped "not" or wrong dose is the core risk. | Gate on field-level exact match for negations, numbers and dose units. | P0 | ASR, safety |
| Non-compensable release gates | Yes. | Scorecard: crisis recall, numeric and negation exact match, no voice path into PHQ-4. Latency is informational. | P0 | Eval |
| Fixed silence endpointing | V2. | Conservative Deepgram endpointing, longer hold on numeric answers, Done button. No custom turn model. | P1 | Endpointing |
| Backchannel and barge-in | V2 read-aloud. | "mm-hmm" and "uh" do not end a turn. Any speech stops read-aloud. | P1 | Barge-in, TTS |
| Drug-name ASR accuracy | Not covered by the article. | Deepgram keyterm prompting from the patient's own named items plus common medicine names (verify the current parameter). Add a brand and generic test set. | P1 | ASR |
| Read-back before high-stakes writes | Partly. Our writes are editable before review. | Authored confirmation only: the P3a spelling confirmation and the review screen. | P1 | Action |
| Failure library to regression cases | Yes, synthetic only. | Every failure found becomes a corpus row. | P1 | Eval |
| Trace minimization and retention | Yes. | One correlation ID per answer. No raw audio in logs. Keep the existing retention. | P1 | Privacy |
| Latency percentiles | Partly. | Track stop-to-next-question p95. Never skip the safety gate for speed. | P2 | Latency |
| Bounded retry and honest status | Yes. Already done in V1. | Keep typing available whenever transcription fails. | P2 | Recovery |

## Deliberately not adopted

- **A context-aware turn model.** It needs new hosting (D2). Deepgram endpointing, push-to-talk fallback and a Done button are enough.
- **Model-chosen next questions or confirmation wording.** Questions stay authored, and confirmations use authored templates.
- **Prosody or mood inference.** PHQ-4 stays buttons-only (D4).
- **Confirming every field.** Only spelling confirmation and the review screen.
- **Always-on idle listening.** Hands-free listens only while a question is open and within budget.

## Triage into the plan

- **P3a (now):** the spelling-confirmation probe is the authored read-back for medicine and condition names. The specificity corpus gains negation and number cases ("not metformin anymore", "2.5 vs 25 mg").
- **P4:**
  - Interpret and write only on final segments.
  - The safety floor and gate run on final text. Partials are not screened, because the floor's negation scoping is unreliable on half-sentences. A final arrives within the endpoint window.
  - Conservative endpointing, with a longer hold after a numeric or medicine question. "Done" ends the turn immediately.
  - Backchannels don't end a turn; speech cancels read-aloud.
  - Keyterms come from the patient's own named medicines and conditions, plus a short list of common ones.
  - One correlation ID per answer, from token mint to transcript to turn.
- **P5:** the hosted voice run reports field exact match for numbers, negations and names separately from transcript similarity, and checks that no voice path reaches PHQ-4.
