import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CaptureTestController, CaptureTestEvidence, currentCaptureTest, captureTestRequest } from "../src/StudyCaptureTest";
import { studyWelcome, type CaptureTestIssue, type CaptureTestReceipt, type CaptureTestStatus } from "../../../packages/research-core/src/welcome";
const scope = { clientId: "client", projectId: "project", studyId: "study", studyVersion: 2 };
const binding = "a".repeat(64), configurationDigest = "b".repeat(64);
const welcome = studyWelcome({ scope, title: "Checkout study", introduction: "Try the synthetic checkout.", prototypeUrl: "https://example.test/prototype", clientName: "Synthetic client", operatorName: "Corvo operator" });
const preview = { welcome, binding, configurationDigest, setup: { controlledDomRequired: false, controlledDomAuthorized: false } };
function journal() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
function receipt(original: CaptureTestIssue, revokedAt: number | null = null): CaptureTestReceipt { return { scope, requestId: original.requestId, invitationId: "invite", sessionId: "session", binding, configurationDigest, issuedAt: Date.now(), expiresAt: Date.now() + 60000, retainUntil: Date.now() + 120000, device: original.device, deviceContext: "operator-reported", revokedAt }; }
const device = { browser: "Chrome", platform: "macOS" };

test("preview has no issuance side effect; lost ACK restores exact receipt-only request without secret persistence", async () => {
  const storage = journal();
  const request = vi.fn().mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error("lost ACK"));
  const controller = new CaptureTestController(scope, storage, request);
  await controller.preview("token", true); expect(controller.state.original).toBeNull(); expect(storage.values.size).toBe(0);
  await controller.issue("token", true, device); const original = controller.state.original!;
  expect(controller.state.receipt).toBeNull(); expect(storage.values.size).toBe(1);
  await controller.issue("token", true, device); expect(request).toHaveBeenCalledTimes(2);
  const recovery = vi.fn().mockResolvedValueOnce({ state: "unresolved" }).mockResolvedValueOnce({ state: "found", receipt: receipt(original) });
  const remount = new CaptureTestController(scope, storage, recovery);
  await remount.checkReceipt("token"); expect(remount.state.receipt).toBeNull();
  await remount.checkReceipt("token");
  expect(recovery.mock.calls.map(call => call[0])).toEqual(["/api/research/capture-test/receipt", "/api/research/capture-test/receipt"]);
  expect(recovery.mock.calls.map(call => call[2])).toEqual([original, original]);
  expect(remount.state.token).toBeNull();
  expect(JSON.parse([...storage.values.values()][0])).toEqual(original);
});

test("receipt-confirmed revoke precedes deliberate replacement; unknown revoke cannot create another session", async () => {
  let revokedAt: number | null = null;
  const request = vi.fn(async (route: string, _token: string, input: any) => route.endsWith("study-welcome") ? preview : route.endsWith("/issue") ? { receipt: receipt(input), token: "c".repeat(64) } : { state: "found", receipt: receipt(input, revokedAt) });
  const controller = new CaptureTestController(scope, journal(), request);
  await controller.preview("token", true); await controller.issue("token", true, device);
  const original = controller.state.original!; const revoke = vi.fn().mockRejectedValue(new Error("lost revoke ACK"));
  await controller.revoke("token", revoke); expect(revoke).toHaveBeenCalledOnce(); expect(controller.state.token).toBeNull();
  await controller.issue("token", true, device); expect(request.mock.calls.filter(call => call[0].endsWith("/issue"))).toHaveLength(1);
  revokedAt = Date.now(); await controller.checkReceipt("token");
  await controller.issue("token", true, device);
  expect(controller.state.original!.requestId).not.toBe(original.requestId);
  expect(request.mock.calls.filter(call => call[0].endsWith("/issue"))).toHaveLength(2);
});

