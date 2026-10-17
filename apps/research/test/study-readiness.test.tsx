import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyReadinessView, StudyReadinessController, currentReadiness } from "../src/StudyReadiness";

import type { StudyReadinessSnapshot } from "../../../packages/research-core/src/readiness";

const snapshot: StudyReadinessSnapshot = {
  scope: { clientId: "client", projectId: "project", studyId: "study", studyVersion: 2 }, revision: "a".repeat(64), observedAt: Date.UTC(2026, 9, 10, 12), validUntil: Date.UTC(2026, 9, 10, 12) + 30000,
  expiresAt: Date.UTC(2026, 9, 11, 12),
  fallback: "Continue with the saved text interview when voice is unavailable.",
  capabilities: [
    { id: "scripted-text", label: "Text interview", state: "ready", reason: "Saved script available.", canEnable: false, canDisable: false, allowances: [] },
    { id: "voice", label: "Voice", state: "off", reason: "Voice is off for this study.", canEnable: true, canDisable: false, allowances: [{ remaining: 60, unit: "seconds", expiresAt: Date.UTC(2026, 9, 11, 12) }] },
    { id: "private-capture", label: "Private recordings", state: "setup-required", reason: "Storage needs setup.", canEnable: false, canDisable: false, allowances: [] },
    { id: "analysis", label: "Analysis", state: "exhausted", reason: "No calls remain.", canEnable: false, canDisable: true, allowances: [{ remaining: 0, unit: "calls", expiresAt: Date.UTC(2026, 9, 11, 12) }] },
    { id: "goal-aware-interview", label: "Goal-aware interview", state: "unresolved", reason: "The previous request is unconfirmed.", canEnable: false, canDisable: false, allowances: [] },
  ],
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(snapshot.observedAt); });
afterEach(() => vi.useRealTimers());

test("each saved-version capability remains distinct, with finite allowance and fallback", () => {
  const html = renderToStaticMarkup(<StudyReadinessView snapshot={snapshot} />);
  for (const label of ["Ready", "Off", "Needs setup", "Allowance unavailable", "Check previous attempt", "Saved study version 2", "60 seconds", "0 calls", snapshot.fallback]) expect(html).toContain(label);
  expect(html).toContain('dateTime="2026-10-11T12:00:00.000Z"');
  expect(html).toContain("Participant consent and browser permissions are still required");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("Enable");
});

test("failed or absent readiness cannot leave a ready capability visible", () => {
  for (const props of [{ snapshot: null }, { snapshot, error: "The study changed." }]) {
    const html = renderToStaticMarkup(<StudyReadinessView {...props} />);
    expect(html).toContain("Availability is unconfirmed");
    expect(html).not.toContain("Text interview");
    expect(html).not.toContain("Saved script available");
  }
});

test("read-only refresh is a named keyboard button and pending state prevents repeated checks", () => {
  const html = renderToStaticMarkup(<StudyReadinessView snapshot={null} refreshing onRefresh={vi.fn()} />);
  expect(html).toContain('type="button"');
  expect(html).toContain("disabled");
  expect(html).toContain("Checking…");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("Ready");
});

function journal() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function receipt(command: import("../../../packages/research-core/src/readiness").StudyReadinessCommand, state: "accepted" | "denied" = "accepted") {
  return { command, requestId: command.requestId, state, reason: state === "denied" ? "Readiness changed; refresh before enabling." : "accepted", snapshot };
}

test("ambiguous command survives remount; refresh and unresolved receipt never send a new command", async () => {
  const storage = journal();
  const request = vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("lost ACK"));
  const first = new StudyReadinessController(snapshot.scope, storage, request);
  await first.refresh("operator-token");
  await first.change("operator-token", "voice", true, true);
  const original = first.state.pending!;
  expect(original.expectedRevision).toBe(snapshot.revision);
  expect(first.state.snapshot).toBeNull();
  expect(storage.values.size).toBe(1);
  const recovery = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ state: "unresolved" }).mockResolvedValueOnce({ state: "found", receipt: receipt(original) });
  const second = new StudyReadinessController(snapshot.scope, storage, recovery);
  await second.refresh("operator-token");
  await second.change("operator-token", "analysis", false, true);
  expect(recovery).toHaveBeenCalledTimes(1);
  await second.checkPrevious("operator-token");
  expect(second.state.pending).toEqual(original);
  expect(second.state.snapshot).toBeNull();
  await second.checkPrevious("operator-token");
  expect(recovery.mock.calls.slice(1).map(call => call[0])).toEqual(["/api/research/study-readiness/receipt", "/api/research/study-readiness/receipt"]);
  expect(recovery.mock.calls[1][2]).toEqual(original);
  expect(recovery.mock.calls[2][2]).toEqual(original);
  expect(second.state.pending).toBeNull();
  expect(storage.values.size).toBe(0);
});

