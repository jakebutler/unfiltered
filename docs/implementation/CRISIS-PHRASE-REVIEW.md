# D-k proposed crisis phrase review

`wordingStatus: proposed-detail`

Status: review material only, not wired into the authored safety floor or native questionnaire. The active digest remains unchanged. These candidates require owner wording review, scoped-negation regression checks and inclusion in the bundled qualification before activation. A lexical match is not a diagnosis; the existing clinician-review path still applies.

## Proposed current-self statements

| Candidate phrase | Proposed handling for an unnegated, current-self statement |
|---|---|
| “I don't want to be here anymore.” | Existing authored E04 interruption; no new generated guidance |
| “I do not want to be alive anymore.” | Existing authored E04 interruption |
| “I wish I wouldn't wake up.” | Existing authored E04 interruption |
| “Everyone would be better off without me.” | Existing authored E04 interruption |

The first example contains grammatical negation of wanting to remain alive. Do not incorrectly treat that as denial of risk. Conversely, a denial of having such thoughts must not be promoted into a current-self declaration.

## Required scoped regression examples before activation

| Input | Deterministic-floor expectation |
|---|---|
| “I don't want to be here anymore.” | Current-self positive |
| “I have never felt that I don't want to be here anymore.” | Negated; do not hard-stop solely on embedded phrase |
| “My brother said he doesn't want to be here anymore.” | Other person; not the patient's own current risk |
| “Ten years ago I wished I wouldn't wake up; I do not feel that way now.” | Historical plus current denial; do not hard-stop solely on historical phrase |
| “What should someone do if they don't want to be alive?” | Hypothetical/general; not a self-report |
| “I don't want to be here at this bus stop anymore.” | Location context; do not treat as current self-harm intent solely from phrase |
| “I used to be fine. Now everyone would be better off without me.” | Current-self positive after temporal contrast |
| “I never felt that way before, but today I wish I wouldn't wake up.” | Current-self positive after negated past context |

For all cases, test safety-before-extraction, original-source preservation, no PHQ inference, and identical behavior for typed and unreviewed speech sources. A non-match at the deterministic floor does not mean the model review must clear the message. Preserve the existing fail-closed clinician review on model failure.

No tests in this document have been represented as executed runtime coverage. The implemented floor and its existing tests remain authoritative until the reviewed change lands.
