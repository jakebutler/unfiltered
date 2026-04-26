Unfiltered update: refreshed evidence base + tighter UX framing (NN/g + recent studies)

Below is an updated, hackathon-ready plan that keeps your simple, rule-based transcript + timestamp approach, but strengthens the UX-methods grounding (NN/g, MeasuringU, GOV.UK) and adds more recent speech/disfluency literature (2022–2025+). I also adjusted a few thresholds and the scoring story to be more defensible in front of judges.

⸻

What I updated (based on your feedback)
	•	Added recent UX practitioner sources:
	•	NN/g explicitly recommends observing where users “stumble” and treating recurring confusion/hesitation around terms as a signal to simplify (great justification for your hesitation signals).  ￼
	•	NN/g: even “the slightest moment of hesitation” in forms can harm completion—useful for arguing why micro-friction matters.  ￼
	•	MeasuringU (Sauro/Lewis) compiles recent (2022+) evidence on think‑aloud, including how TA affects task time and what participants say when thinking aloud.  ￼
	•	GOV.UK guidance gives a clean, credible limitations section (social desirability, reliance on verbalization).  ￼
	•	Added newer speech/disfluency evidence supporting your proxies:
	•	Cognitive load ↔ increased hesitations (fillers + silences) in controlled settings.  ￼
	•	Modern overviews in NLP/speech note disfluency rates can increase with cognitive load and enumerate key disfluency types you can detect from transcripts (filled pauses, repetitions, revisions).  ￼
	•	A 2022 review paper explicitly links more fillers to moments requiring “unanticipated choices” (planning load) and ties disfluency type to planning processes.  ￼
	•	Strengthened the responsible interpretation:
	•	NN/g highlights moderator silence can be intentional and useful—so silence ≠ confusion by default.  ￼
	•	Pause perception effects depend on task framing (e.g., “fluency vs credibility” judgments), reinforcing that your signals are attention flags, not diagnoses.  ￼

⸻

Updated “behavioral friction” signal set (still lightweight, still rule-based)

You can keep the same overall shortlist (8–12). I’ll keep 12 because it covers your categories well, and I’ll update thresholds + caveats using newer sources where possible.

Category A — Hesitation / uncertainty

1) Filled pause rate (“uh/um/er”)

Definition
	•	Frequency of filled pauses; commonly associated with planning delays / retrieval difficulty. Recent sources note fillers are often produced before hard-to-retrieve words and signal upcoming delays.  ￼

Compute
	•	filled_pause_count = count(token in {"uh","um","er","erm","uhm","umm"} within window)
	•	fp_per_100w = 100 * filled_pause_count / max(1, word_count)

Thresholds (updated)
	•	A useful anchor: English-speaking adults produce “uh/um” roughly ~1 per 100 words on average (varies by context/speaker).  ￼
	•	Practical flags:
	•	Moderate: fp_per_100w ≥ 2
	•	High: fp_per_100w ≥ 4
	•	Better: robust z-score vs speaker baseline (see scoring).

UX meaning
	•	Candidate “planning / uncertainty” during navigation, decision points, comprehension of labels.

False positives / caveats
	•	Fillers vary with formality, bilingualism, age; don’t compare across people without normalization.  ￼

⸻

2) Hedge / tentativeness rate (“maybe”, “I think”, “kind of”)

Definition
	•	Tentative language that softens commitment; in UX sessions it often co-occurs with uncertainty about meaning or next action.

Compute
	•	Phrase match with a hedge lexicon (bigrams/trigrams):
	•	e.g., maybe, probably, I think, I guess, kind of, sort of, not really
	•	hedges_per_100w = 100 * hedge_count / max(1, word_count)

Thresholds
	•	Moderate: ≥ 3 / 100w
	•	High: ≥ 6 / 100w
	•	Or z ≥ 1.5

UX meaning
	•	Ambiguity / low confidence in interpretation (labels, system state, requirements).

