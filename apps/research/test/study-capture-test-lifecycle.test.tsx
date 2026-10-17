import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyCaptureTest } from "../src/StudyCaptureTest";
import { studyWelcome } from "../../../packages/research-core/src/welcome";
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[], effects: [] as (() => void)[], token: "operator-token" as string | null }));
vi.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => hooks.token }));
vi.mock("convex/react", () => ({ useConvex: () => ({ mutation: vi.fn() }) }));
vi.mock("react", async original => ({ ...await original<any>(),
  useState(value: unknown) { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof value === "function" ? value() : value; return [hooks.values[i], (next: any) => { hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next; }]; },
  useEffect(callback: () => void | (() => void), dependencies: unknown[]) { const i = hooks.cursor++, prior = hooks.values[i]; if (!prior || dependencies.some((v, n) => v !== prior.dependencies[n])) hooks.effects.push(() => { prior?.cleanup?.(); hooks.values[i] = { dependencies, cleanup: callback() }; }); },
}));
const scope = { clientId: "client", projectId: "project", studyId: "study", studyVersion: 1 }, deadline = Date.UTC(2026, 9, 11);
const preview = { welcome: studyWelcome({ scope, title: "Test", introduction: "Synthetic", prototypeUrl: null, clientName: "Client", operatorName: "Operator" }), binding: "a".repeat(64), configurationDigest: "b".repeat(64), setup: { controlledDomRequired: false, controlledDomAuthorized: false } };
function nodes(tree: unknown, type: string): ReactElement<any>[] { if (Array.isArray(tree)) return tree.flatMap(n => nodes(n, type)); if (!tree || typeof tree !== "object" || !("props" in tree)) return []; const node = tree as ReactElement<any>; return [...(node.type === type ? [node] : []), ...nodes(node.props.children, type)]; }
function render(active = true, selectedScope = scope) { hooks.cursor = 0; hooks.effects = []; const tree = StudyCaptureTest({ scope: selectedScope, active }); for (const effect of hooks.effects) effect(); return tree; }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function receipt(original: any) { return { scope, requestId: original.requestId, invitationId: "invite", sessionId: "session", binding: preview.binding, configurationDigest: preview.configurationDigest, issuedAt: deadline - 1000, expiresAt: deadline, retainUntil: deadline + 100000, device: original.device, deviceContext: "operator-reported", revokedAt: null }; }
const focusHandlers = new Set<() => void>(), visibilityHandlers = new Set<() => void>();
function focus() { for (const handler of [...focusHandlers]) handler(); }
function visible() { for (const handler of [...visibilityHandlers]) handler(); }
beforeEach(() => { focusHandlers.clear(); visibilityHandlers.clear(); hooks.cursor = 0; hooks.values = []; hooks.effects = []; hooks.token = "operator-token"; vi.useFakeTimers(); vi.setSystemTime(deadline - 1000); const values = new Map(); vi.stubGlobal("window", { location: { origin: "https://example.test" }, sessionStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) }, setTimeout, clearTimeout, addEventListener: (name: string, cb: () => void) => { if (name === "focus") focusHandlers.add(cb); }, removeEventListener: (name: string, cb: () => void) => { if (name === "focus") focusHandlers.delete(cb); } }); vi.stubGlobal("document", { visibilityState: "visible", addEventListener: (name: string, cb: () => void) => { if (name === "visibilitychange") visibilityHandlers.add(cb); }, removeEventListener: (name: string, cb: () => void) => { if (name === "visibilitychange") visibilityHandlers.delete(cb); } }); });
afterEach(() => { for (const value of hooks.values) value?.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function begin() { render(); const controller = hooks.values[1]; await controller.preview(hooks.token, true); render(); return controller; }
test("token-only issued link expires on the controlled clock without claiming evidence or dispatching status", async () => {
  const fetcher = vi.fn(async (_url, init) => { const input = JSON.parse(init.body); return Response.json(input.requestId ? { receipt: receipt(input), token: "c".repeat(64) } : preview); }); vi.stubGlobal("fetch", fetcher);
  const controller = await begin(); await controller.issue(hooks.token, true, { browser: "Chrome", platform: "macOS" });
  expect(renderToStaticMarkup(render())).toContain("Open capture test"); await vi.advanceTimersByTimeAsync(1020);
  expect(renderToStaticMarkup(render())).not.toContain("Open capture test"); expect(fetcher).toHaveBeenCalledTimes(2);
});
test("archive/auth effects invalidate late issue acknowledgement while preserving original receipt recovery", async () => {
  let deliver!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(preview)).mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; })));
  const controller = await begin(), pending = controller.issue(hooks.token, true, { browser: "Chrome", platform: "macOS" }), original = controller.state.original;
  render(false); hooks.token = null; render(false); deliver(Response.json({ receipt: receipt(original), token: "c".repeat(64) })); await pending; await settle();
  const html = renderToStaticMarkup(render(false)); expect(html).not.toContain("Open capture test"); expect(html).toContain("Check original test receipt"); expect(controller.state.original).toEqual(original); expect(controller.state.token).toBeNull();
});