test("invalid scope/binding, unavailable journal and in-flight context invalidation cannot issue or reveal a link", async () => {
  const wrong = new CaptureTestController(scope, journal(), vi.fn().mockResolvedValue({ ...preview, welcome: { ...welcome, scope: { ...scope, studyVersion: 3 } } }));
  await wrong.preview("token", true); expect(wrong.state.preview).toBeNull();
  const noStorageRequest = vi.fn().mockResolvedValue(preview), noStorage = new CaptureTestController(scope, null, noStorageRequest);
  await noStorage.preview("token", true); await noStorage.issue("token", true, device); expect(noStorageRequest).toHaveBeenCalledOnce();
  let deliver!: (value: unknown) => void;
  const request = vi.fn().mockResolvedValueOnce(preview).mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
  const controller = new CaptureTestController(scope, journal(), request);
  await controller.preview("token", true); const issue = controller.issue("token", true, device); const original = controller.state.original!;
  controller.invalidate(); deliver({ receipt: receipt(original), token: "c".repeat(64) }); await issue;
  expect(controller.state.token).toBeNull(); expect(controller.state.original).toEqual(original);
  const mismatch = vi.fn().mockResolvedValue({ state: "found", receipt: { ...receipt(original), binding: "d".repeat(64) } });
  const restored = new CaptureTestController(scope, { getItem: () => JSON.stringify(original), setItem: () => {}, removeItem: () => {} }, mismatch);
  await restored.checkReceipt("token"); expect(restored.state.receipt).toBeNull(); expect(restored.state.original).toEqual(original);
});

test("connection alone is not an event; stale/expired/archived proof cannot advertise upload or event success", () => {
  const original: CaptureTestIssue = { scope, requestId: "original-request", expectedBinding: binding, device };
  const status: CaptureTestStatus = { state: "found", receipt: receipt(original), observedAt: Date.now(), validUntil: Date.now() + 30000, current: true, reason: "", domConnected: true, event: null, media: [], recording: "active", gaps: [], cleanup: "retained" };
  let html = renderToStaticMarkup(<CaptureTestEvidence status={status} active />);
  expect(html).toContain("Controlled page: Connected"); expect(html).toContain("No current test event received"); expect(html).toContain("No current recording upload tested");
  const evidence = { ...status, event: { batchId: "batch", sequence: 1, kind: "click", recordedAt: Date.now(), generation: 1, origin: "https://example.test" }, media: [{ mediaId: "media", modality: "screen", availableAt: Date.now(), bytes: 100, sha256: "e".repeat(64), mime: "video/webm", startMs: 0, endMs: 1000, partial: true }] };
  html = renderToStaticMarkup(<CaptureTestEvidence status={evidence} active />); expect(html).toContain("Test event received"); expect(html).toContain("screen upload tested"); expect(html).toContain("Partial recording"); expect(html).toContain("reported by the operator");
  for (const props of [{ status: { ...evidence, current: false }, active: true }, { status: { ...evidence, receipt: { ...evidence.receipt, expiresAt: Date.now() - 1 } }, active: true }, { status: evidence, active: false }]) {
    html = renderToStaticMarkup(<CaptureTestEvidence {...props} />); expect(html).not.toContain("screen upload tested"); expect(html).not.toContain("Test event received ·"); expect(html).toContain("do not establish current study readiness");
  }
});

test("transport is authenticated exact POST with bounded private read and no retry", async () => {
  const input = { scope }; const fetcher = vi.fn().mockResolvedValue(Response.json(preview)); vi.stubGlobal("fetch", fetcher);
  try { await captureTestRequest("/api/research/study-welcome", "private-token", input); expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer private-token", "Content-Type": "application/json" }, body: JSON.stringify(input), credentials: "same-origin", cache: "no-store", referrerPolicy: "same-origin" }); fetcher.mockResolvedValue(new Response("x".repeat(131073))); await expect(captureTestRequest("/api/research/study-welcome", "private-token", input)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(2); } finally { vi.unstubAllGlobals(); }
});


test("expired, absent, oversized and future proof windows reject current claims while keeping dated references", async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 10, 12));
  try {
    const original: CaptureTestIssue = { scope, requestId: "original-request", expectedBinding: binding, device };
    const proof = { state: "found" as const, receipt: receipt(original), observedAt: Date.now(), validUntil: Date.now() + 30000, current: true, reason: "", domConnected: true, event: { batchId: "batch", sequence: 1, kind: "click", recordedAt: Date.now(), generation: 1, origin: "https://example.test" }, media: [], recording: "active", gaps: [], cleanup: "retained" };
    expect(currentCaptureTest(proof, Date.now())).toBe(true);
    for (const invalid of [{ ...proof, validUntil: Date.now() }, { ...proof, validUntil: Date.now() + 30001 }, { ...proof, observedAt: Date.now() + 1 }]) expect(currentCaptureTest(invalid, Date.now())).toBe(false);
    let deliver!: (value: unknown) => void;
    const storage = { getItem: () => JSON.stringify(original), setItem: () => {}, removeItem: () => {} };
    const controller = new CaptureTestController(scope, storage, vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const pending = controller.status("token"); vi.advanceTimersByTime(30000); deliver(proof); await pending;
    expect(controller.state.status?.state === "found" && controller.state.status.current).toBe(false);
    const html = renderToStaticMarkup(<CaptureTestEvidence status={controller.state.status} active />);
    expect(html).toContain("Historical click event"); expect(html).not.toContain("Test event received ·"); expect(html).toContain("Connection unconfirmed");
    const malformed = new CaptureTestController(scope, storage, vi.fn().mockResolvedValue({ ...proof, observedAt: undefined, validUntil: undefined }));
    await malformed.status("token"); expect(malformed.state.status).toBeNull(); expect(malformed.state.error).toContain("could not be confirmed");
  } finally { vi.useRealTimers(); }
});