test("denied stale change resolves journal truthfully, and wrong-scope or mismatched receipt stays unresolved", async () => {
  const storage = journal();
  const request = vi.fn(async (_route: string, _token: string, command?: import("../../../packages/research-core/src/readiness").StudyReadinessCommand) => command ? receipt(command, "denied") : snapshot);
  const controller = new StudyReadinessController(snapshot.scope, storage, request);
  await controller.refresh("token"); await controller.change("token", "voice", true, true);
  expect(controller.state.pending).toBeNull(); expect(controller.state.error).toContain("Readiness changed");
  expect(storage.values.size).toBe(0);
  request.mockImplementation(async (_route, _token, command) => command ? { ...receipt(command), command: { ...command, enabled: false } } : snapshot);
  await controller.refresh("token"); await controller.change("token", "voice", true, true);
  expect(controller.state.pending).not.toBeNull(); expect(controller.state.snapshot).toBeNull();
  const wrongScope = new StudyReadinessController(snapshot.scope, journal(), vi.fn().mockResolvedValue({ ...snapshot, scope: { ...snapshot.scope, studyVersion: 3 } }));
  await wrongScope.refresh("token"); expect(wrongScope.state.snapshot).toBeNull();
});

test("storage failure prevents dispatch; concurrent clicks charge no second command; auth invalidation discards late ready", async () => {
  const unavailable = new StudyReadinessController(snapshot.scope, null, vi.fn().mockResolvedValue(snapshot));
  await unavailable.refresh("token"); await unavailable.change("token", "voice", true, true);
  expect(unavailable.state.pending).toBeNull(); expect(unavailable.state.error).toContain("session storage");
  let finish!: (value: unknown) => void;
  const request = vi.fn().mockResolvedValueOnce(snapshot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new StudyReadinessController(snapshot.scope, journal(), request);
  await controller.refresh("token");
  const change = controller.change("token", "voice", true, true);
  await controller.change("token", "voice", true, true);
  expect(request).toHaveBeenCalledTimes(2);
  controller.invalidate(); await controller.refresh(null);
  finish(receipt(controller.state.pending!)); await change;
  expect(controller.state.snapshot).toBeNull(); expect(controller.state.pending).not.toBeNull();
});

test("OFF and archived project do not prevent receipt recovery or allowed deactivation", async () => {
  const storage = journal();
  const request = vi.fn(async (_route: string, _token: string, command?: import("../../../packages/research-core/src/readiness").StudyReadinessCommand) => command ? receipt(command) : snapshot);
  const controller = new StudyReadinessController(snapshot.scope, storage, request);
  await controller.refresh("token");
  await controller.change("token", "voice", true, false); expect(request).toHaveBeenCalledOnce();
  await controller.change("token", "analysis", false, false); expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][2]?.enabled).toBe(false);
});

test("parent issuance and deployment ceilings are not represented as study remaining usage", () => {
  const capacity = { interviewCalls: 1, speechSeconds: 2, speechCharacters: 3, captureBytes: 4, analysisCalls: 5 };
  const html = renderToStaticMarkup(<StudyReadinessView snapshot={{ ...snapshot, envelope: { name: "demo", expiresAt: snapshot.expiresAt!, committed: capacity, remainingUncommitted: { ...capacity, interviewCalls: 9 } }, deploymentAllowances: [{ remaining: 123, unit: "requests", expiresAt: snapshot.expiresAt! }] }} />);
  expect(html).toContain("1 issued · 9 unassigned");
  expect(html).toContain("Turning a mode off does not return it");
  expect(html).toContain("gateway ceilings are separate");
  expect(html).toContain("123 requests remaining");
});

test("late expired Ready response is suppressed immediately and receives only one bounded fresh read", async () => {
  vi.useFakeTimers(); vi.setSystemTime(snapshot.expiresAt! - 1);
  try {
    let deliver!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; })).mockResolvedValue(snapshot);
    const controller = new StudyReadinessController(snapshot.scope, journal(), request);
    const pending = controller.refresh("token");
    vi.setSystemTime(snapshot.expiresAt! + 1); deliver(snapshot); await pending;
    expect(request).toHaveBeenCalledTimes(2);
    expect(currentReadiness(controller.state.snapshot!, Date.now()).capabilities.some(row => row.state === "ready" || row.canEnable)).toBe(false);
    const html = renderToStaticMarkup(<StudyReadinessView snapshot={controller.state.snapshot} />);
    expect(html).not.toContain("<span>Ready</span>");
    await controller.change("token", "voice", true, true);
    await controller.checkExpiry("token");
    expect(request).toHaveBeenCalledTimes(2);
    await controller.change("token", "analysis", false, true);
    expect(request.mock.calls[2][0]).toBe("/api/research/study-readiness/command");
  } finally { vi.useRealTimers(); }
});

