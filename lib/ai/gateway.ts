/**
 * Cloudflare AI Gateway base client.
 *
 * All LLM calls flow through the gateway for caching, observability,
 * and graceful failover. Provider-specific clients (`./gemini.ts`,
 * `./glm.ts`, `./claude.ts`, `./openai.ts`) build on top of this and
 * pass through provider-specific request shapes.
 *
 * Configure gateway in Cloudflare dashboard:
 *   Account → AI Gateway → "unfiltered-gateway"
 *
 * Then set per-provider auth headers via `wrangler secret put`:
 *   GEMINI_API_KEY, GLM_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY
 */

export type GatewayProvider =
  | "google-ai-studio"   // Gemini
  | "anthropic"          // Claude
  | "openai"             // OpenAI (chat + tts)
  | "compat";            // OpenAI-compatible (used for GLM via Z.ai/Fireworks)

export interface GatewayCallOptions {
  provider: GatewayProvider;
  /** Path appended after the gateway base URL (provider-specific). */
  path: string;
  /** Body sent to the upstream provider. */
  body: unknown;
  /** Optional cache TTL in seconds; 0 = no cache. */
  cacheTtl?: number;
  /** Authorization header value (provider-specific). */
  authHeader?: string;
  /** Extra headers to merge in. */
  extraHeaders?: Record<string, string>;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface GatewayConfig {
  accountId: string;
  gatewayName: string;
}

export class GatewayClient {
  private readonly accountId: string;
  private readonly gatewayName: string;

  constructor(cfg: GatewayConfig) {
    this.accountId = cfg.accountId;
    this.gatewayName = cfg.gatewayName;
  }

  private url(provider: GatewayProvider, path: string) {
    const base = `https://gateway.ai.cloudflare.com/v1/${this.accountId}/${this.gatewayName}/${provider}`;
    return `${base}/${path.replace(/^\//, "")}`;
  }

  async post<T>(opts: GatewayCallOptions): Promise<T> {
    const url = this.url(opts.provider, opts.path);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(opts.authHeader ? { authorization: opts.authHeader } : {}),
      ...(opts.cacheTtl ? { "cf-aig-cache-ttl": String(opts.cacheTtl) } : {}),
      ...(opts.extraHeaders ?? {}),
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new GatewayError(res.status, errBody, { provider: opts.provider, path: opts.path });
    }
    return (await res.json()) as T;
  }
}

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly meta: { provider: GatewayProvider; path: string },
  ) {
    super(`AI Gateway ${meta.provider} ${meta.path} failed: ${status} ${body.slice(0, 240)}`);
    this.name = "GatewayError";
  }
}

/**
 * Build a gateway client from app env. Throws if the required vars
 * aren't set.
 */
export function gatewayFromEnv(env: {
  CLOUDFLARE_ACCOUNT_ID?: string;
  AI_GATEWAY_NAME?: string;
}): GatewayClient {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const gatewayName = env.AI_GATEWAY_NAME;
  if (!accountId || !gatewayName) {
    throw new Error(
      "AI Gateway not configured: set CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_NAME.",
    );
  }
  return new GatewayClient({ accountId, gatewayName });
}