Caveats
	•	Politeness/face-saving can inflate hedging (especially with moderators).

⸻

3) Explicit uncertainty statements (“I don’t know”, “not sure”)

Definition
	•	Direct admissions of uncertainty (often more diagnostic than hedges).

Compute
	•	Phrase match:
	•	i don't know, not sure, no idea, can't tell, i'm confused, i don't understand
	•	uncertainty_per_min = 60 * uncertainty_count / window_sec

Thresholds
	•	Any occurrence = highlight-worthy
	•	High: ≥ 2 occurrences within 60s around a step

UX meaning
	•	Strong signal of comprehension failure or missing information scent.

Caveats
	•	Sometimes reflects lack of domain knowledge rather than UI flaw (flag for review, not automatic blame).

⸻

4) Long silent pauses (gap-based)

Definition
	•	Long gaps between words (within-speaker). Pauses and disfluencies are commonly used indicators in cognitive-load research.  ￼

Compute
	•	For consecutive words same speaker: gap = start_i - end_(i-1)
	•	Count pauses above cutoffs:
	•	pause_count = count(gap ≥ 0.25s)
	•	long_pause_count = count(gap ≥ 1.5s)
	•	very_long_pause_count = count(gap ≥ 3.0s)
	•	pause_time_ratio = sum(gap where gap ≥ 0.25) / window_sec

Thresholds
	•	Long: ≥ 1.5s
	•	Very long: ≥ 3.0s
	•	Or “top 5% of that speaker’s gaps”

UX meaning
	•	Candidate “stuck / reading / searching / decision point” moments.

Caveats (updated UX framing)
	•	In moderated research, silence can be an intentional moderation technique to elicit deeper responses—so treat as candidate friction unless corroborated by other cues.  ￼
	•	Silent pause interpretation is task-dependent; pauses affect “fluency” perception differently than “credibility,” which reinforces context sensitivity.  ￼

⸻

Category B — Cognitive load / confusion

5) Self-repair / correction markers (“wait—no”, “I mean”, “actually”)

Definition
	•	User revises their utterance midstream (a classic marker of re-planning / mental model updating).

Compute
	•	Count repair markers:
	•	wait, no—wait, actually, I mean, sorry, let me rephrase
	•	repairs_per_100w = 100 * repair_count / max(1, word_count)

Thresholds
	•	Moderate: ≥ 1 / 100w
	•	High: ≥ 3 / 100w

UX meaning
	•	Often appears at IA/label mismatch points (“I thought this was settings—actually it’s profile”).

Caveats
	•	Normal in spontaneous speech; weight higher when clustered with long pauses / backtracking.

⸻

6) Repetition / false starts (“I I…”, “click click…”, restarts)

Definition
	•	Immediate repeats and restarts; modern NLP and speech work explicitly enumerates repetitions and revisions as key disfluency types.  ￼

Compute
	•	If token_i == token_(i-1) and (start_i - end_(i-1)) ≤ 0.3s → repetition
	•	repeat_per_100w = 100 * repeat_count / max(1, word_count)
	•	Optional: “cluster” if ≥2 repeats within 10s

Thresholds
	•	Moderate: ≥ 1 / 100w
	•	High: ≥ 3 / 100w

UX meaning
	•	“Spinning” while planning or recovering from error/disorientation.

Caveats
	•	Can be emphasis; filter patterns like “really really” if it creates noise.

⸻

7) Clarification / repair initiators (“what?”, “where is…?”, “can you repeat?”)

Definition
	•	Strong conversational signal of misunderstanding or missing reference.

Compute
	•	Phrase match:
	•	what do you mean, huh, sorry?, can you repeat, which one, where is, what was the task
	•	clarify_per_min = 60 * clarify_count / window_sec

Thresholds
	•	Any occurrence: highlight
	•	High: ≥ 2 within same task step

UX meaning
	•	Confusing instructions, jargon, unclear screen state, ambiguous options.