test("throttled expiry blocks local enable and receipt arrival after expiry resolves without a replay", async () => {
  vi.useFakeTimers(); vi.setSystemTime(snapshot.expiresAt! - 1);
  try {
    const request = vi.fn().mockImplementation(async () => ({ ...snapshot, observedAt: snapshot.expiresAt! - 1, validUntil: snapshot.expiresAt! + 29999 }));
    const controller = new StudyReadinessController(snapshot.scope, journal(), request);
    await controller.refresh("token"); vi.setSystemTime(snapshot.expiresAt! + 1);
    await controller.change("token", "voice", true, true);
    expect(request.mock.calls.every(call => call[0].startsWith("/api/research/study-readiness?"))).toBe(true);
    vi.setSystemTime(snapshot.expiresAt! - 1);
    const storage = journal(); let deliver!: (value: unknown) => void;
    const commands = vi.fn().mockResolvedValueOnce({ ...snapshot, observedAt: snapshot.expiresAt! - 1, validUntil: snapshot.expiresAt! + 29999 }).mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; })).mockImplementation(async () => ({ ...snapshot, observedAt: snapshot.expiresAt! - 1, validUntil: snapshot.expiresAt! + 29999 }));
    const late = new StudyReadinessController(snapshot.scope, storage, commands);
    await late.refresh("token"); const change = late.change("token", "voice", true, true); const original = late.state.pending!;
    vi.setSystemTime(snapshot.expiresAt! + 1); deliver(receipt(original)); await change;
    expect(late.state.pending).toBeNull(); expect(storage.values.size).toBe(0);
    expect(currentReadiness(late.state.snapshot!, Date.now()).capabilities.find(row => row.id === "voice")?.canEnable).toBe(false);
    expect(commands.mock.calls.map(call => call[0])).toEqual([expect.stringContaining("study-readiness?"), "/api/research/study-readiness/command", expect.stringContaining("study-readiness?")]);
  } finally { vi.useRealTimers(); }
});


test("fresh script and DOM do not inherit expired parent or deployment budgets; only relevant capabilities do", () => {
  const past = Date.now() - 1;
  const native = { ...snapshot, expiresAt: past, deploymentAllowances: [{ remaining: 0, unit: "requests" as const, expiresAt: past }], capabilities: [...snapshot.capabilities, { ...snapshot.capabilities[0], id: "controlled-dom" as const, label: "DOM" }] };
  const current = currentReadiness(native, Date.now());
  expect(current.capabilities.filter(row => ["scripted-text", "controlled-dom"].includes(row.id)).map(row => row.state)).toEqual(["ready", "ready"]);
  expect(current.capabilities.find(row => row.id === "voice")?.canEnable).toBe(false);
  for (const stale of [{ ...native, validUntil: Date.now() }, { ...native, validUntil: undefined }, { ...native, observedAt: Date.now() + 1 }]) expect(currentReadiness(stale, Date.now()).capabilities.some(row => row.state === "ready" || row.canEnable)).toBe(false);
});

test("a future callback retains native facts but enables only within the unchanged valid interval", async () => {
  vi.setSystemTime(snapshot.observedAt - 1);
  const request = vi.fn().mockResolvedValue(snapshot);
  const controller = new StudyReadinessController(snapshot.scope, journal(), request);
  await controller.refresh("token");
  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.state.snapshot?.capabilities.find(row => row.id === "voice")?.canEnable).toBe(true);
  expect(currentReadiness(controller.state.snapshot!, Date.now()).capabilities.find(row => row.id === "voice")?.canEnable).toBe(false);
  await controller.change("token", "voice", true, true);
  expect(request).toHaveBeenCalledTimes(2);
  vi.setSystemTime(snapshot.observedAt + 18000);
  await controller.checkExpiry("token");
  expect(currentReadiness(controller.state.snapshot!, Date.now()).capabilities.find(row => row.id === "voice")?.canEnable).toBe(true);
  expect(controller.state.snapshot?.validUntil).toBe(snapshot.validUntil);
  vi.setSystemTime(snapshot.validUntil!);
  await controller.change("token", "voice", true, true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(currentReadiness(controller.state.snapshot!, Date.now()).capabilities.find(row => row.id === "voice")?.canEnable).toBe(false);
});
