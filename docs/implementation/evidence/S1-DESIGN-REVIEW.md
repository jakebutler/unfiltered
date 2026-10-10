# S1 independent product, UX and Corvo review

Review date: October 9, 2026 (local; October 10 UTC). Surface: `apps/clinic`, served at `http://127.0.0.1:5173/`. Review scope is the guided S1 clinic slice, not full-product acceptance or clinical validation.

**Result:** one material patient reflow finding, corrected and independently confirmed. No remaining material design finding was observed in the inspected patient states. The original staff queue error state was verified. After the owner added paging, an independent rendered follow-up was blocked by browser access; revised staff queue/handoff/source/action rendering remains unqualified by this reviewer.

## Scope and method

The reviewer read `PRODUCT.md`, `DESIGN.md`, `docs/implementation/S1-ACCEPTANCE.md`, clinic source, and the authoritative approved `/Volumes/rexy/GitHub/unfiltered/docs/rebuild/design/EXPERIENCE.md`. The Impeccable context loader and independent design-assessment guidance were applied. This is the requested independent assessment within the implementation's bounded review, not a new full Impeccable critique workflow, redesign, or interview.

The reviewer used a separate in-app browser tab. Parent tabs were not accessible from this agent; the new tab shared the existing synthetic Alex Rivera session. After identity confirmation, the reviewer inspected the existing pending amendment without changing answers or confirming a handoff. Browser screenshots, accessibility state, and read-only DOM measurements informed the findings. No provider calls, source edits, or staff outcomes were made by this reviewer.

Independently observed:

- Desktop patient conversation/answer review at 1280 × 720, including the earlier receipt summary and the explicitly unsent amendment.
- Patient answer/source review at 390 × 844, expanded earlier-answer history, source close/return focus, and minimum-width reflow at 320 × 844.
- Rendered Inter body/control and Space Grotesk heading font families; source text and identifiers wrapping without truncation.
- Named staff authentication as Sam Patel, RD, and staff queue loading/timeout-recovery UI at 1280 × 900.

Parent-reported receipt, RD outcome, amendment persistence and transport tests are not counted as this reviewer's independent observations.

## Material finding and disposition

**P2 — Fixed body minimum caused horizontal page scrolling at 320px. Closed after one targeted correction.** The approved experience requires 320px reflow without horizontal page scrolling. At a 320 × 844 viewport with a 15px vertical scrollbar, `apps/clinic/src/styles.css:5` originally forced a 320px body inside a 305px content viewport. The screenshot visibly showed a horizontal scrollbar. DOM measurements were `innerWidth: 320`, `clientWidth: 305`, `scrollWidth: 320`, `bodyWidth: 320`, `minWidth: 320px`.

The implementation owner changed the body minimum to `0`. A targeted independent confirmation found `clientWidth: 305`, `scrollWidth: 305`, `bodyWidth: 305`, `minWidth: 0px`, and no horizontal scrollbar in the screenshot. Answer text, correction/source controls, topic labels and expandable missing-detail controls still wrapped and remained visible. No further visual iteration was requested.

## Patient and brand observations

- The current review states “Check your update,” “Your changes have not been sent,” “Saved draft · version 9,” and “Partial handoff.” The earlier receipt is separately titled “Earlier confirmed version 1,” with copy assigning its receipt and outcomes to that earlier version. The visible hierarchy does not present the update as received.
- The reason-for-care value exposes a source containing the exact saved wording, a dated timestamp with timezone, and a stable source identifier. “Corrects an earlier answer” and the expanded previous answer make the two wordings inspectable together. Closing the inspector returned focus to “Source for Reason for seeking care.”
- The required-measurement empty state names the missing height/weight/date information without opening eleven empty rows by default. Other unasked details remain discoverable through labeled disclosures; the UI retains a partial status.
- The white/near-white surfaces, restrained coral links, ink primary action, clear rules, and compact Corvo Clinic identity match the approved operational direction. Statuses use literal text. No invented logo, marketing claims, completion percentage, or ornamental medical success treatment was observed.

## Staff observation and open qualification limit

The authorized one-time helper opened the staff app as “Sam Patel, RD / Registered dietitian.” The queue first showed “Loading assigned work…” and then settled to “Queue unavailable,” “Current assignments are unavailable,” and “No successful queue load yet.” Its explanation explicitly said that unavailable assignments do not mean there is no assigned work. Both the queue retry and saved-state refresh actions remained visible, with a separate interrupted-connection alert. The page retained the named identity, and the error was not disguised as an empty successful queue.

No retry or staff mutation was made. No handoff could be selected. The owner reported that queue paging was being changed to address load pressure; that later implementation and its staff handoff/source/action rendering are outside this completed pass and need targeted qualification. The current result must not be used as staff end-to-end acceptance.

### Targeted follow-up after queue paging

The owner rebuilt and restarted the API with explicit queue paging and requested a bounded desktop/mobile check of the loaded count, “Load more work,” full handoff/source inspection, and RD action availability. Source inspection confirmed labels for loaded count versus more available work, explicit loading-more state, and a filtered-empty page message that does not claim all assigned work is empty. These are source observations, not rendered verification.

This follow-up could not reach the served staff app. The new browser tool session exposed only Chrome; the in-app browser returned “Browser is not available: iab.” One authorized Chrome navigation to the one-use local authentication helper at `http://127.0.0.1:8788/start` returned `net::ERR_BLOCKED_BY_CLIENT`. A read-only inspection of that tab confirmed Chrome's error page: “127.0.0.1 is blocked,” “This page has been blocked by Chrome,” and `ERR_BLOCKED_BY_CLIENT`. This was not an expired-helper response or an application queue result. The reviewer did not reload, bypass the browser block, enter credentials, or perform another login/outcome action.

At the owner's direction the pass ended with that limitation. Revised staff paging, successful handoff loading, source display, role-action availability and their desktop/mobile layouts remain outstanding independent rendered evidence. The owner may verify them separately in its existing browser; any such observations must be attributed to that owner and must not be represented as this reviewer's completed checks. A later integrated slice can resume independent rendered qualification.

## Detector disposition

The owner supplied the single existing mechanical scan in `S1-DESIGN-DETECTOR.json`; the reviewer read it only after the initial design assessment and did not rerun it. Its seven warnings are all `overused-font` at `styles.css` lines 1, 2, 17, 45, 92, 122 and 172. Inter and Space Grotesk are explicitly approved Corvo brand choices in the authoritative experience and local design contract. These warnings do not justify replacing the fonts and are not open findings. No browser overlay was injected or claimed.

## Limits

This review did not establish screen-reader operation, 200% browser zoom, a physical mobile keyboard, voice, live adaptive reasoning, clinical appropriateness, or all seven end-to-end workflows. Reduced-motion CSS and accessible labels were source-inspected, not a complete accessibility certification. Guided mode is explicitly appropriate for this S1 slice; missing adaptive/voice qualification still prevents declaring the full product ready.

Questions skipped: the direction and scope were already approved; the parent requested a bounded independent review without another user interview.