Caveats
	•	Audio issues in remote sessions can trigger “sorry?” (not product friction).

⸻

8) Response latency after moderator prompt (needs diarization)

Definition
	•	Moderator question end → user response start. Useful to detect planning load right after prompts.

Compute
	•	For each moderator turn end t_q_end, next user word start t_u_start:
	•	latency = t_u_start - t_q_end
	•	Attach latency to the first window of user response.

Thresholds
	•	Moderate: ≥ 1.0s
	•	High: ≥ 2.0s
	•	Severe: ≥ 4.0s

UX meaning
	•	Hard-to-answer questions, unclear task state, user searching silently.

Caveats (UX-methods)
	•	Moderator may intentionally pause/sit silently to encourage elaboration; interpret with caution.  ￼

⸻

Category C — Frustration / negative affect

9) Negative affect / complaint lexicon

Definition
	•	Detect explicit negative affect and “breakdown phrases” (“this doesn’t work”, “I’m stuck”, “frustrating”).

Compute
	•	Lexicon match:
	•	Affect: annoying, frustrating, hate, angry
	•	Failure: doesn't work, broken, stuck, won't let me, keeps, profanity (optional)
	•	neg_affect_per_100w = 100 * count / max(1, word_count)

Thresholds
	•	Any occurrence = highlight
	•	High: ≥ 2 occurrences within 60s or neg_affect_per_100w ≥ 2

UX meaning
	•	Often the highest-signal moments for findings (errors, blocked goals).

Caveats (updated)
	•	NN/g’s negativity bias suggests negative moments weigh more in perception/memory—this supports giving negative affect higher weight in scoring.  ￼
	•	But NN/g’s aesthetic–usability effect warns users can struggle yet still praise appearance; don’t rely only on negative wording.  ￼

⸻

Category D — Confidence / clarity

10) Clarity & commitment index (confirmations – hedges)

Definition
	•	A counterweight signal so you don’t flag every think-pause as friction.

Compute
	•	confirm_count (e.g., got it, makes sense, I see, okay)
	•	certainty_count (e.g., definitely, exactly, clearly)
	•	clarity_index = (confirm_count + certainty_count) - hedge_count
	•	Normalize: clarity_per_100w = 100 * clarity_index / max(1, word_count)

Thresholds
	•	High clarity: clarity_index ≥ +2 (15s window)
	•	Low clarity: clarity_index ≤ -2

UX meaning
	•	Identifies “smooth” segments and prevents over-alerting.

Caveats
	•	“Okay” can be politeness; use in combination with whether they proceed smoothly (drop in backtracking/repeats).

⸻

Category E — Task flow breakdowns

11) Backtracking / reversal markers (“go back”, “undo”, “start over”)

Definition
	•	Explicit “reverse course” language; strong indicator of navigation confusion or wrong path.

Compute
	•	backtrack_count = count(matches in {"back","go back","undo","cancel","start over","try again"})
	•	backtrack_per_min = 60 * backtrack_count / window_sec

Thresholds
	•	Any occurrence = highlight
	•	High: ≥ 2 within 60s

UX meaning
	•	IA mismatch, unclear paths, “I ended up somewhere unexpected.”

Caveats
	•	Some flows legitimately require back navigation; cross-reference the task.

⸻

12) Repeated attempt loop (“click/submit” repeated; “keeps…”)

Definition
	•	User repeatedly attempts the same operation / target in a short span (often due to missing feedback, unresponsive UI, or unclear success state).

Compute
	•	Action verb lexicon: click, tap, press, submit, open, select, scroll, search, type
	•	Count repeats:
	•	repeat_attempt_count = count(action repeats within ≤ 10–20s)
	•	Optional: add “keeps”/“again” intensifiers:
	•	loop_intensifier = count({"again","still","keeps","won't","not working"})

Thresholds
	•	Moderate: repeats ≥ 2 within 15s
	•	High: repeats ≥ 3 within 30s

