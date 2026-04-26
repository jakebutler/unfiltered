/**
 * Per-session Durable Object.
 *
 * Responsibilities (wired progressively across phases):
 * - Phase 1 (synthetic): hold transcript chunks and bot tool events as
 *   the synthetic workflow streams turns; expose a fetch() endpoint to
 *   read state from the API Worker.
 * - Phase 2 (real): receive Vapi webhook calls (transcript chunks +
 *   tool events), fan them out to subscribed WebSocket clients (founder
 *   "watch live" + the participant page), persist to D1.
 *
 * One DO instance per active session. Hibernation eligible after end.
 */

export class SessionDurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return new Response(
      JSON.stringify({
        ok: false,
        message:
          "SessionDurableObject scaffold — handlers wire up in Phase 1 (synthetic) and Phase 2 (real).",
        path: url.pathname,
      }),
      {
        status: 501,
        headers: { "content-type": "application/json" },
      },
    );
  }
}