test('required prototype setup blocks issuance until a new authoritative preview confirms authorization', async () => {
  const request = vi.fn().mockResolvedValueOnce({ ...preview, setup: { controlledDomRequired: true, controlledDomAuthorized: false } }).mockResolvedValueOnce({ ...preview, setup: { controlledDomRequired: true, controlledDomAuthorized: true } }).mockImplementation(async (_route, _auth, input) => ({ receipt: receipt(input), token: 'c'.repeat(64) }));
  const controller = new CaptureTestController(scope, journal(), request);
  await controller.preview('auth', true); await controller.issue('auth', true, device); expect(controller.state.original).toBeNull(); expect(request).toHaveBeenCalledOnce();
  await controller.preview('auth', true); await controller.issue('auth', true, device); expect(controller.state.receipt).not.toBeNull(); expect(request).toHaveBeenCalledTimes(3);
});
test('unconfirmed original remains blocked through remount and lost close; authoritative terminal requires fresh preview and deliberate new issue', async () => {
  const storage = journal(), issueRequest = vi.fn().mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error('lost ACK'));
  const first = new CaptureTestController(scope, storage, issueRequest); await first.preview('auth', true); await first.issue('auth', true, device); const original = first.state.original!;
  const terminal = { input: original, reason: 'operator-closed' as const, closedAt: Date.now() };
  const request = vi.fn().mockResolvedValueOnce({ state: 'unresolved' }).mockRejectedValueOnce(new Error('lost close ACK')).mockResolvedValueOnce({ state: 'closed', terminal }).mockResolvedValueOnce(preview).mockImplementation(async (_route, _auth, input) => ({ receipt: receipt(input), token: 'c'.repeat(64) }));
  const controller = new CaptureTestController(scope, storage, request); await controller.checkReceipt('auth'); await controller.closeOriginal('auth'); await controller.issue('auth', true, device); expect(controller.state.original).toEqual(original); expect(controller.state.terminal).toBeNull(); expect(request).toHaveBeenCalledTimes(2);
  await controller.checkReceipt('auth'); expect(controller.state.terminal).toEqual(terminal); expect(JSON.parse([...storage.values.values()][0])).toEqual(original); await controller.issue('auth', true, device); expect(request).toHaveBeenCalledTimes(3);
  await controller.preview('auth', true); await controller.issue('auth', true, device); expect(controller.state.original!.requestId).not.toBe(original.requestId); expect(request.mock.calls.map(x=>x[0])).toEqual(['/api/research/capture-test/receipt','/api/research/capture-test/close','/api/research/capture-test/receipt','/api/research/study-welcome','/api/research/capture-test/issue']);
});
test('close accepted outcome keeps original receipt; malformed terminal cannot authorize new issue', async () => {
  const original: CaptureTestIssue = { scope, requestId: 'stable-test-request', expectedBinding: binding, device }, storage = journal(); storage.setItem(`corvo.research.capture-test.v1.${scope.clientId}.${scope.projectId}.${scope.studyId}.${scope.studyVersion}`, JSON.stringify(original));
  const request = vi.fn().mockResolvedValueOnce({ state: 'closed', terminal: { input: { ...original, requestId: 'different-request' }, reason: 'operator-closed', closedAt: Date.now() } }).mockResolvedValueOnce({ state: 'found', receipt: receipt(original) });
  const controller = new CaptureTestController(scope, storage, request); await controller.closeOriginal('auth'); expect(controller.state.terminal).toBeNull(); await controller.closeOriginal('auth'); expect(controller.state.receipt).toEqual(receipt(original)); expect(controller.state.token).toBeNull(); await controller.issue('auth', true, device); expect(request).toHaveBeenCalledTimes(2);
});
