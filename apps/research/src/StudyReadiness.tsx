import { useEffect, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { z } from "zod";
import { DateTime, Notice } from "./components";
import { STUDY_READINESS_MAX_AGE_MS, STUDY_READINESS_ROUTES, type StudyCapability, type StudyReadinessCommand, type StudyReadinessScope, type StudyReadinessSnapshot } from "../../../packages/research-core/src/readiness";

const scopeSchema = z.object({ clientId: z.string(), projectId: z.string(), studyId: z.string(), studyVersion: z.number().int().positive() }).strict();
const capabilitySchema = z.enum(["scripted-text", "goal-aware-interview", "voice", "private-capture", "analysis", "screen-baseline", "controlled-dom"]);
const time = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const allowanceSchema = z.object({ remaining: count, unit: z.enum(["requests", "calls", "seconds", "characters", "bytes", "storage-operations"]), expiresAt: time }).strict();
const capacitySchema = z.object({ interviewCalls: count, speechSeconds: count, speechCharacters: count, captureBytes: count, analysisCalls: count }).strict();
const snapshotSchema = z.object({
  scope: scopeSchema, revision: z.string().regex(/^[a-f0-9]{64}$/), observedAt: time, validUntil: time.optional(), expiresAt: time.nullable(), fallback: z.string(), runtimeConfigurationDigest: z.string().optional(),
  capabilities: z.array(z.object({ id: capabilitySchema, label: z.string(), state: z.enum(["off", "setup-required", "ready", "exhausted", "unresolved"]), reason: z.string(), allowances: z.array(allowanceSchema), canEnable: z.boolean(), canDisable: z.boolean() }).strict()).max(7),
  deploymentAllowances: z.array(allowanceSchema.extend({ unit: z.enum(["requests", "bytes", "storage-operations"]) })).optional(),
  envelope: z.object({ name: z.string(), expiresAt: time, committed: capacitySchema, remainingUncommitted: capacitySchema }).strict().optional(),
}).strict();
const commandSchema = z.object({ scope: scopeSchema, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), capability: capabilitySchema, enabled: z.boolean(), requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/) }).strict();
const receiptSchema = z.object({ requestId: z.string(), command: commandSchema, state: z.enum(["accepted", "denied"]), reason: z.string(), snapshot: snapshotSchema }).strict();
const readbackSchema = z.union([z.object({ state: z.literal("found"), receipt: receiptSchema }).strict(), z.object({ state: z.literal("unresolved") }).strict()]);
type Journal = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ReadinessState = { snapshot: StudyReadinessSnapshot | null; pending: StudyReadinessCommand | null; busy: boolean; error: string; message: string; journalBlocked: boolean; authorityToken: string | null };
export type ReadinessRequest = (route: string, token: string, command?: StudyReadinessCommand) => Promise<unknown>;
function sameScope(a: StudyReadinessScope, b: StudyReadinessScope) { return a.clientId === b.clientId && a.projectId === b.projectId && a.studyId === b.studyId && a.studyVersion === b.studyVersion; }
function sameCommand(a: StudyReadinessCommand, b: StudyReadinessCommand) { return sameScope(a.scope, b.scope) && a.expectedRevision === b.expectedRevision && a.capability === b.capability && a.enabled === b.enabled && a.requestId === b.requestId; }
function readinessObservationWellFormed(snapshot: StudyReadinessSnapshot) {
  return typeof snapshot.validUntil === "number" && Number.isFinite(snapshot.validUntil) && Number.isFinite(snapshot.observedAt) && snapshot.validUntil > snapshot.observedAt && snapshot.validUntil - snapshot.observedAt <= STUDY_READINESS_MAX_AGE_MS;
}
export function readinessObservationValid(snapshot: StudyReadinessSnapshot, now: number) {
  return readinessObservationWellFormed(snapshot) && snapshot.observedAt <= now && snapshot.validUntil! > now;
}
function budgetDeadlines(snapshot: StudyReadinessSnapshot, row: StudyReadinessSnapshot["capabilities"][number]) {
  if (["scripted-text", "screen-baseline", "controlled-dom"].includes(row.id)) return [];
  const gateway = row.id === "voice" || row.id === "private-capture" ? snapshot.deploymentAllowances ?? [] : [];
  return [snapshot.expiresAt, snapshot.envelope?.expiresAt, ...row.allowances.map(value => value.expiresAt), ...gateway.map(value => value.expiresAt)].filter((value): value is number => typeof value === "number");
}
export function readinessDeadlines(snapshot: StudyReadinessSnapshot) {
  return [snapshot.validUntil, ...snapshot.capabilities.filter(row => row.state === "ready" || row.canEnable).flatMap(row => budgetDeadlines(snapshot, row))].filter((value): value is number => typeof value === "number");
}
function expiredAvailability(snapshot: StudyReadinessSnapshot, now: number) {
  return !readinessObservationValid(snapshot, now) || snapshot.capabilities.some(row => (row.state === "ready" || row.canEnable) && budgetDeadlines(snapshot, row).some(deadline => deadline <= now));
}
/** Conservative display only; retained revision/accounting and OFF controls stay authoritative. */
export function currentReadiness(snapshot: StudyReadinessSnapshot, now: number, active = true): StudyReadinessSnapshot {
  return { ...snapshot, capabilities: snapshot.capabilities.map(row => {
    if (!(row.state === "ready" || row.canEnable)) return row;
    if (!active) return { ...row, state: "off", canEnable: false, reason: "This client or project is archived. Participant access is stopped." };
    if (!readinessObservationValid(snapshot, now)) return { ...row, state: "setup-required", canEnable: false, reason: "This observation has expired. Check availability again before enabling or inviting participants." };
    if (budgetDeadlines(snapshot, row).some(deadline => deadline <= now)) return { ...row, state: "exhausted", canEnable: false, reason: "This capability’s allowance has expired. Check availability again." };
    return row;
  }) };
}

