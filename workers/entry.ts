/**
 * Wrangler entrypoint wrapper.
 *
 * OpenNext generates `.open-next/worker.js` as the default Next.js
 * Worker handler. We re-export it here and also re-export any
 * Durable Object classes declared in `wrangler.toml` so Wrangler can
 * bind them to the Worker.
 */

// Re-export the auto-generated OpenNext handler as the default fetch entry.
// eslint-disable-next-line import/no-default-export
export { default } from "../.open-next/worker.js";

// Re-export Durable Objects referenced in wrangler.toml so Wrangler
// can route requests to them.
export { SessionDurableObject } from "../durable-objects/session";
