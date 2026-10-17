# Research analysis and publication backend

October 9, 2026. Bounded implementation against the approved primary research product, architecture and experience contracts. Provider dispatch remains disabled in the default research server. No cloud/provider/speech/email operation or spend was performed in this slice.

## Implemented boundary

An operator selects at most six sessions and 24 sources. Admission resolves current retained, consented source rows in one owned client/project and freezes hashes, correction lineage, modality epochs, intervals and study context. At most four frames of 120 KB each are admitted. A root-owned reservation is globally single-use; browser input supplies its ID only. The server config resolves the model, expiry, text input ceiling and output cap. The prepared DO wire request uses the actual reserved output cap and records its byte count and exact UTF-8 SHA-256.

The existing private gateway and Node server own bounded selected-frame extraction. They read checksum-verified retained segments, extract with a fixed ffmpeg argument list and pipe-only protocols, and bind source hash, capture time, image hash and bytes to the dispatch receipt. Frame processing is serial with an eight-second subprocess deadline. Actual ffmpeg/browser decoding is not yet qualified. No video processing is claimed inside a free Worker.

Analysis rechecks consent before each extraction, immediately before dispatch, when saving results and on operator reads. Provider timeouts/ambiguous outcomes remain `unknown`; replay cannot redispatch. Existing DigitalOcean transport/model/response guards are reused through a small research adapter. Its internal ClinicalError dependency remains; no clinical scenario module or clinical persistence is introduced. Live reasoning/vision remains gated on root qualification and credit admission.

Findings distinguish self-report, observed DOM, tentative screen/camera observations and interpretation. Camera-only evidence cannot acquire emotional or diagnostic meaning by relabeling a finding. Audio segment metadata is not a transcript or model listening. Capture gaps are limitations.

An explicit review pins a revision. Publication previews exact content, audience names, approved excerpts and whole-artifact raw view/download grants. Every cited support/counterexample requires an approved excerpt or inspectable raw grant. Publication freezes those choices and the audience names. New interviews and regenerated analyses stay private. Request-status queries support receipt readback without automatic resubmission.

Password shares use native asynchronous PBKDF2-SHA256, random 32-byte salts, 210,000 iterations and constant-time comparison. Transactional eight-attempt/share and 32-attempt/global windows precede KDF work. A single-use pending challenge becomes one hashed, 15-minute viewer session; its HttpOnly, SameSite=Strict cookie is scoped to the portal. Every read also binds the route's share slug. Production HTTPS adds Secure. Raw references are publication aliases, not private source IDs/keys.

Raw source view/download grants are enforced separately. Both operator and client media use the same range-serving helper, no-store headers, and authorization immediately before each bounded 256 KB chunk. Product download controls are not DRM. Access revocation cannot recall delivered bytes. Grant changes preserve evidence inspectability or require revoking the share/new publication.

Sharing changes invalidate prior publication epochs; a fresh explicit preview can use newly granted sharing without rerunning inference. Corrections, withdrawal and unavailable sources fail closed immediately on reads, and indexed cursor cleanup erases affected copied findings/excerpts/context. Natural raw expiry preserves a dependency only when its exact approved excerpt and explicit retention consent were frozen. Expired originals remain labeled unavailable. DOM sharing is explicit `shareDom`; absent legacy values deny sharing.

## Integration surface

- `researchAnalysis`: inventory/list/read/requestStatus, gateway-authenticated admit/material/beginDispatch/finish, operator saveReview.
- `researchReports`: preview/publish/list/requestStatus/withdraw. Preview hashes bind content, audience and selected grants.
- `researchPortal`: gateway-authenticated password-share creation/unlock, scoped report/source reads and logout; operator shares/revokeShare/updateGrants.
- HTTP: `/api/research/analysis/readiness`, `/api/research/analysis`, `/api/research/shares`, `/api/research/portal/{unlock,report,download,session}`, `/api/research/portal/source/eN`. Portal GETs require `?slug=…`; source GET also requires `intent=view|download`.

Frontend contracts are `packages/research-core/src/analysis.ts` and `publication.ts`. Browser-selected reservations cannot widen wire/provider limits. Runtime passwords and provider credentials are not returned or logged.

## Verification and frontier

Node 22.22.3, 1 GB heap, one worker, no file parallelism. Convex and research-server TypeScript checks passed. Existing research-core tests passed 31/31; the new report authority suite passed 10/10. Capture/gateway suites passed 36/36. Research-server suites passed 22/22. Counterexamples cover reserved-vs-actual output caps, delayed request bodies, uninspectable citations, camera relabeling, source withdrawal/correction, cross-client sources, slug mismatch, natural retention, password attempts and media revocation between chunks.

An authorized local-only Convex push to `http://127.0.0.1:3210` succeeded at 22:39 UTC. No native fixture writes or new service startup occurred. Independent static review accepted the bounded backend and its repairs; its report records file fingerprints. Current local execution/acceptance owners must still prove native capture→frame→offline-fixture analysis→review→publication→password portal, then separately qualify the root-reserved live DO model/vision operation. Offline fixture receipts are explicitly labeled and do not establish live quality or hosted/free qualification.
