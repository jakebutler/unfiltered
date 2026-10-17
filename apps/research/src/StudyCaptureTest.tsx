import { useEffect, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { z } from "zod";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { StudyReadinessScope } from "../../../packages/research-core/src/readiness";
import { CAPTURE_TEST_STATUS_MAX_AGE_MS, STUDY_TEST_ROUTES, type CaptureTestIssue, type CaptureTestReceipt, type CaptureTestStatus, type StudyWelcome, type CaptureTestTerminal, type CaptureTestPreview } from "../../../packages/research-core/src/welcome";
import { DateTime, Field, Notice } from "./components";
import { invitationUrl } from "./state";
import { StudyWelcomePanel } from "./StudyWelcome";
import { CaptureSources } from "./CaptureSources";

const scopeSchema = z.object({ clientId: z.string(), projectId: z.string(), studyId: z.string(), studyVersion: z.number().int().positive() }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().finite().nonnegative();
const deviceSchema = z.object({ browser: z.string().min(1).max(100), platform: z.string().min(1).max(100) }).strict();
const issueSchema = z.object({ scope: scopeSchema, requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/), expectedBinding: digest, device: deviceSchema }).strict();
const terminalSchema = z.object({ input: issueSchema, reason: z.enum(['controlled-dom-authorization-required', 'operator-closed']), closedAt: timestamp }).strict();
const closedSchema = z.object({ state: z.literal('closed'), terminal: terminalSchema }).strict();
const receiptSchema = z.object({ invitationId: z.string(), sessionId: z.string(), requestId: z.string(), scope: scopeSchema, binding: digest, configurationDigest: digest, issuedAt: timestamp, expiresAt: timestamp, retainUntil: timestamp, device: deviceSchema, deviceContext: z.literal("operator-reported"), revokedAt: timestamp.nullable() }).strict();
const welcomeSchema = z.object({ scope: scopeSchema, title: z.string(), introduction: z.string(), prototypeUrl: z.string().nullable(), context: z.object({ organization: z.literal("Corvo Labs"), clientName: z.string(), operatorName: z.string() }).strict(), purpose: z.enum(["participant", "readiness-test"]), consentVersion: z.literal("research-consent-1"), choices: z.array(z.object({ id: z.string(), required: z.boolean(), checked: z.literal(false), label: z.string() }).strict()), capture: z.object({ screen: z.enum(["optional", "expected"]), controlledDom: z.enum(["optional", "expected"]), camera: z.literal("optional"), alternatePath: z.string() }).strict(), fallback: z.string(), deviceNotice: z.string(), lifecycle: z.object({ invitationDays: z.literal(7), retentionDays: z.literal(30), expiresAt: timestamp.nullable(), retainUntil: timestamp.nullable() }).strict() }).strict();
const previewSchema = z.object({ welcome: welcomeSchema, binding: digest, configurationDigest: digest, setup: z.object({ controlledDomRequired: z.boolean(), controlledDomAuthorized: z.boolean() }).strict() }).strict();
const foundReceiptSchema = z.union([closedSchema,z.object({ state: z.literal("unresolved") }).strict(), z.object({ state: z.literal("found"), receipt: receiptSchema }).strict()]);
const statusSchema = z.union([closedSchema,z.object({ state: z.literal("unresolved") }).strict(), z.object({ state: z.literal("found"), receipt: receiptSchema, observedAt: timestamp, validUntil: timestamp, current: z.boolean(), reason: z.string(), domConnected: z.boolean(), event: z.object({ batchId: z.string(), sequence: z.number().int().nonnegative(), kind: z.string(), recordedAt: timestamp, generation: z.number().int().nonnegative(), origin: z.string() }).strict().nullable(), media: z.array(z.object({ mediaId: z.string(), modality: z.string(), availableAt: timestamp, bytes: z.number().int().positive(), sha256: digest, mime: z.string(), startMs: timestamp, endMs: timestamp, partial: z.boolean() }).strict()), recording: z.string(), gaps: z.array(z.object({ modality: z.string(), reason: z.string(), recordedAt: timestamp }).strict()), cleanup: z.string() }).strict()]);
function sameScope(a: StudyReadinessScope, b: StudyReadinessScope) { return a.clientId === b.clientId && a.projectId === b.projectId && a.studyId === b.studyId && a.studyVersion === b.studyVersion; }
export type CaptureTestRequest = (route: string, token: string, input: unknown) => Promise<unknown>;
export async function captureTestRequest(route: string, token: string, input: unknown): Promise<unknown> {
  const response = await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input), credentials: "same-origin", cache: "no-store", referrerPolicy: "same-origin", signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) throw new Error("Result unconfirmed");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 131072) throw new Error("Result unconfirmed"); chunks.push(next.value); } } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