UX meaning
	•	Classic “feedback/system status” issue; strong candidate for actionable recommendations.

Caveats
	•	Narration of routine steps can look like repeats; require co-occurrence with pauses/repairs/neg affect to “upgrade” severity.

⸻

Updated scoring approach (with NN/g-friendly “peaks” story)

1) Keep robust within-speaker normalization
	•	Use per-window rates (per 100 words / per minute) + robust z-score:
	•	z = (x - median) / (MAD + ε)
	•	This is critical because filler and pause rates vary by person and context (formality, bilingualism, etc.).  ￼

2) Friction per moment (window)
	•	friction_raw = Σ w_i * z_i  +  w_clarity * (-z_clarity)
	•	Example weights (simple + defensible):
	•	Hesitation + confusion signals: 1.0
	•	Repeated attempt loop / backtracking: 1.2
	•	Negative affect: 1.3 (negativity bias rationale)  ￼
	•	Clarity: 0.7 (reduces false positives)
	•	Convert to 0–100:
	•	friction_0_100 = 100 * sigmoid(friction_raw)

3) Session scoring: add a “peak-end” summary that judges recognize

NN/g notes that moments of confusion and frustration act as emotionally charged “peaks” and strongly shape remembered impressions (peak–end rule).  ￼

So report:
	•	avg_friction
	•	peak_friction (max)
	•	time_in_high_friction_pct (windows ≥ 75)
	•	Optional “end friction”: average of last 60s windows (if your session has wrap-up tasks)

A judge-friendly composite:
	•	session_friction = 0.45*avg + 0.35*peak + 0.20*time_in_high_friction_pct
	•	If you have task segmentation: compute per task and rank tasks by peak friction.

⸻

Updated mapping: signals → UX findings (now explicitly aligned to NN/g language)

NN/g explicitly tells practitioners: watch where users “stumble,” and if you see patterns of confusion/hesitation around terms, that’s a signal to simplify copy.  ￼
You can position Unfiltered as “automating the spotting of stumbles.”

Copy / terminology unclear (forms, onboarding, settings)
	•	Pattern: High hedges + explicit uncertainty + clarification requests, clustered around the same label/instruction
	•	Finding: “Term/label isn’t in the user’s language.”
	•	Recommendation: rewrite in plain language, reduce jargon; test again.
	•	Support: NN/g recommends observing stumbles and simplifying when confusion/hesitation clusters around terms.  ￼

Micro-hesitation in forms = conversion risk
	•	Pattern: Short but frequent long pauses + hedges while filling form fields
	•	Finding: “Field meaning/format not obvious; users hesitate.”
	•	Recommendation: clearer labels, examples, grouping/spacing, mark optional fields.
	•	Support: NN/g: even slight hesitation can hurt form completion rates.  ￼

Discoverability / hidden navigation
	•	Pattern: Long pauses + “where is…” + backtracking, especially when navigating menus
	•	Finding: “Control not discoverable; information scent weak.”
	•	Recommendation: expose primary navigation, reduce hidden/ambiguous menus.
	•	Support: NN/g reports hidden navigation (e.g., hamburger menus) reduces discoverability and increases task time/difficulty.  ￼

Feedback / system status unclear
	•	Pattern: Repeated attempt loop + “did that work?” + pauses / repairs
	•	Finding: “System status not visible; unclear whether action succeeded.”
	•	Recommendation: immediate feedback, disable buttons after click, confirmations.

“Looks nice but it didn’t work” risk
	•	Pattern: High friction (pauses/backtracking/loops) but low negative affect and/or positive aesthetic comments
	•	Finding: Users may underreport usability problems because aesthetics dominate their reflections.
	•	Recommendation: rely on behavioral markers + task outcomes, not only self-report.
	•	Support: NN/g describes this usability-testing challenge under the aesthetic–usability effect.  ￼

