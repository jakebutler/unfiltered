# S4 research operator and participant interface

The separate React/Vite research app is implemented against the native local Convex API described in `S4-RESEARCH-CORE.md`. It does not share clinic records, identities or capture defaults. This is the text interview and evidence inspection slice; research media, adaptive interviewing, analysis, published reports and client access remain subsequent work.

## Routes and local operation

- `/`: named operator sign-in, client selection, projects, study setup, invitations, and sessions/sources. Authentication uses the installed Convex Auth Password provider with `flow: signIn`; there is no sign-up, password reset or custom login bypass.
- `/participate#token=<capability>`: one invitation’s participant experience. The fragment is removed before rendering. A valid capability is retained only in tab-scoped session storage to permit refresh/resume; an invalid new invitation does not fall back to another participant’s stored capability. The accessible `#main` skip link preserves the current session.
- `/participate` without a retained capability: instructions to reopen the original invitation. It is not a demo session selector.

From the worktree with Node 22:

```sh
npm run research:dev
npm run research:typecheck
npm run research:test
VITE_RESEARCH_CONVEX_URL=http://127.0.0.1:3210 npm run research:build
```

Development binds to `127.0.0.1:5174`, and Vite preview is configured for `127.0.0.1:4174`. Local development defaults to the separate Convex backend on port 3210. A production build needs the public `VITE_RESEARCH_CONVEX_URL`; without it the app displays an unconfigured-deployment screen and cannot accept interviews. Only a deployment URL belongs in that variable. No private environment file, password, signing key, admin token or provider credential is loaded into the app.

Static hosting must rewrite `/participate` to `index.html`. No hosted deployment is part of this slice.

## Operator workflow

The approved light Corvo Operate direction uses a client rail and explicit client/project breadcrumbs. Each project exposes its actual three working sections: study setup, invitations, and sessions/sources. Self-hosted Inter and Space Grotesk reuse the approved clinic assets and licenses.

The operator can create and rename clients/projects, archive or restore them, and edit a study’s participant introduction, private goals, ordered questions, prototype URL and optional pinned repository excerpts. Saving creates a new immutable version. Existing invitations keep their selected version. Study edits warn before local navigation or page exit would discard them. Archive/restore explains how participant access changes and distinguishes reversible archival from permanent invitation revocation.

Invitation issue creates one request ID before dispatch and stores only its nonsecret recovery metadata. An unconfirmed result offers **Check original invitation**, with the same request ID, scope and version. The backend may return the existing receipt without its plaintext token; the UI then requires deliberate revocation/replacement instead of pretending that the link was recovered. Plaintext links are displayed only in memory after successful issue and can be copied or opened then. A fragment carries the token; the document sets `no-referrer`, external links use `noreferrer noopener`, and there is no telemetry or external asset request.

Session review is scoped to the selected client/project. Sources show exact text, author/channel, stable source ID, question ID, save time, and a correction’s earlier wording. Pages contain at most 25 records. “Load more” remains available until the backend reports completion; the UI never presents a partial page count as the total number of records. Lists refresh after their mutations and also have explicit refresh controls.

## Participant workflow and recovery

The welcome distinguishes storage/analysis consent, optional client transcript sharing, optional retained report excerpts, and browser device permissions. This slice captures text only; microphone, camera, screen and their sharing flags remain false. It requests no device permission and makes no recording claim. Consent is saved by the API before the first scripted question appears.

Answers preserve exact text. Each answer/correction gets one stable request ID and a snapshot of its question/target and expected revision before dispatch. The exact in-flight payload is held in session storage until acknowledgement or a definite API rejection. A network ambiguity blocks new writes and offers only an explicit replay of that exact operation. A stale draft is not silently applied to a different question. Browser-storage failure stops dispatch when safe recovery metadata cannot be retained.

Participants can inspect their source history and append corrections to the latest answer; originals remain visible. The UI waits until all source pages are loaded before offering corrections, so an unloaded later correction cannot be mistaken for the current answer. Pause/resume is durable. Leaving clearly identifies any unsent text. Completed and partial interviews require explicit confirmation and then close for edits. There is no report-publication or clinician-delivery claim in completion copy.

Link expiry and source-retention dates appear separately. The participant view hides content and disables access at the earliest returned deadline, clears the retained tab capability/pending payload, and rechecks time on focus. This is a UX measure, **not the server access authority**. Every backend operation still checks access. Server-scheduled expiry invalidation and physical source deletion passed independent review and native restart qualification; see `S4-LIFECYCLE.md` and `evidence/S4-INDEPENDENT-REVIEW.md`.

## Validation performed

- Research TypeScript check passed.
- Twelve focused tests passed: strict fragment parsing and malformed-link isolation; exact answer/correction recovery; rejecting malformed/oversized local payloads; source-lineage preservation; escaped untrusted text; correction availability; public error redaction; and JSX render smoke checks.
- Vite production compilation passed, including an explicitly configured local-endpoint build. The library’s harmless `use client` bundling warning remains.
- CUA inspection verified the actual operator sign-in at desktop width and 390px, and the participant missing-invitation view at 390px. At 390px the sign-in document width and scroll width both measured 390px. Viewport overrides were restored afterward.
- The first browser pass caught a JSX runtime mismatch that TypeScript alone did not detect. `apps/research/tsconfig.json` now selects the automatic JSX runtime; the corrected served page rendered successfully.
- React review checked hook cleanup, stale-scope response suppression, immutable request payloads, effect dependencies, direct typed API imports, escaped source rendering, visible labels/focus, responsive layout and reduced-motion behavior. No new dependencies were installed.

## Remaining acceptance and integration work

Root completed the authenticated browser journey using normal operator Password sign-in and a temporary synthetic local credential, then restored the original credential and invalidated the temporary sessions. No authentication bypass was added. `evidence/S4-B1.json` records client/project creation, two immutable study versions, a version-1 invitation, consent before questions, exact answer and correction, durable pause/reload/resume, completion, operator inspection of all five sources, immediate link revocation, and archive/restore without undoing revocation. The participant view at a 390px viewport had no horizontal overflow; the temporary viewport was restored.

The pass caught a real render loop: generated Convex API proxy identities changed between renders and continuously recreated subscriptions. Subscription and pagination effects now identify queries by stable function name plus arguments. Root re-ran the research typecheck, all twelve frontend tests and the production build after this repair and final save-state copy changes; all passed.

Media capture, adaptive interviewing, analysis, report publication, the password-protected client portal, post-completion amendments and consent withdrawal remain to be implemented. Browser ambiguity/stale-revision scenarios and final cross-device acceptance remain separate from the successful journey above. The source-retention job is implemented and independently accepted; future media/report retention must extend it deliberately.

Two API presentation limitations should be resolved with later backend work: participant introduction currently identifies Corvo Labs and the “study’s client” rather than returning the client’s display name; historical invitation/session metadata contains the immutable study ID but not a human-readable version number. The invitation creation choice itself is explicitly numbered and version-pinned.
