/**
 * Bridge between Next.js (running on Cloudflare Workers via OpenNext) and
 * the Cloudflare bindings declared in wrangler.toml.
 *
 * Use from Server Components, Route Handlers, and Server Actions to access
 * D1, R2, AI, and Durable Object bindings.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";

export interface AppEnv {
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ANALYSIS: R2Bucket;
  AI: Ai;
  SESSION_DO: DurableObjectNamespace;
  EMAIL: SendEmail;
  ENVIRONMENT: string;
  PUBLIC_APP_URL: string;
  AI_GATEWAY_NAME: string;
  EMAIL_FROM_ADDRESS?: string;
}

export function getEnv(): AppEnv {
  const { env } = getCloudflareContext();
  return env as unknown as AppEnv;
}

export function getDatabase() {
  const env = getEnv();
  return getDb(env.DB);
}
