# S1 browser observations

Root exercised the served clinic at `http://127.0.0.1:5173/` and `/staff` on October 9, 2026 (Pacific), against the actual local Medplum-backed API. Desktop viewport: 1280 × 900. Mobile viewport: 390 × 844. Synthetic fixture: Alex Rivera. No real patient information or microphone was used.

## Observed path

- The synthetic persona gate preceded access to saved answers. Development reload returned to that gate; confirming the same persona restored the saved record.
- In first-intake review, root opened the priority source, corrected the answer, saved it, and compared its prior wording. Current source `b572a66f-86f5-457c-bc22-b1614578361a` links back to `c77ae43e-340b-405d-a694-add89551c98a`. Original text remained inspectable.
- Mobile review remained readable without horizontal overflow. Missing measurements were explicit, and the incomplete PHQ-4 displayed no score. After the initial inspection, empty measurements were shortened into an explicit missing-height/dated-weight summary with all details expandable; derived fields no longer offer an invalid edit action.
- Root deliberately confirmed `07413ed9-3375-487b-8391-91bd1faea06d.v1`. The actual native receipt displayed **Received by Corvo Clinic**, partial handoff, reference, version, time, and separate medical/nutrition work awaiting review. Receipt transition focused its heading and brought it into view on mobile.
- A real named RD application login established Sam Patel, RD's browser session through a disposable, loopback-only, one-use harness. It calls the actual `/api/staff/login` using the ignored synthetic fixture and forwards its HttpOnly cookie. No alternate product auth path was added and no credentials were displayed. The staff form's empty-required-field validation was inspected separately; successful password typing in the UI was **not** tested by this harness.
- The RD opened this patient's full intake, including medical-history sections, then inspected both current and earlier priority statements. Only Nutrition review appeared in the action selector. Opening the handoff did not review it.
- Root deliberately recorded a synthetic nutrition request for a typical day of meals/drinks and quantities. The saved outcome was attributed to **Sam Patel, RD**, at 18:40 PDT. Medical review remained awaiting review. Returning through the patient persona gate displayed that exact persisted outcome.
- Opening a correction created a pending amendment. The **Earlier confirmed version 1** panel kept the original receipt and the recorded RD outcome visible. Root typed an unsaved correction, checked the earlier status, and verified the typed text was unchanged. Saving the correction returned to review with **Confirm and send update to Corvo Clinic**; the amendment was not sent during this check.

## Failures and corrections

The frontend development server stopped during the first confirmation attempt. The UI reported interruption; direct saved-state inspection found the draft still in review, with no confirmed submission. Root restored the same origin/port, resumed the saved draft, and confirmed once. This was a development-service interruption, not evidence of a Medplum native transaction failure. Transport faults are tested separately.

The browser exposed a timestamp mismatch: staff labeled preview creation as receipt time while the patient saw later delivery. Root's correction separates the reviewed preview digest from finalized confirmation time and reads receipt time from the verified immutable QuestionnaireResponse. Independent review and integration evidence must close that finding; this browser record does not substitute for them.

## Limits

These are selected rendered functional observations, not comprehensive accessibility, clinical, or browser-compatibility acceptance. S1 uses explicitly labeled guided questions. Adaptive dialogue, browser voice, realistic hosted performance, public deployment, and the other platform deliverables remain required. Independent design findings are tracked in `S1-DESIGN-REVIEW.md` when available.
