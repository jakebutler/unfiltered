# Setup — what requires human action

The Phase 0 scaffolding is in place and `npm run typecheck`, `npm run lint`,
and `npm test` all pass without any remote services. Before the app is
deployable end-to-end, the following one-time provisioning is required.
Each step calls out what to paste back into the repo when done.

## 1. Cloudflare account + Wrangler

```bash
wrangler login
```

Then provision resources:

```bash
# D1 — paste the returned database_id into wrangler.toml
wrangler d1 create unfiltered-db

# R2 buckets
wrangler r2 bucket create unfiltered-recordings
wrangler r2 bucket create unfiltered-analysis

# Apply migrations to local D1
npm run db:migrate:local

# Apply migrations to remote D1 (when ready to deploy)
npm run db:migrate:remote
```

In `wrangler.toml`, replace `PLACEHOLDER_REPLACE_WITH_WRANGLER_OUTPUT` with
the `database_id` printed by `wrangler d1 create`.

## 2. Cloudflare AI Gateway

In the Cloudflare dashboard:

1. AI → AI Gateway → Create Gateway
2. Name: `unfiltered-gateway`
3. Enable caching (default 0s, set per-call via `cf-aig-cache-ttl` header)
4. Note your account id (Workers & Pages → Account ID)

Set as a Worker secret:

```bash
wrangler secret put CLOUDFLARE_ACCOUNT_ID
# (paste your account id when prompted)
```

### 2a. Custom Provider for GLM (Z.ai)

Cloudflare AI Gateway doesn't have a native integration for Z.ai, so we
register it as a Custom Provider. This keeps GLM calls flowing through
the gateway with caching, observability, and rate limiting intact.

In the Cloudflare dashboard:

1. Compute & AI → AI Gateway → Custom Providers → Add Custom Provider
2. Provider Name: `Z.ai (GLM)`
3. Provider Slug: `z-ai`  *(must match `GLM_DEFAULT_PROVIDER_SLUG` in
   `lib/ai/glm.ts`)*
4. Base URL: `https://api.z.ai`
5. Save and toggle **Enabled**

Once enabled, GLM calls hit
`https://gateway.ai.cloudflare.com/v1/{accountId}/unfiltered-gateway/compat/chat/completions`
with `model: "custom-z-ai/glm-5"` (the provider client adds the prefix
automatically). The `Authorization: Bearer ${GLM_API_KEY}` header
carries your Z.ai API key.

If you later switch GLM hosting to Fireworks AI, repeat the steps with
slug `fireworks` and base URL `https://api.fireworks.ai`, then update
`GLM_DEFAULT_PROVIDER_SLUG` accordingly.

## 3. WorkOS AuthKit

1. Create a WorkOS account at https://workos.com
2. In dashboard: Authentication → Configuration → Set redirect URI to
   `http://localhost:3000/api/auth/callback` (and your production URL)
3. Copy these values from the Quick Start panel:
   - `WORKOS_API_KEY`
   - `WORKOS_CLIENT_ID`
   - `WORKOS_REDIRECT_URI`
4. Generate a 32-char password for `WORKOS_COOKIE_PASSWORD`:
   ```bash
   openssl rand -base64 32
   ```
5. For local dev, paste into `.env.local`. For prod:
   ```bash
   wrangler secret put WORKOS_API_KEY
   wrangler secret put WORKOS_CLIENT_ID
   wrangler secret put WORKOS_REDIRECT_URI
   wrangler secret put WORKOS_COOKIE_PASSWORD
   ```

## 4. LLM provider keys

```bash
# Gemini (Google AI Studio): https://aistudio.google.com/apikey
wrangler secret put GEMINI_API_KEY

# GLM (Z.ai default; see step 2a for Custom Provider setup)
# Get key at: https://docs.z.ai → Account → API Keys
wrangler secret put GLM_API_KEY

# Anthropic (Claude): https://console.anthropic.com
wrangler secret put ANTHROPIC_API_KEY

# OpenAI (TTS during validation): https://platform.openai.com/api-keys
wrangler secret put OPENAI_API_KEY
```

For local dev, paste the same values into `.env.local`.

## 5. Vapi (Phase 2)

1. Create account at https://vapi.ai
2. Copy public + private keys from dashboard
3. Set webhook URL (Phase 2): `https://<your-deployment>/api/webhooks/vapi`

```bash
wrangler secret put VAPI_PUBLIC_KEY
wrangler secret put VAPI_PRIVATE_KEY
```

## 6. Resend (Phase 2)

1. Create account at https://resend.com
2. Verify a sending domain (or use the default test domain for dev)
3. Copy API key

```bash
wrangler secret put RESEND_API_KEY
```

## 7. Invitation HMAC secret

Used to sign participant URLs (Phase 2 invitations + Phase 2 deletion links):

```bash
wrangler secret put INVITATION_HMAC_SECRET
# Use: openssl rand -hex 32
```

## 8. Stripe (Phase 3, defer until ready)

1. Create Stripe account, set up products + prices for "Founder" and "Team"
   tiers
2. Create meters for `realSessionsConsumed` and `syntheticSessionsConsumed`
3. Configure webhook endpoint `https://<your-deployment>/api/webhooks/stripe`

```bash
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put STRIPE_PRICE_FOUNDER
wrangler secret put STRIPE_PRICE_TEAM
wrangler secret put STRIPE_METER_REAL_SESSIONS
wrangler secret put STRIPE_METER_SYNTHETIC_SESSIONS
```

## Sanity checks after setup

```bash
npm run typecheck   # should pass
npm run lint        # should pass
npm test            # should pass
npm run dev         # should start Next.js on localhost:3000
```

Once D1 + WorkOS are wired:

```bash
npm run wrangler:dev   # exercise the API Worker with bindings
```
