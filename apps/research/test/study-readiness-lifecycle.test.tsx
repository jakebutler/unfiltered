import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyReadiness } from "../src/StudyReadiness";
import type { StudyReadinessSnapshot } from "../../../packages/research-core/src/readiness";
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[], effects: [] as (() => void)[], token: "operator-token" as string | null }));
vi.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => hooks.token }));
vi.mock("react", async original => ({ ...await original<any>(),
  useState(value: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof value === "function" ? value() : value; return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; },
  useEffect(callback: () => void | (() => void), dependencies: unknown[]) { const index = hooks.cursor++; const prior = hooks.values[index]; if (!prior || dependencies.some((value, n) => value !== prior.dependencies[n])) hooks.effects.push(() => { prior?.cleanup?.(); hooks.values[index] = { dependencies, cleanup: callback() }; }); },
}));
const scope = { clientId: "client", projectId: "project", studyId: "study", studyVersion: 1 };
const deadline = Date.UTC(2026, 9, 11, 12);
function snapshot(): StudyReadinessSnapshot { return { scope, revision: "a".repeat(64), observedAt: Date.now(), validUntil: Date.now() + 30000, expiresAt: deadline, fallback: "Continue with saved text.", capabilities: [{ id: "voice", label: "Voice", state: "ready", reason: "Voice available", allowances: [{ remaining: 60, unit: "seconds", expiresAt: deadline }], canEnable: false, canDisable: true }] }; }
function render(active: boolean) { hooks.cursor = 0; hooks.effects = []; const tree = StudyReadiness({ scope, active }); for (const effect of hooks.effects) effect(); return renderToStaticMarkup(tree); }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
let focus: (() => void) | undefined;
beforeEach(() => {
  hooks.cursor = 0; hooks.values = []; hooks.effects = []; hooks.token = "operator-token"; focus = undefined;
  vi.useFakeTimers(); vi.setSystemTime(deadline - 1000);
  const values = new Map<string, string>();
  vi.stubGlobal("window", { sessionStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) }, setTimeout, clearTimeout, addEventListener: (name: string, callback: () => void) => { if (name === "focus") focus = callback; }, removeEventListener: () => {} });
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => { for (const value of hooks.values) value?.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("archive/restore rerenders invalidate in-flight generations and refetch authoritative availability", async () => {
  let deliver!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot())).mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; })).mockResolvedValueOnce(Response.json(snapshot()));
  vi.stubGlobal("fetch", fetcher);
  render(true); await settle(); expect(render(true)).toContain("<span>Ready</span>");
  expect(render(false)).not.toContain("<span>Ready</span>"); await settle();
  expect(fetcher).toHaveBeenCalledTimes(2);
  render(true); await settle(); expect(render(true)).toContain("<span>Ready</span>");
  deliver(Response.json({ ...snapshot(), capabilities: [{ ...snapshot().capabilities[0], state: "off", reason: "Old archived response" }] })); await settle();
  const html = render(true); expect(html).toContain("<span>Ready</span>"); expect(html).not.toContain("Old archived response");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("expired response and focus after throttled timer never render stale Ready or refresh in a loop", async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(snapshot())); vi.stubGlobal("fetch", fetcher);
  render(true); await settle(); expect(render(true)).toContain("<span>Ready</span>");
  vi.setSystemTime(deadline + 1); focus?.(); await settle();
  let html = render(true); expect(html).not.toContain("<span>Ready</span>"); expect(html).toContain("Allowance unavailable");
  expect(fetcher).toHaveBeenCalledTimes(2); focus?.(); await settle(); html = render(true);
  expect(fetcher).toHaveBeenCalledTimes(3); expect(html).not.toContain("<span>Ready</span>"); expect(html).toContain("Turn off");
});

test("auth loss suppresses a late Ready response and retains the scoped original journal", async () => {
  let deliver!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementation(() => new Promise(resolve => { deliver = resolve; })); vi.stubGlobal("fetch", fetcher);
  const original = { scope, expectedRevision: "a".repeat(64), capability: "voice", enabled: true, requestId: "original-request" };
  const key = "corvo.research.readiness.v1.client.project.study.1";
  window.sessionStorage.setItem(key, JSON.stringify(original));
  const controllerRender = render(true); expect(controllerRender).not.toContain("<span>Ready</span>");
  hooks.token = null; render(true); await settle(); deliver(Response.json(snapshot())); await settle();
  const html = render(true); expect(html).not.toContain("<span>Ready</span>"); expect(html).toContain("Check previous attempt");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toEqual(original); expect(fetcher).toHaveBeenCalledOnce();
});


test("focus refreshes a still-fresh observation and a second expiry cannot create polling", async () => {
  vi.setSystemTime(deadline - 600000);
  const fetcher = vi.fn().mockImplementation(async () => Response.json(snapshot())); vi.stubGlobal("fetch", fetcher);
  render(true); await settle(); expect(render(true)).toContain("<span>Ready</span>");
  focus?.(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2); render(true);
  await vi.advanceTimersByTimeAsync(30001); await settle(); render(true); expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(30001); await settle(); expect(render(true)).not.toContain("<span>Ready</span>");
  await vi.advanceTimersByTimeAsync(300000); await settle(); expect(fetcher).toHaveBeenCalledTimes(3);
});

test("future observation wakes rendering within its existing interval without an extra read", async () => {
  vi.setSystemTime(deadline - 600000);
  const observedAt = Date.now() + 1;
  const native = { ...snapshot(), observedAt, validUntil: observedAt + 30000, capabilities: [{ ...snapshot().capabilities[0], state: "off" as const, canEnable: true, canDisable: false }] };
  const fetcher = vi.fn().mockImplementation(async () => Response.json(native)); vi.stubGlobal("fetch", fetcher);
  render(true); await settle();
  expect(render(true)).not.toContain("Enable");
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2); await settle();
  expect(render(true)).toContain("Enable");
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.setSystemTime(native.validUntil);
  expect(render(true)).not.toContain("Enable");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("malformed or far-future observations neither enable nor schedule a boundary timer", async () => {
  vi.setSystemTime(deadline - 600000);
  const start = Date.now();
  const setTimer = vi.spyOn(window, "setTimeout");
  let native = { ...snapshot(), observedAt: start + 60000, validUntil: start + 90000 };
  const fetcher = vi.fn().mockImplementation(async () => Response.json(native)); vi.stubGlobal("fetch", fetcher);
  render(true); await settle(); expect(render(true)).not.toContain("<span>Ready</span>");
  expect(setTimer).not.toHaveBeenCalled();
  native = { ...native, observedAt: start, validUntil: start + 30001 };
  focus?.(); await settle(); expect(render(true)).not.toContain("<span>Ready</span>");
  expect(setTimer).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(3);
});