type TestState = { preview: CaptureTestPreview | null; terminal: CaptureTestTerminal | null; original: CaptureTestIssue | null; receipt: CaptureTestReceipt | null; token: string | null; status: CaptureTestStatus | null; history: CaptureTestStatus | null; authorityToken: string | null; busy: boolean; error: string; journalBlocked: boolean };
type Journal = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export class CaptureTestController {
  state: TestState = { preview: null, terminal: null, original: null, receipt: null, token: null, status: null, history: null, authorityToken: null, busy: false, error: "", journalBlocked: false };
  readonly journalKey: string;
  private epoch = 0;
  private expiryReadUsed = false;
  private queuedStatus: { token: string; automatic: boolean; epoch: number } | null = null;
  constructor(readonly scope: StudyReadinessScope, private journal: Journal | null, private request: CaptureTestRequest, private notify: (state: TestState) => void = () => {}) {
    this.journalKey = `corvo.research.capture-test.v1.${scope.clientId}.${scope.projectId}.${scope.studyId}.${scope.studyVersion}`;
    try { const stored = journal?.getItem(this.journalKey); if (stored) { const original = issueSchema.parse(JSON.parse(stored)); if (!sameScope(original.scope, scope)) throw new Error(); this.state.original = original; } }
    catch { this.state.journalBlocked = true; }
  }
  private update(patch: Partial<TestState>) { this.state = { ...this.state, ...patch }; this.notify(this.state);
    if (patch.busy === false && this.queuedStatus) { const queued = this.queuedStatus; this.queuedStatus = null; queueMicrotask(() => { if (queued.epoch === this.epoch) void this.status(queued.token, queued.automatic, true); }); }
  }
  invalidate() { this.epoch++; this.queuedStatus = null; this.expiryReadUsed = false; this.update({ preview: null, terminal: null, receipt: null, token: null, status: null, history: null, authorityToken: null, busy: false, error: "" }); }
  private receipt(value: unknown, original: CaptureTestIssue) {
    const result = receiptSchema.parse(value);
    if (!sameScope(result.scope, original.scope) || result.requestId !== original.requestId || result.binding !== original.expectedBinding || result.device.browser !== original.device.browser || result.device.platform !== original.device.platform) throw new Error();
    if (this.state.receipt && (result.invitationId !== this.state.receipt.invitationId || result.sessionId !== this.state.receipt.sessionId)) throw new Error();
    return result;
  }
  private closed(value: unknown, original: CaptureTestIssue) {
    const terminal = terminalSchema.parse(value);
    if (JSON.stringify(terminal.input) !== JSON.stringify(issueSchema.parse(original))) throw new Error();
    this.update({ terminal, receipt: null, token: null, status: null, history: null, preview: null });
  }
  async closeOriginal(token: string | null) {
    const original = this.state.original; if (!token || !original || this.state.busy || this.state.terminal) return;
    const epoch = this.epoch; this.update({ busy: true, authorityToken: token, error: '' });
    try {
      const result = foundReceiptSchema.parse(await this.request(STUDY_TEST_ROUTES.close, token, original));
      if (epoch !== this.epoch) return;
      if (result.state === 'closed') this.closed(result.terminal, original);
      else if (result.state === 'found') this.update({ receipt: this.receipt(result.receipt, original) });
      else throw new Error();
    } catch { if (epoch === this.epoch) this.update({ error: 'Closing the original request is unconfirmed. Check its receipt; no new test has been issued.' }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
  }
  async preview(token: string | null, active: boolean) {
    if (!token || !active || this.state.busy) return;
    const epoch = this.epoch; this.update({ busy: true, authorityToken: token, preview: null, status: null, error: "" });
    try { const result = previewSchema.parse(await this.request(STUDY_TEST_ROUTES.preview, token, { scope: this.scope })); if (!sameScope(result.welcome.scope, this.scope) || result.welcome.purpose !== "participant") throw new Error(); if (epoch === this.epoch) this.update({ preview: result }); }
    catch { if (epoch === this.epoch) this.update({ error: "The participant preview could not be confirmed. Check it again before issuing a test." }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
  }
  async issue(token: string | null, active: boolean, device: { browser: string; platform: string }) {
    if (!token || !active || this.state.busy || this.state.journalBlocked || !this.state.preview || (this.state.original && !this.state.terminal && this.state.receipt?.revokedAt == null) || (this.state.preview.setup.controlledDomRequired && !this.state.preview.setup.controlledDomAuthorized)) return;
    const epoch = this.epoch;
    let original: CaptureTestIssue;
    try { original = issueSchema.parse({ scope: this.scope, requestId: crypto.randomUUID(), expectedBinding: this.state.preview.binding, device }); if (!this.journal) throw new Error(); this.journal.setItem(this.journalKey, JSON.stringify(original)); }
    catch { this.update({ error: "Enter your browser and platform, and enable session storage before issuing a test link." }); return; }
    this.update({ original, terminal: null, receipt: null, token: null, status: null, history: null, authorityToken: token, busy: true, error: "" });
    try { const result = z.union([closedSchema, z.object({ receipt: receiptSchema, token: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()]).parse(await this.request(STUDY_TEST_ROUTES.issue, token, original)); if (epoch === this.epoch) { if ('state' in result) this.closed(result.terminal, original); else this.update({ receipt: this.receipt(result.receipt, original), token: result.token }); } }
    catch { if (epoch === this.epoch) this.update({ error: "The test link result is unconfirmed. Check the original request; no replacement has been issued." }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
  }
  async checkReceipt(token: string | null) {
    const original = this.state.original; if (!token || !original || this.state.busy) return;
    const epoch = this.epoch; this.update({ busy: true, authorityToken: token, error: "" });
    try { const result = foundReceiptSchema.parse(await this.request(STUDY_TEST_ROUTES.receipt, token, original)); if (epoch !== this.epoch) return; if (result.state === 'closed') this.closed(result.terminal, original); else if (result.state === "found") { const receipt = this.receipt(result.receipt, original); this.update({ receipt, ...(receipt.revokedAt !== null ? { token: null, status: null } : {}) }); } else this.update({ error: "The original request is still unconfirmed. No new test link has been issued." }); }
    catch { if (epoch === this.epoch) this.update({ error: "The original test receipt could not be confirmed. Check again before creating a replacement." }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
  }
  async status(token: string | null, automatic = false, queued = false) {
    const original = this.state.original; if (!token || !original) return;
    if (!queued) { if (automatic && this.expiryReadUsed) return; this.expiryReadUsed = automatic; }
    if (this.state.status?.state === "found") this.update({ status: { ...this.state.status, current: false, reason: "Checking current capture-test authority." } });
    if (this.state.busy) { this.queuedStatus = { token, automatic, epoch: this.epoch }; return; }
    const epoch = this.epoch; this.update({ busy: true, authorityToken: token, error: "" });
    try {
      const result = statusSchema.parse(await this.request(STUDY_TEST_ROUTES.status, token, original));
      if (epoch !== this.epoch) return;
      if (result.state === 'closed') this.closed(result.terminal, original); else if (result.state === "found") {
        const receipt = this.receipt(result.receipt, original);
        const fresh = captureTestWindowValid(result, Date.now());
        const status = this.queuedStatus ? { ...result, current: false, reason: "Rechecking current capture-test authority." } : fresh ? result : { ...result, current: false, reason: "This observation has expired or its freshness could not be confirmed. Check capture evidence again." };
        this.update({ receipt, status, ...(fresh && (result.event || result.media.length) ? { history: result } : {}), ...(receipt.revokedAt !== null ? { token: null } : {}) });
      } else this.update({ error: "Test evidence is unconfirmed. Check the original receipt." });
    } catch { if (epoch === this.epoch) this.update({ error: "Test evidence could not be confirmed. No successful event or upload is claimed." }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
  }
  async revoke(token: string | null, revoke: (receipt: CaptureTestReceipt) => Promise<unknown>) {
    const receipt = this.state.receipt; if (!token || !receipt || receipt.revokedAt !== null || this.state.busy) return;
    const epoch = this.epoch; this.update({ busy: true, status: null, token: null, error: "" });
    try { await revoke(receipt); } catch { if (epoch === this.epoch) this.update({ error: "Revocation is unconfirmed. Check the original receipt before replacing this link." }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
    if (epoch === this.epoch) await this.checkReceipt(token);
  }
}

export function captureTestWindowValid(status: Extract<CaptureTestStatus, { state: "found" }>, now: number) {
  return Number.isFinite(status.observedAt) && Number.isFinite(status.validUntil) && status.observedAt <= now && status.validUntil > now && status.validUntil > status.observedAt && status.validUntil - status.observedAt <= CAPTURE_TEST_STATUS_MAX_AGE_MS && status.validUntil <= Math.min(status.receipt.expiresAt, status.receipt.retainUntil);
}
export function currentCaptureTest(status: CaptureTestStatus | null, now: number, active = true) {
  return status?.state === "found" && active && status.current && status.receipt.revokedAt === null && captureTestWindowValid(status, now);
}
export function CaptureTestEvidence({ status, active, history = null }: { status: CaptureTestStatus | null; active: boolean; history?: CaptureTestStatus | null }) {
  if (!status || status.state === "unresolved") return <p role="status">Capture has not been tested here, or its result is unconfirmed.</p>;
  if (status.state === 'closed') return <p role="status">This original test request is closed. No invitation was created for it.</p>;
  const current = currentCaptureTest(status, Date.now(), active), prior = history?.state === "found" ? history : status;
  return <section aria-label="Capture test evidence">
    {!current ? <Notice>These results do not establish current study readiness. {captureTestWindowValid(status, Date.now()) ? status.reason : "The observation has expired. Check capture evidence again."}</Notice> : null}
    <p>{status.receipt.device.browser} · {status.receipt.device.platform} · reported by the operator</p>
    <p>Test issued <DateTime value={status.receipt.issuedAt} /> · access until <DateTime value={status.receipt.expiresAt} /></p>
    <p>Authority observed <DateTime value={status.observedAt} /> · current proof ends <DateTime value={status.validUntil} />.</p>
    <p>Controlled page: {current && status.domConnected ? "Connected" : current ? "Not connected" : "Connection unconfirmed"}.</p>
    <p>{current && status.event && status.event.kind !== "connected" ? <>Test event received · {status.event.kind} · <DateTime value={status.event.recordedAt} /></> : "No current test event received."}</p>
    {current && status.media.length ? <ul>{status.media.map(media => <li key={media.mediaId}>{media.modality} upload tested · {media.bytes.toLocaleString()} bytes · <DateTime value={media.availableAt} />{media.partial ? " · Partial recording" : ""}</li>)}</ul> : <p>No current recording upload tested.</p>}
    {!current && (prior.event || prior.media.length) ? <details><summary>Dated test history · not current readiness</summary><p>Recorded by the authority at <DateTime value={prior.observedAt} />.</p>{prior.event ? <p>Historical {prior.event.kind} event · <DateTime value={prior.event.recordedAt} />.</p> : null}<ul>{prior.media.map(media => <li key={media.mediaId}>Historical {media.modality} segment · {media.bytes.toLocaleString()} bytes · <DateTime value={media.availableAt} />{media.partial ? " · Partial recording" : ""}</li>)}</ul></details> : null}
    {status.gaps.length ? <Notice>A recording interruption was retained. Uploaded segments do not establish continuous capture.</Notice> : null}
    <p>{current ? "Observed" : "Historical"} recording: {status.recording}. {current ? "Observed" : "Historical"} cleanup: {status.cleanup}.</p>
  </section>;
}

export function StudyCaptureTest({ scope, active }: { scope: StudyReadinessScope; active: boolean }) {
  const authToken = useAuthToken(); const convex = useConvex();
  const [state, setState] = useState<TestState>({ preview: null, terminal: null, original: null, receipt: null, token: null, status: null, history: null, authorityToken: null, busy: false, error: "", journalBlocked: false });
  const [controller, setController] = useState(() => { let storage: Journal | null = null; try { storage = window.sessionStorage; } catch {} return new CaptureTestController(scope, storage, captureTestRequest, setState); });
  const [browser, setBrowser] = useState(""); const [platform, setPlatform] = useState(""); const [copy, setCopy] = useState(""); const [inspect, setInspect] = useState(false);
  const [, setClock] = useState(0);
  const scopeMatches = sameScope(controller.scope, scope), authorizedState = scopeMatches && active && !!authToken && state.authorityToken === authToken;
  useEffect(() => {
    if (scopeMatches) return;
    controller.invalidate(); let storage: Journal | null = null; try { storage = window.sessionStorage; } catch {}
    setController(new CaptureTestController(scope, storage, captureTestRequest, setState));
  }, [controller, scope.clientId, scope.projectId, scope.studyId, scope.studyVersion]);
  useEffect(() => { controller.invalidate(); if (authToken && active && scopeMatches && controller.state.original) void controller.status(authToken); return () => controller.invalidate(); }, [controller, authToken, active]);
  useEffect(() => {
    if (!state.receipt) return;
    const remaining = Math.min(state.receipt.expiresAt, state.receipt.retainUntil) - Date.now();
    const redraw = () => setClock(value => value + 1);
    const timer = remaining > 0 ? window.setTimeout(redraw, Math.min(remaining + 20, 2147483647)) : null;
    window.addEventListener("focus", redraw);
    document.addEventListener("visibilitychange", redraw);
    return () => { if (timer !== null) window.clearTimeout(timer); window.removeEventListener("focus", redraw); document.removeEventListener("visibilitychange", redraw); };
  }, [state.receipt]);
  useEffect(() => {
    if (!authToken || !active || !scopeMatches || !state.original) return;
    const refresh = () => { setClock(value => value + 1); void controller.status(authToken); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [controller, authToken, active, scopeMatches, state.original]);
  useEffect(() => {
    if (!authToken || !active || !scopeMatches || state.status?.state !== "found") return;
    const remaining = state.status.validUntil - Date.now();
    // At most one expiry read per manual/focus/resume cycle. Already expired replies never reschedule.
    const timer = captureTestWindowValid(state.status, Date.now()) && remaining > 0 ? window.setTimeout(() => { setClock(value => value + 1); void controller.status(authToken, true); }, Math.min(remaining, 2147483647)) : null;
    return () => { if (timer !== null) window.clearTimeout(timer); };
  }, [controller, state.status, active, authToken, scopeMatches]);
  const link = authorizedState && state.token && state.receipt?.revokedAt === null && state.receipt.expiresAt > Date.now() ? invitationUrl(window.location.origin, state.token) : null;
  const replace = state.original && (state.terminal !== null || state.receipt?.revokedAt != null);
  const setupMissing = !!state.preview?.setup.controlledDomRequired && !state.preview?.setup.controlledDomAuthorized;
  return <section className="settings" aria-labelledby="study-test-heading">
    <div className="section-heading"><h3 id="study-test-heading">Participant preview and capture test</h3><button type="button" className="secondary" disabled={!authToken || !active || !scopeMatches || state.busy} onClick={() => void controller.preview(authToken, active && scopeMatches)}>Preview participant welcome</button></div>
    <p>Preview makes no invitation or device request. A capture test uses real browser recording and this study’s existing allowance. Test answers and recordings stay out of findings and client reports.</p>
    {state.error ? <Notice error>{state.error}</Notice> : null}
    {state.busy ? <p role="status">Checking the saved study…</p> : null}
    {state.journalBlocked ? <Notice error>The previous test request cannot be read. Ask your operator contact to reconcile it before creating another.</Notice> : null}
    {authorizedState && state.preview ? <details className="participant-welcome-preview" open>
      <summary>Participant welcome · saved study version {state.preview.welcome.scope.studyVersion}</summary>
      <StudyWelcomePanel welcome={state.preview.welcome} />
    </details> : null}
    {authorizedState && setupMissing ? <Notice>Authorize this saved study’s controlled prototype below, then preview the participant welcome again before issuing a capture test.</Notice> : null}
    {authorizedState && state.terminal ? <Notice>{state.terminal.reason === 'operator-closed' ? 'The original request was closed by the authority before a test was created.' : 'The original request was rejected because this saved study’s controlled prototype was not authorized.'} Its outcome is retained. Preview the welcome again before deliberately issuing a new test.</Notice> : null}
    <form onSubmit={event => { event.preventDefault(); void controller.issue(authToken, active && scopeMatches, { browser: browser.trim(), platform: platform.trim() }); }}>
      <Field label="Browser used for the test" hint="Your reported browser, not an automatically verified device."><input required maxLength={100} value={browser} onChange={event => setBrowser(event.target.value)} placeholder="For example, Chrome 141" /></Field>
      <Field label="Platform used for the test"><input required maxLength={100} value={platform} onChange={event => setPlatform(event.target.value)} placeholder="For example, macOS" /></Field>
      <button disabled={!authToken || !active || !scopeMatches || state.busy || state.journalBlocked || !state.preview || setupMissing || (!!state.original && !replace)}>{replace ? "Issue new capture test link" : "Issue capture test link"}</button>
    </form>
    {state.original ? <div className="actions"><button type="button" className="secondary" disabled={!authToken || !scopeMatches || state.busy} onClick={() => void controller.checkReceipt(authToken)}>Check original test receipt</button><button type="button" className="secondary" disabled={!authToken || !scopeMatches || state.busy} onClick={() => void controller.status(authToken)}>Check capture evidence</button></div> : null}
    {state.original && !state.receipt && !state.terminal ? <button type="button" className="secondary" disabled={!authToken || !scopeMatches || state.busy} onClick={() => void controller.closeOriginal(authToken)}>Close unconfirmed original request</button> : null}
    {state.receipt && authorizedState ? <>
      <p>Capture test · study version {state.receipt.scope.studyVersion} · {state.receipt.revokedAt !== null ? "Link revoked" : "Private test link issued"}.</p>
      {link ? <><Field label="Private test link" hint="Copy it now. It cannot be recovered after leaving this view."><input readOnly value={link} onFocus={event => event.target.select()} /></Field><div className="actions"><button type="button" className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopy("Test link copied."); } catch { setCopy("Select the link above and copy it manually."); } }}>Copy test link</button><a className="button secondary" href={link} target="_blank" rel="noreferrer noopener">Open capture test</a></div><p role="status">{copy}</p></> : state.receipt.revokedAt === null ? <Notice>The private link is unavailable. Resolve its receipt, revoke this link, then deliberately issue a replacement.</Notice> : <Notice>The original link is revoked. A replacement uses a new request and does not reset prior recording charges.</Notice>}
      {state.receipt.revokedAt === null ? <button type="button" className="secondary" disabled={state.busy} onClick={() => void controller.revoke(authToken, receipt => convex.mutation(api.invitations.revoke, { clientId: scope.clientId as Id<"researchClients">, projectId: scope.projectId as Id<"researchProjects">, invitationId: receipt.invitationId as Id<"researchInvitations"> }))}>Revoke test link</button> : null}
      <p>In the test tab, agree to the test and start the recording device you want to check. While capture is active, connect the authorized prototype and click one instrumented component. Stop recording to finish the upload, then return here to check evidence. Browser permission is separate from consent.</p>
    </> : null}
    <CaptureTestEvidence status={authorizedState ? state.status : null} active={authorizedState} history={authorizedState ? state.history : null} />
    {state.receipt && authorizedState ? <><button type="button" className="secondary" onClick={() => setInspect(!inspect)}>{inspect ? "Close test sources" : "Inspect retained test sources"}</button>{inspect ? <CaptureSources scope={{ clientId: scope.clientId as Id<"researchClients">, projectId: scope.projectId as Id<"researchProjects">, sessionId: state.receipt.sessionId as Id<"researchSessions"> }} /> : null}</> : null}
  </section>;
}
