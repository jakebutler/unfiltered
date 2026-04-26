# lib/auth

WorkOS AuthKit integration. Wired in Phase 0 day 3-4.

Expected files:
- `workos.ts` — server-side WorkOS client + session helpers
- `session.ts` — current-user helpers usable from Server Components and Workers
- `middleware.ts` — Next.js auth middleware

Sign-in / sign-up handled by WorkOS hosted UI (AuthKit). On callback we upsert the `User` row in D1 and ensure a personal `Workspace` exists.
