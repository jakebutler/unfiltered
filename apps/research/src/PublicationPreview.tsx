import { useRef, useState } from "react";
import { useConvex } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { usePages, useRead } from "./data";
import { Pages } from "./components";
import { errorText } from "./state";
import { canPrepareRevisedPublication, retainCompletedPublication } from "./publication-intent";
import { SourceGrantEditor } from "./SourceGrantEditor";
import type {
  Evidence,
  Excerpt,
  Finding,
  RawGrant,
} from "../../../packages/research-core/src/analysis";
import { evidenceId } from "../../../packages/research-core/src/analysis";
import { DateTime, Field, Notice } from "./components";

export type PublishedEvidence = Pick<Evidence, "kind" | "start" | "end"> & {
  evidenceId: string;
  sessionId?: string;
  sessionLabel?: string;
  fullArtifactLabel?: string;
  sourceUntil?: number;
  sourceAvailable?: boolean;
};
export const reportEvidenceId = (source: Evidence | PublishedEvidence) =>
  "evidenceId" in source ? source.evidenceId : evidenceId(source);
export function uncoveredPublicationCitations(document: Pick<ReportDocument, "findings" | "excerpts" | "grants">): string[] {
  const covered = new Set([
    ...document.excerpts.map((excerpt) => excerpt.evidenceId),
    ...document.grants.filter((grant) => grant.view || grant.download).map((grant) => grant.evidenceId),
  ]);
  return [...new Set(document.findings.flatMap((finding) => [...finding.supports, ...finding.counterevidence]))].filter((id) => !covered.has(id));
}
export type ReportDocument = {
  title: string;
  findings: Finding[];
  evidence: (Evidence | PublishedEvidence)[];
  excerpts: Excerpt[];
  grants: RawGrant[];
};
export const provenanceLabel: Record<
  Finding["type"] | Evidence["kind"],
  string