/** Bounded same-origin transport. It never retries a command. */
export async function readinessRequest(route: string, token: string, command?: StudyReadinessCommand): Promise<unknown> {
  const response = await fetch(route, { method: command ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(command ? { "Content-Type": "application/json" } : {}) }, credentials: "same-origin", cache: "no-store", referrerPolicy: "same-origin", signal: AbortSignal.timeout(15_000), ...(command ? { body: JSON.stringify(command) } : {}) });
  if (!response.ok || !response.body) throw new Error("Availability unconfirmed");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 131072) throw new Error("Availability unconfirmed"); chunks.push(next.value); } } finally { await reader.cancel().catch(() => undefined); }
  const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
}

/** Nonsecret command journal survives navigation; absence of a receipt never resends. */
export class StudyReadinessController {
  state: ReadinessState = { snapshot: null, pending: null, busy: false, error: "", message: "", journalBlocked: false, authorityToken: null };
  readonly journalKey: string;
  private epoch = 0;
  private active = true;
  private expiryReadUsed = false;
  private queuedRefresh: { token: string; epoch: number } | null = null;
  constructor(readonly scope: StudyReadinessScope, private journal: Journal | null, private request: ReadinessRequest, private notify: (state: ReadinessState) => void = () => {}) {
    this.journalKey = `corvo.research.readiness.v1.${scope.clientId}.${scope.projectId}.${scope.studyId}.${scope.studyVersion}`;
    try {
      const saved = journal?.getItem(this.journalKey);
      if (saved) { const command = commandSchema.parse(JSON.parse(saved)); if (!sameScope(command.scope, scope)) throw new Error(); this.state.pending = command; }
    } catch { this.state.journalBlocked = true; this.state.error = "The previous change cannot be read. Ask your operator contact to reconcile it before making another change."; }
  }
  private update(patch: Partial<ReadinessState>) { this.state = { ...this.state, ...patch }; this.notify(this.state);
    if (patch.busy === false && this.queuedRefresh) { const queued = this.queuedRefresh; this.queuedRefresh = null; queueMicrotask(() => { if (queued.epoch === this.epoch) void this.refresh(queued.token, false, true); }); }
  }
  invalidate() { this.epoch++; this.queuedRefresh = null; this.expiryReadUsed = false; this.update({ snapshot: null, authorityToken: null, busy: false, message: "", error: "" }); }
  async setContext(token: string | null, active: boolean) { this.active = active; this.invalidate(); await this.refresh(token); }
  private snapshot(value: unknown) { const parsed = snapshotSchema.parse(value); if (!sameScope(parsed.scope, this.scope)) throw new Error(); return parsed; }
  async refresh(token: string | null, recheckExpired = true, queued = false) {
    if (!queued && recheckExpired) this.expiryReadUsed = false;
    if (this.state.busy) { if (token) this.queuedRefresh = { token, epoch: this.epoch }; this.update({ snapshot: null }); return; }
    if (!token) { this.update({ snapshot: null, error: "Sign in to check this study’s availability." }); return; }
    this.update({ busy: true, snapshot: null, authorityToken: token, error: "", message: "" });
    const epoch = this.epoch;
    try {
      const query = new URLSearchParams({ ...this.scope, studyVersion: String(this.scope.studyVersion) });
      const route = `${STUDY_READINESS_ROUTES.snapshot}?${query}`;
      const result = this.snapshot(await this.request(route, token));
      if (epoch !== this.epoch) return;
      const expired = expiredAvailability(result, Date.now());
      this.update({ snapshot: this.queuedRefresh ? null : result });
      // At most one fresh read for a late Ready response. An expired authoritative
      // response remains safely displayed and cannot create an automatic loop.
      if (expired && recheckExpired && !this.queuedRefresh) {
        this.expiryReadUsed = true;
        const next = this.snapshot(await this.request(route, token));
        if (epoch === this.epoch) this.update({ snapshot: this.queuedRefresh ? null : next });
      }
    }
    catch { if (epoch === this.epoch) this.update({ snapshot: null, error: "Availability could not be confirmed. Check again before inviting participants. If checking again fails, sign out and sign in, then reopen this study. Check any previous attempt before making another change." }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
  }
  async change(token: string | null, capability: StudyCapability, enabled: boolean, active: boolean) {
    const snapshot = this.state.snapshot, row = snapshot?.capabilities.find(item => item.id === capability);
    if (!token || ((!active || !this.active) && enabled) || this.state.busy || this.state.pending || this.state.journalBlocked || !snapshot || !row || !(enabled ? row.canEnable : row.canDisable)) return;
    if (enabled && (!readinessObservationValid(snapshot, Date.now()) || budgetDeadlines(snapshot, row).some(deadline => deadline <= Date.now()))) { await this.checkExpiry(token); return; }
    const command: StudyReadinessCommand = { scope: this.scope, expectedRevision: snapshot.revision, capability, enabled, requestId: crypto.randomUUID() };
    try { if (!this.journal) throw new Error(); this.journal.setItem(this.journalKey, JSON.stringify(command)); }
    catch { this.update({ error: "This browser cannot save a recovery reference. Enable session storage before changing availability." }); return; }
    this.update({ busy: true, pending: command, authorityToken: token, snapshot: null, error: "", message: "" });
    const epoch = this.epoch;
    let expired = false;
    try { const result = await this.request(STUDY_READINESS_ROUTES.command, token, command); if (epoch === this.epoch) expired = this.accept(result, command); }
    catch { if (epoch === this.epoch) this.update({ snapshot: null, error: "The change is unconfirmed. Check the previous attempt before making another change." }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
    if (epoch === this.epoch && expired) await this.refresh(token, false);
  }
  private accept(value: unknown, original: StudyReadinessCommand) {
    const receipt = receiptSchema.parse(value);
    if (receipt.requestId !== original.requestId || !sameCommand(receipt.command, original)) throw new Error();
    const snapshot = this.snapshot(receipt.snapshot);
    if (!this.journal) throw new Error(); this.journal.removeItem(this.journalKey);
    this.update({ pending: null, snapshot, error: receipt.state === "denied" ? receipt.reason : "", message: receipt.state === "accepted" ? "Change accepted. Current availability is shown below." : "" });
    return expiredAvailability(snapshot, Date.now());
  }
  async checkPrevious(token: string | null) {
    const original = this.state.pending;
    if (!token || !original || this.state.busy) return;
    this.update({ busy: true, snapshot: null, authorityToken: token, error: "", message: "" });
    const epoch = this.epoch;
    let expired = false;
    try {
      const result = readbackSchema.parse(await this.request(STUDY_READINESS_ROUTES.receipt, token, original));
      if (epoch !== this.epoch) return;
      if (result.state === "found") expired = this.accept(result.receipt, original);
      else this.update({ error: "The previous attempt is still unconfirmed. No change has been sent again." });
    } catch { if (epoch === this.epoch) this.update({ error: "The previous attempt could not be confirmed. Keep this recovery reference and check again." }); }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
    if (epoch === this.epoch && expired) await this.refresh(token, false);
  }
  async refreshOnResume(token: string | null) { this.expiryReadUsed = false; await this.refresh(token, false); }
  async checkExpiry(token: string | null) {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    // Wake rendering at the observation or expiry boundary without destroying
    // the native facts. Every display and enable still checks the current clock.
    this.update({ snapshot: { ...snapshot } });
    if (!expiredAvailability(snapshot, Date.now())) return;
    if (!this.expiryReadUsed) { this.expiryReadUsed = true; await this.refresh(token, false); }
  }
}

export function StudyReadiness({ scope, active }: { scope: StudyReadinessScope; active: boolean }) {
  const token = useAuthToken();
  const [state, setState] = useState<ReadinessState>({ snapshot: null, pending: null, busy: false, error: "", message: "", journalBlocked: false, authorityToken: null });
  const [controller, setController] = useState(() => { let storage: Journal | null = null; try { storage = window.sessionStorage; } catch {} return new StudyReadinessController(scope, storage, readinessRequest, setState); });
  const scopeMatches = sameScope(controller.scope, scope), authorizedState = scopeMatches && !!token && state.authorityToken === token;
  useEffect(() => { if (scopeMatches) return; controller.invalidate(); let storage: Journal | null = null; try { storage = window.sessionStorage; } catch {} setController(new StudyReadinessController(scope, storage, readinessRequest, setState)); }, [controller, scope.clientId, scope.projectId, scope.studyId, scope.studyVersion]);
  useEffect(() => { if (scopeMatches) void controller.setContext(token, active); return () => controller.invalidate(); }, [controller, token, active]);
  useEffect(() => {
    if (!token || !scopeMatches) return;
    const refresh = () => { void controller.refreshOnResume(token); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [controller, token, scopeMatches]);
  useEffect(() => {
    if (!state.snapshot || state.busy || !authorizedState || !readinessObservationWellFormed(state.snapshot)) return;
    const now = Date.now();
    const futureBoundary = state.snapshot.observedAt > now && state.snapshot.observedAt - now <= STUDY_READINESS_MAX_AGE_MS ? state.snapshot.observedAt : null;
    if (!readinessObservationValid(state.snapshot, now) && futureBoundary === null) return;
    const deadlines = [...(futureBoundary === null ? [] : [futureBoundary]), ...readinessDeadlines(state.snapshot)].filter(value => value > now);
    const timer = deadlines.length ? window.setTimeout(() => { void controller.checkExpiry(token); }, Math.min(Math.min(...deadlines) - Date.now() + 1, 2147483647)) : null;
    return () => { if (timer !== null) window.clearTimeout(timer); };
  }, [controller, state.snapshot, state.busy, token, authorizedState]);
  const displayed = authorizedState && state.snapshot ? currentReadiness(state.snapshot, Date.now(), active) : null;
  return <StudyReadinessView snapshot={displayed} error={state.error} refreshing={state.busy} onRefresh={scopeMatches ? () => void controller.refresh(token) : undefined}>
    {state.pending ? <Notice>The previous availability change is unconfirmed. Other changes are paused.
      <button type="button" className="secondary" disabled={state.busy || !token || !scopeMatches} onClick={() => void controller.checkPrevious(token)}>Check previous attempt</button>
    </Notice> : null}
    {state.message ? <Notice>{state.message}</Notice> : null}
    {state.journalBlocked ? <Notice error>The previous change cannot be read. Ask your operator contact to reconcile it before making another change.</Notice> : null}
    {displayed && !state.error ? <div className="actions">{displayed.capabilities.filter(row => row.canEnable || row.canDisable).map(row => <button key={row.id} type="button" className="secondary" disabled={(!active && row.canEnable) || !token || state.busy || !!state.pending || state.journalBlocked} onClick={() => void controller.change(token, row.id, row.canEnable, active)}>{row.canEnable ? "Enable" : "Turn off"} {row.label}</button>)}</div> : null}
  </StudyReadinessView>;
}

const stateLabels = {
  off: "Off",
  "setup-required": "Needs setup",
  ready: "Ready",
  exhausted: "Allowance unavailable",
  unresolved: "Check previous attempt",
} as const;

export function StudyReadinessView({ snapshot, error, refreshing = false, onRefresh, children }: {
  snapshot: StudyReadinessSnapshot | null;
  error?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  children?: import("react").ReactNode;
}) {
  snapshot = snapshot ? currentReadiness(snapshot, Date.now()) : null;
  return <section className="settings study-readiness" aria-labelledby="study-readiness-heading">
    <div className="section-heading">
      <div>
        <h3 id="study-readiness-heading">Study availability</h3>
        <p className="muted">Synthetic research · availability can change during a session.</p>
      </div>
      {onRefresh ? <button type="button" className="secondary" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? "Checking…" : "Check availability"}
      </button> : null}
    </div>
    {error ? <Notice error>{error} Availability is unconfirmed.</Notice> : null}
    {children}
    {!snapshot || error ? <p role="status">{refreshing ? "Checking this saved study’s availability…" : "Availability is unconfirmed. Check before inviting participants."}</p> : <>
      <p>Saved study version {snapshot.scope.studyVersion} · checked <DateTime value={snapshot.observedAt} /></p>
      <p className="muted">Open a mode for setup details and its remaining allowance.</p>
      <ul className="readiness-list">
        {snapshot.capabilities.map(capability => <li key={capability.id}>
          <details open={capability.state === "unresolved"}>
            <summary><strong>{capability.label}</strong><span>{stateLabels[capability.state]}</span></summary>
            <div className="readiness-detail">
              <p>{capability.reason}</p>
              {capability.allowances.length ? <ul>{capability.allowances.map((allowance, index) => <li key={`${allowance.unit}:${index}`}>
                Remaining: {allowance.remaining.toLocaleString()} {allowance.unit} · ends <DateTime value={allowance.expiresAt} />
              </li>)}</ul> : null}
            </div>
          </details>
        </li>)}
      </ul>
      {snapshot.expiresAt !== null ? <p>Approved allowance ends <DateTime value={snapshot.expiresAt} />.</p> : null}
      {snapshot.envelope ? <details><summary>Shared capacity</summary><p>Issued capacity is committed to studies. Turning a mode off does not return it.</p><ul>{([
        ["Interview calls", "interviewCalls"], ["Speech seconds", "speechSeconds"], ["Speech characters", "speechCharacters"], ["Recording bytes", "captureBytes"], ["Analysis calls", "analysisCalls"],
      ] as const).map(([label, key]) => <li key={key}>{label}: {snapshot.envelope!.committed[key].toLocaleString()} issued · {snapshot.envelope!.remainingUncommitted[key].toLocaleString()} unassigned</li>)}</ul><p>Shared capacity ends <DateTime value={snapshot.envelope.expiresAt} />.</p></details> : null}
      {snapshot.deploymentAllowances?.length ? <details><summary>Deployment limits</summary><p>These gateway ceilings are separate from this study’s remaining allowance.</p><ul>{snapshot.deploymentAllowances.map((allowance, index) => <li key={`${allowance.unit}:${index}`}>{allowance.remaining.toLocaleString()} {allowance.unit} remaining · ends <DateTime value={allowance.expiresAt} /></li>)}</ul></details> : null}
      <p>{snapshot.fallback}</p>
      <p className="muted">Ready means this mode can accept a request; completion is confirmed separately. Participant consent and browser permissions are still required.</p>
    </>}
  </section>;
}