function proof(original: any, current = true) {
  const now = Date.now(), issued = receipt(original);
  return { state: "found", receipt: { ...issued, expiresAt: deadline + 600000, retainUntil: deadline + 900000 }, observedAt: now, validUntil: now + 30000, current, reason: current ? "Current test authority" : "Consent withdrawn", domConnected: current, event: current ? { batchId: "batch", sequence: 1, kind: "click", recordedAt: now, generation: 1, origin: "https://example.test" } : null, media: [], recording: "active", gaps: [], cleanup: "retained" };
}
async function prepared(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetcher); const controller = await begin(); await controller.issue(hooks.token, true, { browser: "Chrome", platform: "macOS" }); await controller.status(hooks.token); await settle(); render(); return controller;
}
function statusFetcher(current: () => boolean = () => true) { return vi.fn(async (route: string, init: any) => { const input = JSON.parse(init.body); return Response.json(route.endsWith("/status") ? proof(input, current()) : route.endsWith("/issue") ? { receipt: { ...receipt(input), expiresAt: deadline + 600000 }, token: "c".repeat(64) } : preview); }); }

test("clock expiry suppresses claims synchronously, permits one expiry read, then stops automatic polling", async () => {
  const fetcher = statusFetcher(); await prepared(fetcher);
  expect(renderToStaticMarkup(render())).toContain("Test event received · click");
  vi.setSystemTime(Date.now() + 30000); expect(renderToStaticMarkup(render())).not.toContain("Test event received · click");
  expect(renderToStaticMarkup(render())).toContain("Dated test history");
  // Start a fresh manual cycle then run its timer and the successor timer.
  await hooks.values[1].status(hooks.token); render();
  await vi.advanceTimersByTimeAsync(30000); await settle(); render(); const reads = fetcher.mock.calls.filter(call => call[0].endsWith("/status")).length;
  await vi.advanceTimersByTimeAsync(30000); await settle(); expect(renderToStaticMarkup(render())).not.toContain("Test event received · click");
  await vi.advanceTimersByTimeAsync(300000); await settle(); expect(fetcher.mock.calls.filter(call => call[0].endsWith("/status"))).toHaveLength(reads);
});

test("consent revocation in another tab becomes visible on focus or visibility refetch even while cached proof is fresh", async () => {
  let allowed = true; const fetcher = statusFetcher(() => allowed); await prepared(fetcher);
  allowed = false; expect(renderToStaticMarkup(render())).toContain("Test event received · click");
  focus(); expect(renderToStaticMarkup(render())).not.toContain("Test event received · click"); await settle();
  expect(renderToStaticMarkup(render())).toContain("Consent withdrawn"); expect(renderToStaticMarkup(render())).toContain("Historical click event");
  const reads = fetcher.mock.calls.length; visible(); await settle(); expect(fetcher).toHaveBeenCalledTimes(reads + 1);
});

test("focus during a pending status queues one read; a late positive response cannot restore claims before fresh authority", async () => {
  const fetcher = statusFetcher(), controller = await prepared(fetcher); let deliver!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; })).mockImplementationOnce(async (_route, init) => Response.json(proof(JSON.parse(init.body), false)));
  const pending = controller.status(hooks.token); focus(); focus(); deliver(Response.json(proof(controller.state.original))); await pending; await settle();
  expect(renderToStaticMarkup(render())).not.toContain("Test event received · click"); expect(controller.state.status.current).toBe(false);
  expect(fetcher.mock.calls.filter(call => call[0].endsWith("/status"))).toHaveLength(3);
});

test("late valid status is hidden across scope, auth and archive changes; original journal remains recoverable", async () => {
  for (const change of ["scope", "auth", "archive"]) {
    hooks.values = []; hooks.effects = []; hooks.token = "operator-token";
    const fetcher = statusFetcher(), controller = await prepared(fetcher), original = controller.state.original; let deliver!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; })); const pending = controller.status(hooks.token);
    if (change === "auth") { hooks.token = "new-operator-token"; fetcher.mockImplementationOnce(async (_route, init) => Response.json(proof(JSON.parse(init.body), false))); }
    const selected = change === "scope" ? { ...scope, studyVersion: 2 } : scope;
    expect(renderToStaticMarkup(render(change !== "archive", selected))).not.toContain("Test event received · click");
    deliver(Response.json(proof(original))); await pending; await settle();
    expect(renderToStaticMarkup(render(change !== "archive", selected))).not.toContain("Test event received · click");
    expect(JSON.parse(window.sessionStorage.getItem(controller.journalKey)!)).toEqual(original);
    if (change === "auth") hooks.token = null;
    for (const value of hooks.values) value?.cleanup?.(); window.sessionStorage.removeItem(controller.journalKey);
  }
});

test("resume restores only the original nonsecret request and performs a fresh status read", async () => {
  const original = { scope, requestId: "restored-original", expectedBinding: preview.binding, device: { browser: "Chrome", platform: "macOS" } };
  window.sessionStorage.setItem("corvo.research.capture-test.v1.client.project.study.1", JSON.stringify(original));
  const fetcher = statusFetcher(); vi.stubGlobal("fetch", fetcher); expect(renderToStaticMarkup(render())).not.toContain("Test event received · click"); await settle();
  expect(renderToStaticMarkup(render())).toContain("Test event received · click"); expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toContain("/status"); expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(original);
});