Script/task wording issues (not product)
	•	Pattern: Clarification requests right after moderator reads task; long latency; user repeats “what am I supposed to do?”
	•	Finding: “Task prompt wording may be confusing or priming behavior.”
	•	Recommendation: rewrite tasks; ensure realism and neutrality.
	•	Support: NN/g notes task wording is important and small phrasing errors can cause misunderstanding or influence performance.  ￼

⸻

Evidence base (updated “reference pack” for judges)

If you want a tight slide: pick ~8–10 and label them “UX methods” vs “speech/disfluency foundations.”

UX / practitioner-methods sources
	•	NN/g: cognitive-load in forms; watch where users “stumble,” confusion/hesitation patterns → simplify.  ￼
	•	NN/g: even slight hesitation in forms can harm completion (micro-friction matters).  ￼
	•	NN/g: intentional silence is a moderation technique (silence ≠ confusion by default).  ￼
	•	MeasuringU (2024): summary of latest think‑aloud research (high credibility practitioner research).  ￼
	•	MeasuringU (2022): TA impacts task time in remote studies (method affects behavior; normalize and interpret carefully).  ￼
	•	GOV.UK (2021): clear limitations—think aloud relies on verbalization; social desirability can distort results.  ￼
	•	NN/g: peak–end rule—confusion/frustration peaks shape memory (supports your “highlight peaks” approach).  ￼

More recent speech/disfluency research supporting your proxies
	•	Betz et al. (2023, MDPI): hesitation frequency increases with cognitive load (fillers + silences).  ￼
	•	Dinkar et al. (2022, ACL/TAL): disfluent speech may result from cognitive load; more fillers when making unanticipated choices.  ￼
	•	Romana et al. (2023, Microsoft): disfluency rates may increase with cognitive load; key types include filled pauses, repetitions, revisions.  ￼
	•	(Optional “state of the art HCI”): PointAloud (CHI 2026 accepted) frames think‑aloud during software tasks as capturing intentions/struggles and notes practical challenges in eliciting verbalization.  ￼

⸻

Minimal spec tweaks (to better match usability interview reality)

Keep your schema, but add task/prompt context so you can say “friction spike during onboarding step 2” (judges love traceability):

Add to each event/window:
	•	task_id / task_label (if you have it)
	•	prompt_type: "moderator_question" | "user_action" | "system_error" | "free_explore"
	•	context_hint: optional string (e.g., “signup form”, “nav menu”, “pricing page”)

Also add a flags array:
	•	"candidate_moderator_silence" if the preceding speaker is moderator and there’s a long gap (to avoid misattribution). This is justified by NN/g’s intentional silence technique.  ￼

⸻

How to describe this responsibly (updated wording you can reuse)
	•	Augmentation, not replacement: “Unfiltered surfaces candidate friction moments so researchers can review clips faster; it doesn’t replace qualitative analysis.”
	•	Method-aware: Think‑aloud is valuable but imperfect; it relies on verbalization and can be distorted by social desirability, so we interpret these as probabilistic markers.  ￼
	•	Context-sensitive: Silence can be a moderation tool, and pauses can reflect reading or interaction—not always confusion—so we use multi-signal corroboration.  ￼
	•	Peak-first reporting: We prioritize “peaks” because negative peaks of confusion/frustration strongly shape remembered impressions.  ￼

⸻

Practical next step (still hackathon-speed)

If you want your pipeline to look “research-grade” without ML:
	1.	Compute all signals per 15s window (step 5s).
	2.	Robust-normalize per speaker (median/MAD).
	3.	Generate:
	•	friction time-series
	•	top 5 friction segments (merge adjacent high windows)
	•	auto “candidate finding” labels using rule patterns (like the mappings above)
	4.	Export JSON with evidence pointers (matched phrase + pause spans).

If you share one real Speechmatics JSON excerpt (a minute or two), I can tailor the exact token parsing + windowing + evidence pointer format so it fits the output spec cleanly (and avoids common timestamp edge cases).
