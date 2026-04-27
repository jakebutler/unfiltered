# Setup — what requires human action

The Phase 0 scaffolding is in place and `npm run typecheck`, `npm run lint`,
and `npm test` all pass without any remote services. Before the app is
deployable end-to-end, the following one-time provisioning is required.
Each step calls out what to paste back into the repo when done.

## What you need now vs later

For the first round of internal testing (Phase 0–1, synthetic loop only),
you only need steps **1–4**. Everything below that is deferrable:

| Step | Service | When you need it |
|---|---|---|
| 1 | Cloudflare + D1 + R2 | **Phase 0 — now** |
| 2 | AI Gateway + Custom Provider (Z.ai) | **Phase 0 — now** |
| 3 | WorkOS AuthKit | **Phase 0 — now** |
| 4 | LLM provider keys (OpenRouter, Z.ai, OpenAI) | **Phase 0 — now** |
| 5 | Vapi (voice runtime) | Phase 2 — defer |
| 6 | Cloudflare Email Service | Phase 2 — defer |
| 7 | Invitation HMAC secret | Phase 2 — defer |
| 8 | Stripe (billing) | Phase 3 — defer |

Skip 5–8 entirely until you start the relevant phase. None of the
synthetic-loop functionality depends on them.

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
3. **Cache Responses: turn OFF** at the gateway level. We set
   `cf-aig-cache-ttl` per call in code, only for calls that are safe
   to cache (e.g. vision frame classification, cold-start guide
   template generation). The bot brain, theme synthesis, and findings
   are context-dependent and must never be cached at the gateway.
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

We consolidated Anthropic and Gemini calls through OpenRouter, which is
natively supported by Cloudflare AI Gateway. So you only need three
provider keys:

```bash
# OpenRouter (handles Anthropic + Gemini calls): https://openrouter.ai/keys
wrangler secret put OPENROUTER_API_KEY

# GLM (Z.ai; see step 2a for Custom Provider setup)
# Get key at: https://docs.z.ai → Account → API Keys
wrangler secret put GLM_API_KEY

# OpenAI (TTS during validation): https://platform.openai.com/api-keys
wrangler secret put OPENAI_API_KEY
```

For local dev, paste the same values into `.env.local`.

OpenRouter routes Claude (`anthropic/claude-sonnet-4-5`,
`anthropic/claude-opus-4-5`) and Gemini (`google/gemini-2.5-flash`,
`google/gemini-2.5-flash-lite`, `google/gemini-2.5-pro`) using an
OpenAI-compatible chat-completion shape, including multimodal vision
inputs. All calls flow through the `openrouter` provider on AI Gateway,
so caching/observability/rate-limiting still apply.

## 5. Vapi (Phase 2 — DEFER)

> Skip this step until you start Phase 2 (Week 6). The synthetic loop
> doesn't use Vapi; Phase 1 only renders text-based interviews.

When you're ready:

1. Create account at https://vapi.ai
2. Copy public + private keys from dashboard
3. Set the webhook URL. You need a publicly reachable HTTPS URL —
   pick one of:
   - **Preview deploy** (recommended): `npm run cf:deploy` once
     to ship to `https://unfiltered.<your-subdomain>.workers.dev`,
     then paste `<that-url>/api/webhooks/vapi`.
   - **Custom domain** if you've wired one in Cloudflare → use that.
   - **Tunnel for local testing**:
     ```bash
     cloudflared tunnel --url http://localhost:3000
     # or:  ngrok http 3000
     ```
     Paste the tunnel URL + `/api/webhooks/vapi`. Note: tunnels are
     ephemeral; reconfigure Vapi each time the URL changes.

```bash
wrangler secret put VAPI_PUBLIC_KEY
wrangler secret put VAPI_PRIVATE_KEY
```

## 6. Cloudflare Email Service (Phase 2 — DEFER)

> Skip until Phase 2. Used to send participant invitations, GDPR
> deletion confirmations, and (Phase 3) findings-ready notifications.

We use Cloudflare Email Service (public beta, April 2026) instead of a
third-party transactional email provider. No API keys: the `EMAIL`
binding declared in `wrangler.toml` authenticates via your Cloudflare
account.

When you're ready:

1. Cloudflare dashboard → Email → Email Service → enable
2. Add and verify your sending domain (DNS-based, follows DKIM/SPF
   prompts in dashboard)
3. Pick a from-address on that domain (e.g. `research@yourdomain.com`)
4. Set it as the default:
   ```bash
   wrangler secret put EMAIL_FROM_ADDRESS
   # paste:  research@yourdomain.com
   ```
5. Make sure your account is on the **Workers Paid plan**
   ($5/mo minimum) — Email Service requires it.

The `[[send_email]] name = "EMAIL"` binding in `wrangler.toml` is
already wired; usage in code:

```ts
import { sendEmail } from "@/lib/email/cloudflare-email";
import { getEnv } from "@/lib/cloudflare";

const env = getEnv();
await sendEmail(
  { binding: env.EMAIL, defaultFrom: env.EMAIL_FROM_ADDRESS! },
  { to: "user@example.com", subject: "Hi", html: "<p>Hello!</p>" },
);
```

## 7. Invitation HMAC secret (Phase 2 — DEFER)

> Skip until Phase 2. Used to sign participant URLs (Phase 2
> invitations + GDPR deletion links).

```bash
wrangler secret put INVITATION_HMAC_SECRET
# Use: openssl rand -hex 32
```

## 8. Stripe (Phase 3 — DEFER)

> Skip entirely for internal testing. Stripe is Phase 3 (Week 10),
> after the synthetic loop and real-interview wedge are validated
> and pricing is finalized.

When you're ready:

1. Create Stripe account, set up products + prices for "Founder" and "Team"
   tiers
2. Create meters for `realSessionsConsumed` and `syntheticSessionsConsumed`
3. Configure webhook endpoint `https://<your-deployment>/api/webhooks/stripe`
   (same URL options as Vapi above).

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
