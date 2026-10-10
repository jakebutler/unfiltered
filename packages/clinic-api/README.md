# Clinic API (local synthetic qualification)

`src/handler.ts` exports a portable `Request -> Promise<Response>` handler. The Node adapter in `apps/clinic-server` listens on loopback port 8787; Vite proxies the same-origin `/api` routes from port 5173. Runtime credentials stay server-side in the ignored, mode-0600 `infra/local/.clinic-config.json`. Bootstrap credentials are only read by the explicit synthetic seed/repair script.

Patient drafts and immutable handoff snapshots are Medplum DocumentReferences. Signed HttpOnly capabilities bind one synthetic patient, scenario, and draft; each resume returns a persona gate. Accepted turns have request IDs, source IDs, revision checks and optimistic FHIR saves. Native FHIR handoffs and staff actions retain their confirmed digest and verified member attribution. Staff OAuth/PKCE tokens remain server-side, and every staff operation refreshes the verified identity/policy before reading canonical FHIR resources. No native signed storage URLs are returned.

The local conversation is guided and records explicit granular answers. It does not extract facts from free text or call an inference provider. Source-linked corrections, explicit partial confirmation, and prior-version receipt reconciliation remain available. PHQ-4 arithmetic uses all four explicit item values and never constitutes diagnosis or clearance. E-0.1 is a bounded synthetic interruption policy, not a validated clinical triage tool.

## Run and qualify

Use Node 22.22.3 and the existing dependencies:

```sh
npm run foundation:build
npm run clinic:api
npm run clinic:dev
npm run foundation:test
node apps/clinic-server/test/qualify-local.mjs
node apps/clinic-server/test/qualify-faults.mjs
node apps/clinic-server/test/qualify-complete.mjs
node apps/clinic-server/test/qualify-amendment.mjs
```

The latter scripts write real synthetic records to the already seeded project. They never delete prior data or call cloud/model/speech/email services. The local named-login service permits five logins per minute; coordinate runs with browser testing. Preserve failed attempt reports and do not infer a failed login check passed because later unrelated checks passed. Fault qualification injects bounded transport failures against the actual local Medplum instance and checks stored results.

Staff queues return one page of at most five snapshots per request, scoped by verified patient assignment before reading full handoffs. `GET /api/staff/queue?cursor=5` accepts decimal offsets in multiples of five through 100000 and returns `{items,nextCursor?}`. Each returned handoff still requires fresh named authorization and a complete receipt. A filtered empty page can have `nextCursor`; it is not an all-clear result. New arrivals can shift offset pages, so the UI deduplicates by handoff ID/responsibility and refresh resets pagination. No request scans all queue pages. The offset bound is a local demonstration limit; production needs a scalable received-work index and stable cursor. Staff sessions are process-local and require sign-in again after restart. Conversation safety matching is a bounded literal fallback; no unsupported case is declared safe. Guided request categorization never grants administrative access to free-form clinical statements.

All result reports are technical synthetic evidence, not rendered UX, clinical protocol approval, live provider qualification, production deployment or real patient authorization.
