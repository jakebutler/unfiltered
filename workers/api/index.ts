/**
 * Main API Worker — REST + RPC surface invoked from the Next.js app
 * and from Vapi webhooks. This is a placeholder that returns 501 until
 * routes are wired in Phase 1.
 *
 * Run locally with: wrangler dev
 */

export interface Env {
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ANALYSIS: R2Bucket;
  AI: Ai;
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    return new Response(
      JSON.stringify({
        ok: false,
        message: "API Worker scaffold — routes wire up in Phase 1.",
        path: url.pathname,
      }),
      {
        status: 501,
        headers: { "content-type": "application/json" },
      },
    );
  },
} satisfies ExportedHandler<Env>;