> = {
  "self-report": "Participant self-report",
  "observed-dom": "Observed page activity",
  "dom-event": "Observed page activity",
  "tentative-screen": "Tentative screen interpretation",
  "screen-observation": "Screen recording",
  "tentative-camera": "Tentative camera observation",
  "camera-observation": "Camera recording",
  interpretation: "Research interpretation",
  audio: "Audio recording",
  "capture-gap": "Capture gap",
};
export function EvidenceLabel({
  source,
}: {
  source: Evidence | PublishedEvidence;
}) {
  return (
    <span>
      {provenanceLabel[source.kind]} ·{" "}
      {"sessionLabel" in source && source.sessionLabel
        ? source.sessionLabel
        : `Session ${source.sessionId?.slice(-8) ?? "selected"}`}{" "}
      ·{" "}
      {source.kind === "self-report"
        ? `characters ${source.start}–${source.end}`
        : source.kind === "dom-event"
          ? `event ${source.start}`
          : `${(source.start / 1000).toFixed(2)}–${(source.end / 1000).toFixed(2)} s`}
    </span>
  );
}
/** This renderer is shared by the exact operator preview and published snapshot. */
export function ReportContent({ document }: { document: ReportDocument }) {
  return (
    <article className="report-content">
      <h1>{document.title}</h1>
      <p className="muted">Prepared by Corvo Labs</p>
      {document.findings.map((finding) => (
        <section className="report-finding" key={finding.id}>
          <h2>{finding.statement}</h2>
          <p className="finding-kind">{provenanceLabel[finding.type]}</p>
          {finding.limitations && (
            <p className="source-text">
              <strong>Scope and limitations. </strong>
              {finding.limitations}
            </p>
          )}
          {(
            [
              ["Supporting evidence", finding.supports],
              ["Counterevidence", finding.counterevidence],
            ] as const
          ).map(
            ([label, refs]) =>
              refs.length > 0 && (
                <div className="report-evidence" key={label}>
                  <h3>{label}</h3>
                  {refs.map((ref) => {
                    const source = document.evidence.find(
                      (e) => reportEvidenceId(e) === ref,
                    );
                    const excerpt = document.excerpts.find(
                      (e) => e.evidenceId === ref,
                    );
                    return (
                      <div key={ref} className="report-citation">
                        {source && (
                          <p className="muted">
                            <EvidenceLabel source={source} />
                          </p>
                        )}
                        {source &&
                          "sourceAvailable" in source &&
                          source.sourceAvailable === false && (
                            <p className="muted">
                              Original source retention has ended. Approved
                              excerpts remain only where retention consent
                              permits.
                            </p>
                          )}
                        {excerpt ? (
                          <blockquote>{excerpt.text}</blockquote>
                        ) : (
                          <p className="muted">
                            Source reference; no excerpt included.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ),
          )}
        </section>
      ))}
      {document.excerpts.filter(
        (excerpt) =>
          !document.findings.some((finding) =>
            [...finding.supports, ...finding.counterevidence].includes(
              excerpt.evidenceId,
            ),
          ),
      ).length > 0 && (
        <section className="report-finding">
          <h2>Additional approved excerpts</h2>
          {document.excerpts
            .filter(
              (excerpt) =>
                !document.findings.some((finding) =>
                  [...finding.supports, ...finding.counterevidence].includes(
                    excerpt.evidenceId,
                  ),
                ),
            )
            .map((excerpt) => {
              const source = document.evidence.find(
                (e) => reportEvidenceId(e) === excerpt.evidenceId,
              );
              return (
                <div className="report-citation" key={excerpt.evidenceId}>
                  {source && (
                    <p className="muted">
                      <EvidenceLabel source={source} />
                    </p>
                  )}
                  <blockquote>{excerpt.text}</blockquote>
                </div>
              );
            })}
        </section>
      )}
      {!document.findings.length && (
        <p className="empty">No findings were selected for this report.</p>
      )}
    </article>
  );
}
export function PublicationPreview({
  document,
  audience,
  pending,
  error,
  onPublish,
  onBack,
}: {
  document: ReportDocument;
  audience: string;
  pending: boolean;
  error: string;
  onPublish: (password: string) => Promise<void>;
  onBack: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const [hasPassword, setHasPassword] = useState(false);
  return (
    <section className="publication-workspace">
      <div className="section-heading">
        <div>
          <h2>Publication preview</h2>
          <p className="muted">Review exactly what {audience} will receive.</p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={onBack}
        >
          Back to private review
        </button>
      </div>
      <div className="publication-layout">
        <div className="publication-paper">
          <ReportContent document={document} />
        </div>
        <aside className="publication-access" aria-label="Publication access">
          <h3>{audience}</h3>
          <p>
            Version and publication time are assigned when this report is
            published.
          </p>
          <dl>
            <dt>Report retention</dt>
            <dd>90 days from publication</dd>
            <dt>Client access</dt>
            <dd>7 days from password-grant issue</dd>
            <dt>Approved excerpts</dt>
            <dd>{document.excerpts.length}</dd>
          </dl>
          <h3>Only these selected sources</h3>
          {document.grants.length ? (
            <ul className="grant-list">
              {document.grants.map((grant) => {
                const source = document.evidence.find(
                  (e) => reportEvidenceId(e) === grant.evidenceId,
                );
                return (
                  <li key={grant.evidenceId}>
                    {source && <EvidenceLabel source={source} />}
                    {source && "fullArtifactLabel" in source && (
                      <p>{source.fullArtifactLabel}</p>
                    )}
                    <p>
                      {grant.view ? "View enabled" : "View not enabled"} ·{" "}
                      {grant.download
                        ? "Download enabled"
                        : "Download not enabled"}
                    </p>
                    {source &&
                      [
                        "audio",
                        "screen-observation",
                        "camera-observation",
                      ].includes(source.kind) && (
                        <p>
                          Access covers the full retained recording segment,
                          including material outside the cited time range.
                        </p>
                      )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">No original source material will be shared.</p>
          )}
          {document.grants.some((g) => g.download) && (
            <Notice>
              Downloaded files cannot be recalled. Expiry or revocation stops
              future access.
            </Notice>
          )}
          <Field
            label="Client report password"
            hint="At least 12 characters. Share the link and password through your chosen secure channel."
          >
            <input
              ref={password}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              disabled={pending}
              onChange={(e) => setHasPassword(e.target.value.length >= 12)}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(e) => setShowPassword(e.target.checked)}
            />
            <span>Show password</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={pending}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I reviewed this exact report, every included excerpt, and its
              access selections.
            </span>
          </label>
          {error && <Notice error>{error}</Notice>}
          <button
            type="button"
            disabled={pending || !!error || !acknowledged || !hasPassword}
            onClick={() => {
              if (password.current) {
                const value = password.current.value;
                password.current.value = "";
                setHasPassword(false);
                void onPublish(value);
              }
            }}
          >
            {pending ? "Publishing…" : "Publish reviewed report"}
          </button>
          <p className="muted">
            Publishing freezes these findings and selections. New sessions and
            private edits do not update this version.
          </p>
        </aside>
      </div>
    </section>
  );
}

type Scope = {
  clientId: Id<"researchClients">;
  projectId: Id<"researchProjects">;
};
export function ReportsWorkspace({
  scope,
  active,
  analysisId,
  onBack,
}: {
  scope: Scope;
  active: boolean;
  analysisId: Id<"researchAnalyses"> | null;
  onBack: () => void;
}) {
  const reports = usePages(api.researchReports.list, scope);
  const convex = useConvex();
  const [withdrawing, setWithdrawing] = useState<Id<"researchReports"> | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <section>
      {analysisId ? (
        <PublicationSetup
          key={analysisId}
          scope={scope}
          analysisId={analysisId}
          active={active}
          onBack={onBack}
          onPublished={() => void reports.refresh()}
        />
      ) : (
        <div className="empty">
          <h2>Published reports</h2>
          <p>
            Open a saved operator review in Findings & review to prepare an
            exact publication preview.
          </p>
        </div>
      )}
      <div className="section-heading">
        <h2>Publication history</h2>
        <button
          type="button"
          className="text-button"
          onClick={() => void reports.refresh()}
        >
          Refresh reports
        </button>
      </div>
      {reports.rows.map((report) => (
        <div className="invite-row" key={report.reportId}>
          <div>
            <strong>
              {report.title} · version {report.version}
            </strong>
            <p>
              {report.state} · published <DateTime value={report.publishedAt} />
            </p>
            <p>
              Report retention ends <DateTime value={report.expiresAt} />
            </p>
            <details>
              <summary>Client access</summary>
              <ShareAccess scope={scope} reportId={report.reportId} />
            </details>
          </div>
          {report.state === "published" && (
            <div>
              <button
                type="button"
                className="secondary"
                disabled={pending}
                onClick={() => setWithdrawing(report.reportId)}
              >
                Withdraw report
              </button>
              {withdrawing === report.reportId && (
                <div className="revoke-confirm">
                  <p>
                    Stop future client access to this published version?
                    Previously downloaded files cannot be recalled.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={async () => {
                        setPending(true);
                        setError("");
                        try {
                          await convex.mutation(api.researchReports.withdraw, {
                            ...scope,
                            reportId: report.reportId,
                          });
                          setWithdrawing(null);
                        } catch (err) {
                          setError(errorText(err));
                        } finally {
                          setPending(false);
                          void reports.refresh();
                        }
                      }}
                    >
                      Confirm withdrawal
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={pending}
                      onClick={() => setWithdrawing(null)}
                    >
                      Keep published
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      <Pages {...reports} />
      {!reports.loading && !reports.error && !reports.rows.length && (
        <p className="empty">No report has been published for this project.</p>
      )}
      {error && <Notice error>{error}</Notice>}
    </section>
  );
}
function PublicationSetup({
  scope,
  analysisId,
  active,
  onBack,
  onPublished,
}: {
  scope: Scope;
  analysisId: Id<"researchAnalyses">;
  active: boolean;
  onBack: () => void;
  onPublished: () => void;
}) {
  const analysis = useRead(api.researchAnalysis.read, { ...scope, analysisId });
  const project = useRead(api.research.project, scope);
  const convex = useConvex();
  const token = useAuthToken();
  const [title, setTitle] = useState("");
  const [grants, setGrants] = useState<RawGrant[]>([]);
  const [args, setArgs] = useState<{
    clientId: Scope["clientId"];
    projectId: Scope["projectId"];
    analysisId: Id<"researchAnalyses">;
    reviewRevision: number;
    title: string;
    grants: RawGrant[];
  } | null>(null);
  const preview = useRead(api.researchReports.preview, args);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const storageKey = `corvo.research.publication-request.${scope.clientId}.${scope.projectId}.${analysisId}`;
  const [requestId, setRequestId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const [previousRevision, setPreviousRevision] = useState<number | null>(() => {
    try {
      const value = sessionStorage.getItem(`${storageKey}.revision`);
      return value !== null && /^\d+$/.test(value) ? Number(value) : null;
    } catch { return null; }
  });
  const original = useRead(
    api.researchReports.requestStatus,
    requestId ? { ...scope, requestId } : null,
  );
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<{
    reportId: Id<"researchReports">;
    version: number;
    publishedAt: number;
    expiresAt: number;
  } | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(
    null,
  );
  async function publish(password: string) {
    if (!args || !preview.data || busy.current || requestId || !active) return;
    const id = crypto.randomUUID();
    try {
      sessionStorage.setItem(`${storageKey}.revision`, String(args.reviewRevision));
      sessionStorage.setItem(storageKey, id);
    } catch {
      setError(
        "This browser could not retain the publication identifier. Enable session storage before publishing.",
      );
      return;
    }
    setRequestId(id);
    setPreviousRevision(args.reviewRevision);
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const published = await convex.mutation(api.researchReports.publish, {
        ...args,
        previewHash: preview.data.previewHash,
        requestId: id,
      });
      setReceipt(published);
      onPublished();
      const response = await fetch("/api/research/shares", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...scope,
          reportId: published.reportId,
          password,
          requestId: id,
        }),
      });
      if (!response.ok) throw new Error("Client access result unconfirmed");
      const share = await response.json();
      if (typeof share.url !== "string" || typeof share.expiresAt !== "number")
        throw new Error("Missing access receipt");
      const url = new URL(share.url, window.location.origin);
      if (url.origin !== window.location.origin)
        throw new Error("Unexpected client access URL");
      setLink({ url: url.href, expiresAt: share.expiresAt });
    } catch {
      setError(
        "Publication or client-access result is unconfirmed. Refresh publication history to check the original request. No new publication or password grant has been requested.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const confirmedReceipt = receipt ?? original.data;
  const canRevise = canPrepareRevisedPublication(confirmedReceipt, analysis.data, previousRevision, pending);
  function prepareRevised() {
    if (!canRevise || !requestId || !confirmedReceipt) return;
    try {
      retainCompletedPublication(sessionStorage, storageKey, requestId, confirmedReceipt, previousRevision);
    } catch {
      setError("The original publication receipt could not be retained. Keep this request and check browser storage before preparing another report.");
      return;
    }
    setRequestId(null);
    setPreviousRevision(null);
    setReceipt(null);
    setLink(null);
    setArgs(null);
    setTitle("");
    setGrants([]);
    setError("");
  }
  const revisedAction = canRevise && (
    <div>
      <p>The saved review has changed. Preparing a revised report keeps the original published version and receipt. Review the new selections before publishing.</p>
      <button type="button" className="secondary" onClick={prepareRevised}>Prepare revised report</button>
    </div>
  );
  if (requestId && !pending && !receipt)
    return (
      <Notice>
        Publication request {requestId} is retained.{" "}
        {original.data ? (
          <>
            <p>
              Original publication confirmed: version {original.data.version}.
            </p>
            <ShareAccess scope={scope} reportId={original.data.reportId} />
            {revisedAction}
          </>
        ) : (
          <p>
            The publication result remains unconfirmed. No new publication is
            requested.
          </p>
        )}
        <button type="button" className="secondary" onClick={original.refresh}>
          Check original publication
        </button>
        {original.error && <Notice error>{original.error}</Notice>}
        {error && <p>{error}</p>}
      </Notice>
    );
  if (receipt)
    return (
      <div className="issued-invite">
        <h2>Version {receipt.version} published</h2>
        <p>
          Published <DateTime value={receipt.publishedAt} /> · retained until{" "}
          <DateTime value={receipt.expiresAt} />
        </p>
        {link ? (
          <>
            <Field label="Password-protected client report link">
              <input
                readOnly
                value={link.url}
                onFocus={(e) => e.target.select()}
              />
            </Field>
            <p>
              Client access expires <DateTime value={link.expiresAt} />
            </p>
            <a
              className="button secondary"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open client report
            </a>
            <p className="muted">
              Share this link and the password separately. No email has been
              sent.
            </p>
          </>
        ) : (
          <>
            <Notice error>
              {error || "Client access is not confirmed yet."}
            </Notice>
            <ShareAccess scope={scope} reportId={receipt.reportId} />
          </>
        )}
        <button type="button" className="secondary" onClick={onBack}>
          Back to findings
        </button>
        {revisedAction}
      </div>
    );
  if (analysis.error || project.error)
    return <Notice error>{analysis.error || project.error}</Notice>;
  if (!analysis.data || !project.data)
    return <p role="status">Opening report review…</p>;
  if (!analysis.data.reviewedAt || analysis.data.state !== "ready")
    return (
      <Notice>
        Save an operator review of this exact analysis revision before preparing
        publication.
      </Notice>
    );
  if (args && preview.data)
    return (
      <PublicationPreview
        document={clientProjection(preview.data)}
        audience={`${preview.data.clientName} / ${preview.data.projectName}`}
        pending={pending}
        error={error}
        onPublish={publish}
        onBack={() => {
          if (!requestId) setArgs(null);
        }}
      />
    );
  function grant(id: string, key: "view" | "download", checked: boolean) {
    setGrants((old) => {
      const current = old.find((g) => g.evidenceId === id) ?? {
        evidenceId: id,
        view: false,
        download: false,
      };
      const next = { ...current, [key]: checked };
      return [
        ...old.filter((g) => g.evidenceId !== id),
        ...(next.view || next.download ? [next] : []),
      ];
    });
  }
  const uncovered = uncoveredPublicationCitations({
    findings: analysis.data.findings,
    excerpts: analysis.data.excerpts,
    grants,
  });
  return (
    <div className="settings stack">
      <h2>Prepare publication</h2>
      <p className="muted">
        Reviewed conclusions and approved excerpts are fixed to revision{" "}
        {analysis.data.revision}. Choose access to original sources separately.
      </p>
      <Field label="Report title">
        <input
          value={title}
          maxLength={160}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <h3>Original source access</h3>
      {uncovered.length > 0 && (
        <Notice>
          {uncovered.length} cited {uncovered.length === 1 ? "source needs" : "sources need"} an approved excerpt or original source access before preview.
          <p>
            Return to private review to approve exact text excerpts, or enable view or download for each cited source below. Original source access exposes the whole artifact.
          </p>
          <button type="button" className="secondary" onClick={onBack}>
            Back to private review
          </button>
        </Notice>
      )}
      {analysis.data.evidence
        .filter((e) => e.kind !== "capture-gap")
        .map((source) => {
          const id = evidenceId(source),
            selected = grants.find((g) => g.evidenceId === id);
          return (
            <div key={id} className="evidence-choice">
              <p>
                <EvidenceLabel source={source} />
              </p>
              {uncovered.includes(id) && (
                <p className="muted">Cited source: approve an excerpt in private review or choose original source access.</p>
              )}
              <p className="muted">
                Grants cover the entire source turn, masked event batch, or
                retained recording segment. Cited ranges do not clip the shared
                artifact.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected?.view ?? false}
                  onChange={(e) => grant(id, "view", e.target.checked)}
                />
                <span>Allow original source view</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected?.download ?? false}
                  onChange={(e) => grant(id, "download", e.target.checked)}
                />
                <span>Allow original source download</span>
              </label>
            </div>
          );
        })}
      {preview.error && <Notice error>{preview.error}</Notice>}
      {args && !preview.data && !preview.error && (
        <p role="status">Checking exact publication selections…</p>
      )}
      <button
        type="button"
        disabled={!active || !title.trim() || uncovered.length > 0 || (!!args && !preview.error)}
        onClick={() =>
          setArgs({
            ...scope,
            analysisId,
            reviewRevision: analysis.data!.revision,
            title,
            grants,
          })
        }
      >
        Preview exactly what the client will receive
      </button>
    </div>
  );
}

function ShareAccess({
  scope,
  reportId,
}: {
  scope: Scope;
  reportId: Id<"researchReports">;
}) {
  const shares = useRead(api.researchPortal.shares, { ...scope, reportId });
  const convex = useConvex();
  const token = useAuthToken();
  const password = useRef<HTMLInputElement>(null);
  const issuing = useRef(false);
  const storageKey = `corvo.research.share-request.${scope.clientId}.${scope.projectId}.${reportId}`;
  const [request, setRequest] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const [showPassword, setShowPassword] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [revoking, setRevoking] = useState<Id<"researchShares"> | null>(null);
  const [editing, setEditing] = useState<Id<"researchShares"> | null>(null);
  const [error, setError] = useState("");
  return (
    <section className="share-access">
      <p className="muted">
        Password grants are separate from publication. Expiry and revocation
        stop future access; downloaded files cannot be recalled.
      </p>
      {shares.error && <Notice error>{shares.error}</Notice>}
      {!shares.data && !shares.error && (
        <p role="status">Checking client grants…</p>
      )}
      {shares.data?.map((share) => (
        <div className="source" key={share.shareId}>
          <strong>
            {share.revokedAt
              ? "Revoked client access"
              : share.expiresAt <= Date.now()
                ? "Expired client access"
                : "Active client access"}
          </strong>
          <p>
            Issued <DateTime value={share.issuedAt} /> · ends{" "}
            <DateTime value={share.expiresAt} />
          </p>
          <p className="muted">
            Access revision {share.revision} ·{" "}
            {share.grants.filter((g) => g.view).length} source views ·{" "}
            {share.grants.filter((g) => g.download).length} source downloads
          </p>
          {!share.revokedAt && share.expiresAt > Date.now() && (
            <>
              <Field label="Client report link">
                <input
                  readOnly
                  value={`${window.location.origin}/report/${share.slug}`}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
              <button type="button" className="secondary" disabled={pending} onClick={() => setEditing(editing === share.shareId ? null : share.shareId)}>
                {editing === share.shareId ? "Close source permissions" : "Edit source permissions"}
              </button>
              {editing === share.shareId && <SourceGrantEditor scope={scope} share={share} onSaved={() => { setEditing(null); shares.refresh(); }} />}
              <button
                type="button"
                className="secondary"
                disabled={pending}
                onClick={() => setRevoking(share.shareId)}
              >
                Revoke client access
              </button>
              {revoking === share.shareId && (
                <div className="revoke-confirm">
                  <p>
                    Stop this password grant and all its original source access?
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={async () => {
                        setPending(true);
                        setError("");
                        try {
                          await convex.mutation(
                            api.researchPortal.revokeShare,
                            {
                              ...scope,
                              shareId: share.shareId,
                              expectedRevision: share.revision,
                            },
                          );
                          setRevoking(null);
                        } catch {
                          setError(
                            "Revocation result is unconfirmed. Refresh access to check the original grant before another change.",
                          );
                        } finally {
                          setPending(false);
                          shares.refresh();
                        }
                      }}
                    >
                      Confirm revocation
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={pending}
                      onClick={() => setRevoking(null)}
                    >
                      Keep access
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {shares.data?.length === 0 && (
        <p className="muted">
          No password grant has been issued for this report.
        </p>
      )}
      {request ? (
        <Notice>
          {shares.data?.some((share) => share.requestId === request)
            ? "Original password grant confirmed above."
            : "Password-grant result is unconfirmed. Keep this request for reconciliation; no new grant will be requested."}
        </Notice>
      ) : (
        <div className="access-issue stack">
          <h3>Issue password access</h3>
          <Field
            label="New client report password"
            hint="At least 12 characters. The password is submitted once to this research server."
          >
            <input
              ref={password}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              disabled={pending}
              onChange={(event) =>
                setHasPassword(event.target.value.length >= 12)
              }
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
            />
            <span>Show password</span>
          </label>
          <button
            type="button"
            disabled={pending || !hasPassword || !token}
            onClick={async () => {
              if (issuing.current || !password.current) return;
              issuing.current = true;
              const value = password.current.value;
              password.current.value = "";
              setHasPassword(false);
              const id = crypto.randomUUID();
              try {
                sessionStorage.setItem(storageKey, id);
              } catch {
                issuing.current = false;
                setError(
                  "Enable session storage to retain this request identifier before issuing access.",
                );
                return;
              }
              setRequest(id);
              setPending(true);
              setError("");
              try {
                const response = await fetch("/api/research/shares", {
                  method: "POST",
                  credentials: "same-origin",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    ...scope,
                    reportId,
                    requestId: id,
                    password: value,
                  }),
                });
                if (!response.ok) throw new Error();
              } catch {
                setError(
                  "Password-grant result is unconfirmed. Refresh access to check the original request.",
                );
              } finally {
                issuing.current = false;
                setPending(false);
                shares.refresh();
              }
            }}
          >
            Issue password access for this report
          </button>
        </div>
      )}
      {error && <Notice error>{error}</Notice>}
      <button type="button" className="text-button" onClick={shares.refresh}>
        Refresh client access
      </button>
    </section>
  );
}

export function clientProjection(document: ReportDocument): ReportDocument {
  const aliases = new Map(
    document.evidence.map((source, index) => [
      reportEvidenceId(source),
      `e${index + 1}`,
    ]),
  );
  const sessions = [
    ...new Set(document.evidence.map((source) => source.sessionId)),
  ];
  return {
    ...document,
    findings: document.findings.map((finding) => ({
      ...finding,
      supports: finding.supports.map((id) => aliases.get(id)!),
      counterevidence: finding.counterevidence.map((id) => aliases.get(id)!),
    })),
    excerpts: document.excerpts.map((excerpt) => ({
      ...excerpt,
      evidenceId: aliases.get(excerpt.evidenceId)!,
    })),
    grants: document.grants.map((grant) => ({
      ...grant,
      evidenceId: aliases.get(grant.evidenceId)!,
    })),
    evidence: document.evidence.map((source) => ({
      kind: source.kind,
      start: source.start,
      end: source.end,
      evidenceId: aliases.get(reportEvidenceId(source))!,
      sessionLabel: `Session ${sessions.indexOf(source.sessionId) + 1}`,
      ...("fullArtifactLabel" in source
        ? { fullArtifactLabel: source.fullArtifactLabel }
        : {}),
    })),
  };
}
