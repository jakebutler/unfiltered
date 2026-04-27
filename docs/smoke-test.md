# Phase 0 → Phase 1 smoke test

Run this on your Mac after pulling the latest commit. ~30 minutes
total, exits with confidence that the Cloudflare-native rails are
sound before you start writing real product code.

## Prerequisites

- `git pull` is up to date with `main`
- All `wrangler secret put NAME` already completed (you've done this)
- `.env.local` and `.dev.vars` populated locally (you've done this)
- `wrangler.toml` has the real `database_id` (committed already)

## Step 1 — Apply D1 migrations to remote

```bash
npm run db:migrate:remote
```

You should see something like:

```
🌀 Mapping SQL input into an array of statements
🌀 Parsing 0 statements
✅ Successfully applied 1 migration ...
```

Verify in Cloudflare dashboard → Workers & Pages → D1 → `unfiltered-db`:
the 19 tables (`users`, `workspaces`, `studies`, `guides`, ...) should
now exist.

## Step 2 — Local smoke test (no deploy)

```bash
# Terminal 1: Next.js dev server (no Cloudflare bindings)
npm run dev
```

Visit http://localhost:3000 — marketing root should render.

Visit http://localhost:3000/studies — should redirect to WorkOS hosted
sign-in. Sign up with a real email; on success you'll bounce through
`/api/auth/callback` and land on `/studies` with the empty state.

Verify in Cloudflare dashboard → D1 → unfiltered-db → run a SQL
query:

```sql
SELECT id, email, default_workspace_id, created_at FROM users;
SELECT id, name, owner_id FROM workspaces;
SELECT user_id, workspace_id, role FROM workspace_members;
```

You should see 1 row in each. **This confirms `getCloudflareContext()`
+ Drizzle + the auth provisioning chain works end-to-end.**

If `users` is empty but you successfully signed in: the callback ran
but `ensureUserAndWorkspace` swallowed an error. Check the dev server
log for `ensureUserAndWorkspace failed`. Most likely the D1 binding
wasn't reachable from `npm run dev` — that's expected; it only runs
under `wrangler dev` or after deploy. Move to step 3.

## Step 3 — Build + deploy to Cloudflare

```bash
# Build OpenNext bundle. Should finish with "OpenNext build complete."
npx opennextjs-cloudflare build

# Deploy. Will print your Worker URL at the end.
npx opennextjs-cloudflare deploy
```

Note the printed URL (something like
`https://unfiltered.<your-subdomain>.workers.dev`). This is your prod
URL.

## Step 4 — Update WorkOS redirect URI for prod

In WorkOS dashboard → Authentication → Configuration → Redirects,
add:

```
https://unfiltered.<your-subdomain>.workers.dev/api/auth/callback
```

(Keep the localhost one too.) Save.

Then push the prod URL into Cloudflare:

```bash
wrangler secret put WORKOS_REDIRECT_URI
# paste:  https://unfiltered.<your-subdomain>.workers.dev/api/auth/callback
```

## Step 5 — Smoke test deployed app

1. `https://unfiltered.<your-subdomain>.workers.dev/api/health` →
   should return `{"ok":true,"phase":"0",...}`.
2. `https://unfiltered.<your-subdomain>.workers.dev/studies` →
   redirects to WorkOS, sign in (use a different email than step 2 if
   you want a clean second user), bounce back, see the empty Studies
   page.
3. Run the same `SELECT` queries from step 2 against D1 — you should
   now see a second user row (or the original one updated) with
   matching workspace + member.

If that second sign-in flow works, the full prod stack is live:
WorkOS → Cloudflare Worker → D1 via `getCloudflareContext()` →
provisioning logic.

## Step 6 — Sanity-check observability

- Cloudflare dashboard → Workers & Pages → unfiltered → Logs → live
  tail. Trigger a request; logs should stream.
- Cloudflare dashboard → AI Gateway → unfiltered-gateway. We haven't
  triggered any AI calls yet, so the dashboard is empty — that's
  fine. We'll exercise it in Phase 1.2.

## Failure modes & fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `wrangler d1 migrations apply` errors with "no such database" | `database_id` in wrangler.toml doesn't match | Re-paste from `wrangler d1 list` output |
| Dev sign-in works, prod doesn't | WorkOS redirect URI mismatch | Add prod URL to WorkOS allowlist + `wrangler secret put WORKOS_REDIRECT_URI` |
| `/studies` 500s after sign-in | `getCloudflareContext()` couldn't reach D1 binding | Verify wrangler.toml has the `[[d1_databases]] binding = "DB"` block; redeploy |
| Build fails with "cannot use the edge runtime" | A new route added `export const runtime = "edge"` | Remove that line; OpenNext auto-targets Workers |
| Worker deploy fails with cookie-password error | `WORKOS_COOKIE_PASSWORD` < 32 chars | Regenerate with `openssl rand -base64 32`, re-set the secret |

## When all six steps pass

You're cleared for Phase 1.1: Auth + Studies CRUD. Tell me and I'll
start building.
