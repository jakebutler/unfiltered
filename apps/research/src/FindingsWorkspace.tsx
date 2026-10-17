import { useEffect, useRef, useState } from "react";
import { StudyAnalysisRequest } from "./StudyAnalysisRequest";
import { useConvex } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import {
  evidenceId,
  type Finding,
  type Excerpt,
  type Evidence,
  type Selection,
} from "../../../packages/research-core/src/analysis";
import { usePages, useRead } from "./data";
import { DateTime, Field, Notice, Pages } from "./components";
import { errorText } from "./state";
import { EvidenceLabel, provenanceLabel } from "./PublicationPreview";
import { boundedSourceBlob } from "./ClientReportApp";
import { useNavigationGuard, useStudyDraftProtection } from "./navigation";

type Scope = {
  clientId: Id<"researchClients">;
  projectId: Id<"researchProjects">;
};
type Analysis = FunctionReturnType<typeof api.researchAnalysis.read>;
export function analysisReadinessGet(token: string | null) {
  return fetch('/api/research/analysis/readiness', {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'same-origin',
  });
}
export function FindingsWorkspace({
  scope,
  active,
  onReviewed,
  latestStudyVersion,
}: {
  scope: Scope;
  active: boolean;
  latestStudyVersion: number;
  onReviewed: (id: Id<"researchAnalyses">) => void;
}) {
  const allowNavigation = useNavigationGuard();
  const list = usePages(api.researchAnalysis.list, scope);
  const [selected, setSelected] = useState<Id<"researchAnalyses"> | null>(null);
  const read = useRead(
    api.researchAnalysis.read,
    selected ? { ...scope, analysisId: selected } : null,
  );
  return (
    <section>
      <div className="section-heading">
        <div>
          <h2>Findings & review</h2>
          <p className="muted">
            Private interpretations stay connected to their original evidence.
          </p>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            void list.refresh();
            read.refresh();
          }}
        >
          Refresh analysis status
        </button>
      </div>
      <AnalysisSelection
        latestStudyVersion={latestStudyVersion}
        scope={scope}
        active={active}
        onCreated={(id) => {
          setSelected(id);
          void list.refresh();
        }}
      />
      {list.rows.length > 0 && (
        <Field label="Private analysis">
          <select
            value={selected ?? ""}
            onChange={(e) => {
              if (allowNavigation())
                setSelected((e.target.value || null) as typeof selected);
            }}
          >
            <option value="">Choose an analysis</option>
            {list.rows.map((row) => (
              <option key={row.analysisId} value={row.analysisId}>
                {new Date(row.createdAt).toLocaleString()} · {row.state} ·
                revision {row.revision}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Pages {...list} />
      {read.error && (
        <Notice error>
          {read.error}{" "}
          <button type="button" onClick={read.refresh}>
            Check access again
          </button>
        </Notice>
      )}
      {selected && !read.data && !read.error && (
        <p role="status">Opening private findings…</p>
      )}
      {read.data && (
        <AnalysisReview
          key={read.data.analysisId}
          scope={scope}
          analysis={read.data}
          active={active}
          refresh={read.refresh}
          onReviewed={onReviewed}
        />
      )}
      {!selected && !list.loading && !list.error && (
        <div className="empty">
          <h3>Choose sources before drafting findings</h3>
          <p>
            Unknown, negative, incomplete and contradictory answers remain
            evidence. Missing recordings do not establish inactivity.
          </p>
        </div>
      )}
    </section>
  );
}
function AnalysisReview({
  scope,
  analysis,
  active,
  refresh,
  onReviewed,
}: {
  scope: Scope;
  analysis: Analysis;
  active: boolean;
  refresh: () => void;
  onReviewed: (id: Id<"researchAnalyses">) => void;
}) {
  const convex = useConvex();
  const [baseRevision, setBaseRevision] = useState(analysis.revision);
  const [findings, setFindings] = useState<Finding[]>(analysis.findings);
  const [excerpts, setExcerpts] = useState<Excerpt[]>(analysis.excerpts);
  const [inspected, setInspected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useStudyDraftProtection(dirty);
  const source = analysis.evidence.find((e) => evidenceId(e) === inspected);
  function change(index: number, update: Partial<Finding>) {
    setFindings((old) =>
      old.map((f, i) => (i === index ? { ...f, ...update } : f)),
    );
    setDirty(true);
    setSaved(false);
  }
  async function save() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const revision = await convex.mutation(api.researchAnalysis.saveReview, {
        ...scope,
        analysisId: analysis.analysisId,
        expectedRevision: baseRevision,
        findings,
        excerpts,
      });
      setBaseRevision(revision);
      setDirty(false);
      setSaved(true);
      refresh();
    } catch (err) {
      setError(
        `${errorText(err)} Your edits remain here. Refresh the analysis to reconcile its revision before another save.`,
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  if (analysis.state !== "ready") {
    const descriptions: Record<string, string> = {
      admitted:
        "The original request was accepted. It has not produced findings yet.",
      dispatching:
        "The original analysis request is processing. Refresh its status without submitting another request.",
      unknown:
        "The analysis result is unknown. Check this original request before deciding what to do next; no automatic retry will run.",
      failed:
        "This request failed. Its receipt remains available; no findings from it are ready for review.",
      invalidated:
        "Source access or evidence changed. This analysis cannot be reviewed or published.",
    };
    return (
      <div className="analysis-state">
        <h3>
          {analysis.state === "unknown"
            ? "Analysis result unconfirmed"
            : `Analysis ${analysis.state}`}
        </h3>
        <p>{descriptions[analysis.state]}</p>
        <p className="muted">
          Requested <DateTime value={analysis.createdAt} />
        </p>
        <button type="button" className="secondary" onClick={refresh}>
          Check original analysis
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="analysis-state">
        <strong>
          {analysis.reviewedAt
            ? "Operator reviewed"
            : "AI draft · operator review required"}
        </strong>
        <p>
          Inspect the sources, edit the conclusions and limitations, and choose
          exact excerpts before saving review.
        </p>
        {analysis.receipt && (
          <p className="muted">
            {analysis.receipt.classification === "offline-fixture"
              ? "Synthetic offline fixture"
              : "Provider analysis"}{" "}
            · {analysis.receipt.model}
          </p>
        )}
      </div>
      <div className="findings-layout">
        <div>
          {findings.map((finding, index) => (
            <section className="finding-editor" key={finding.id}>
              <h3>Finding {index + 1}</h3>
              <Field label="Conclusion">
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={finding.statement}
                  disabled={pending || !active}
                  onChange={(e) => change(index, { statement: e.target.value })}
                />
              </Field>
              <Field label="Evidence classification">
                <select
                  value={finding.type}
                  disabled={pending || !active}
                  onChange={(e) =>
                    change(index, { type: e.target.value as Finding["type"] })
                  }
                >
                  {(
                    [
                      "self-report",
                      "observed-dom",
                      "tentative-screen",
                      "tentative-camera",
                      "interpretation",
                    ] as const
                  ).map((type) => (
                    <option value={type} key={type}>
                      {provenanceLabel[type]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Scope, uncertainty and limitations">
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={finding.limitations}
                  disabled={pending || !active}
                  onChange={(e) =>
                    change(index, { limitations: e.target.value })
                  }
                />
              </Field>
              {(
                [
                  ["Supporting evidence", "supports"],
                  ["Counterevidence", "counterevidence"],
                ] as const
              ).map(([label, key]) => (
                <div key={key}>
                  <h4>{label}</h4>
                  <div className="finding-references">
                    {finding[key].map((ref) => (
                      <button
                        type="button"
                        className="text-button"
                        key={ref}
                        onClick={() => setInspected(ref)}
                      >
                        {analysis.evidence.find(
                          (e) => evidenceId(e) === ref,
                        ) ? (
                          <EvidenceLabel
                            source={analysis.evidence.find(
                              (e) => evidenceId(e) === ref,
                            )!}
                          />
                        ) : (
                          "Evidence unavailable"
                        )}
                      </button>
                    ))}
                  </div>
                  <details>
                    <summary>Edit {label.toLowerCase()}</summary>
                    {analysis.evidence.map((e) => {
                      const id = evidenceId(e);
                      const other =
                        key === "supports" ? "counterevidence" : "supports";
                      return (
                        <label className="check" key={id}>
                          <input
                            type="checkbox"
                            checked={finding[key].includes(id)}
                            disabled={
                              pending || !active || finding[other].includes(id)
                            }
                            onChange={(event) =>
                              change(index, {
                                [key]: event.target.checked
                                  ? [...finding[key], id]
                                  : finding[key].filter((ref) => ref !== id),
                              })
                            }
                          />
                          <EvidenceLabel source={e} />
                        </label>
                      );
                    })}
                  </details>
                </div>
              ))}
              <button
                type="button"
                className="text-button"
                disabled={pending || !active}
                onClick={() => {
                  setFindings((old) => old.filter((f) => f.id !== finding.id));
                  setDirty(true);
                }}
              >
                Exclude finding {index + 1}
              </button>
            </section>
          ))}
        </div>
        <aside className="evidence-inspector" aria-label="Original evidence">
          <h3>Original evidence</h3>
          {source ? (
            <>
              <p>
                <EvidenceLabel source={source} />
              </p>
              {source.text !== null ? (
                <>
                  <blockquote>{source.text}</blockquote>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={excerpts.some((e) => e.evidenceId === inspected)}
                      disabled={pending || !active}
                      onChange={(e) => {
                        setExcerpts((old) =>
                          e.target.checked
                            ? [
                                ...old,
                                {
                                  evidenceId: evidenceId(source),
                                  text: source.text!,
                                },
                              ]
                            : old.filter(
                                (excerpt) => excerpt.evidenceId !== inspected,
                              ),
                        );
                        setDirty(true);
                        setSaved(false);
                      }}
                    />
                    <span>
                      Include this exact excerpt in publication preview
                    </span>
                  </label>
                </>
              ) : (
                <>
                  <p className="muted">
                    Recording evidence. The analysis label is tentative, and
                    does not establish emotion or intent.
                  </p>
                  <OriginalRecording
                    key={source.id}
                    source={source}
                    scope={scope}
                  />
                </>
              )}
              <p className="muted">
                Source digest <code>{source.hash.slice(0, 16)}</code> · consent
                revision {source.consentEpoch}
              </p>
            </>
          ) : (
            <p className="muted">
              Open a supporting source or counterexample to inspect its exact
              retained excerpt and provenance.
            </p>
          )}
          <p className="muted">
            Saving review keeps these findings private. Source access and
            publication permissions are checked again before release.
          </p>
        </aside>
      </div>
      {analysis.revision !== baseRevision && (
        <Notice>
          The saved analysis revision changed. Your local edits remain here.
          Close this analysis and reopen it to inspect the latest revision
          before previewing publication.
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      {saved && <Notice>Review saved. Findings remain private.</Notice>}
      <div className="save-bar">
        <p>
          {dirty
            ? "Unsaved operator edits"
            : analysis.reviewedAt
              ? "Saved operator review"
              : "Review has not been saved"}
        </p>
        <div className="actions">
          <button
            type="button"
            disabled={
              !active ||
              pending ||
              !!error ||
              !findings.length ||
              findings.some((f) => !f.statement.trim() || !f.supports.length)
            }
            onClick={() => void save()}
          >
            {pending ? "Saving review…" : "Save operator review"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={
              dirty ||
              pending ||
              analysis.revision !== baseRevision ||
              !analysis.reviewedAt ||
              !!error
            }
            onClick={() => onReviewed(analysis.analysisId)}
          >
            Preview publication
          </button>
        </div>
      </div>
    </>
  );
}

function AnalysisSelection({
  scope,
  active,
  onCreated,
  latestStudyVersion,
}: {
  scope: Scope;
  active: boolean;
  latestStudyVersion: number;
  onCreated: (id: Id<"researchAnalyses">) => void;
}) {
  const sessions = usePages(api.research.sessions, scope);
  const [studyVersion, setStudyVersion] = useState(latestStudyVersion);
  const [preparedHold, setPreparedHold] = useState(false);
  const savedStudy = useRead(api.research.readStudy, studyVersion > 0 ? { ...scope, version: studyVersion } : null);
  const [sessionId, setSessionId] = useState<Id<"researchSessions"> | null>(null);
  const [kind, setKind] = useState<Selection["kind"]>("self-report");
  const inventory = usePages(api.researchAnalysis.inventory, sessionId ? { ...scope, sessionId, kind } : null);
  const [selections, setSelections] = useState<Selection[]>([]);
  const frameLimit = 1;
  const storageKey = `corvo.research.analysis-request.${scope.clientId}.${scope.projectId}`;
  const [request, setRequest] = useState<string | null>(() => { try { return sessionStorage.getItem(storageKey); } catch { return null; } });
  const original = useRead(api.researchAnalysis.requestStatus, request ? { ...scope, requestId: request } : null);
  const [error, setError] = useState("");
  return (
    <details className="analysis-selection">
      <summary>Select evidence for a private AI draft</summary>
      <p className="muted">
        Select up to 24 sources from six sessions. Screen and camera evidence
        allow at most {frameLimit} selected frame{frameLimit === 1 ? "" : "s"}. Drafts require operator review.
      </p>
      <fieldset disabled={!!request || preparedHold || !active}>
        <Field label="Saved study version for analysis"><select value={studyVersion} onChange={event => { setStudyVersion(Number(event.target.value)); setSessionId(null); setSelections([]); }}><option value={0}>Choose a saved study</option>{Array.from({ length: latestStudyVersion }, (_, n) => n + 1).map(version => <option key={version} value={version}>Version {version}</option>)}</select></Field>
        <Field label="Research session">
          <select
            value={sessionId ?? ""}
            onChange={(e) =>
              setSessionId((e.target.value || null) as typeof sessionId)
            }
          >
            <option value="">Choose a session</option>
            {sessions.rows.filter(session => session.studyId === savedStudy.data?.studyId).map((session) => (
              <option value={session.sessionId} key={session.sessionId}>
                Session {session.sessionId.slice(-8)} · {session.state}
              </option>
            ))}
          </select>
        </Field>
        <Pages {...sessions} />
        <Field label="Source kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {(
              [
                "self-report",
                "dom-event",
                "screen-observation",
                "camera-observation",
                "audio",
                "capture-gap",
              ] as const
            ).map((value) => (
              <option value={value} key={value}>
                {provenanceLabel[value]}
              </option>
            ))}
          </select>
        </Field>
        {inventory.rows.map((row) => {
          const id = evidenceId(row.selection),
            selected = selections.find(
              (s) =>
                s.kind === row.selection.kind &&
                s.id === row.selection.id &&
                (row.selection.kind !== "dom-event" ||
                  s.start === row.selection.start),
            );
          return (
            <div className="evidence-choice" key={id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!selected}
                  disabled={!selected && selections.length >= 24}
                  onChange={(e) =>
                    setSelections((old) =>
                      e.target.checked
                        ? [...old, row.selection]
                        : old.filter(
                            (s) =>
                              !(
                                s.kind === row.selection.kind &&
                                s.id === row.selection.id &&
                                (row.selection.kind !== "dom-event" ||
                                  s.start === row.selection.start)
                              ),
                          ),
                    )
                  }
                />
                <span>{row.label}</span>
              </label>
              {row.text !== null && <p className="source-text">{row.text}</p>}
              <p className="muted">
                {row.shareAllowed
                  ? "Sharing consent available; publication remains a separate choice."
                  : "Private analysis only · sharing consent unavailable."}
              </p>
              {selected &&
                [
                  "self-report",
                  "screen-observation",
                  "camera-observation",
                  "audio",
                ].includes(row.selection.kind) && (
                  <div className="range-fields">
                    {(["start", "end"] as const).map((bound) => (
                      <Field
                        key={bound}
                        label={`${bound === "start" ? "From" : "To"} (${kind === "self-report" ? "character" : "milliseconds"})`}
                      >
                        <input
                          type="number"
                          min={row.selection.start}
                          max={row.selection.end}
                          step={1}
                          value={selected[bound]}
                          onChange={(e) =>
                            setSelections((old) =>
                              old.map((s) =>
                                s === selected
                                  ? { ...s, [bound]: Number(e.target.value) }
                                  : s,
                              ),
                            )
                          }
                        />
                      </Field>
                    ))}
                  </div>
                )}
            </div>
          );
        })}
        <Pages {...inventory} />
        {sessionId &&
          !inventory.rows.length &&
          !inventory.loading &&
          !inventory.error && (
            <p className="empty">
              No retained sources of this kind are available for this session.
            </p>
          )}
        {selections.length > 0 && (
          <div className="analysis-state">
            <strong>{selections.length} selected sources</strong>
            <ul>
              {selections.map((s) => (
                <li key={evidenceId(s)}>
                  {provenanceLabel[s.kind]} · session {s.sessionId.slice(-8)} ·{" "}
                  {s.start}–{s.end}{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setSelections((old) => old.filter((item) => item !== s))
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </fieldset>
      {savedStudy.data && selections.every(selection => sessions.rows.some(session => session.sessionId === selection.sessionId && session.studyId === savedStudy.data!.studyId)) ? <StudyAnalysisRequest key={`${savedStudy.data.studyId}:${savedStudy.data.version}`} scope={{ ...scope, studyId: savedStudy.data.studyId, studyVersion: savedStudy.data.version }} selections={selections} active={active && !request} onFrozen={setPreparedHold} onCreated={onCreated} /> : <Notice>Choose a saved study version and retained sources from that study before preparing analysis.</Notice>}
      {savedStudy.error && <Notice error>{savedStudy.error}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {request && (
        <Notice>
          Original request {request} is retained.{" "}
          {original.data ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => onCreated(original.data!.analysisId)}
              >
                Open original analysis · {original.data.state}
              </button>
              {["ready", "failed", "invalidated"].includes(
                original.data.state,
              ) && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    try {
                      sessionStorage.removeItem(storageKey);
                    } catch {
                      return;
                    }
                    setRequest(null);
                    setSelections([]);
                    setError("");
                    setPreparedHold(false);
                  }}
                >
                  Prepare a new analysis
                </button>
              )}
            </>
          ) : (
            <p>
              No original receipt is currently visible. Keep this request for
              reconciliation; absence is not proof of failure.
            </p>
          )}
          <button
            type="button"
            className="text-button"
            onClick={original.refresh}
          >
            Check original request
          </button>
        </Notice>
      )}
    </details>
  );
}

function OriginalRecording({
  source,
  scope,
}: {
  source: Evidence;
  scope: Scope;
}) {
  const token = useAuthToken();
  const sessionScope = {
    ...scope,
    sessionId: source.sessionId as Id<"researchSessions">,
  };
  const media = usePages(api.capture.media, sessionScope);
  const descriptor = media.rows.find((row) => row.id === source.id);
  const [url, setUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const object = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const player = useRef<HTMLMediaElement | null>(null);
  function close() {
    controller.current?.abort();
    controller.current = null;
    player.current?.pause();
    if (object.current) URL.revokeObjectURL(object.current);
    object.current = null;
    setUrl(null);
  }
  useEffect(() => () => close(), [source.id]);
  async function open() {
    if (pending || !descriptor || !token) return;
    close();
    setPending(true);
    setError("");
    const active = new AbortController();
    controller.current = active;
    try {
      const params = new URLSearchParams(sessionScope);
      const response = await fetch(
        `/capture/media/${encodeURIComponent(source.id)}?${params}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: active.signal,
        },
      );
      if (!response.ok) throw new Error();
      const blob = await boundedSourceBlob(response);
      if (controller.current !== active || active.signal.aborted) return;
      object.current = URL.createObjectURL(blob);
      setUrl(object.current);
    } catch {
      if (!active.signal.aborted)
        setError(
          "The original recording could not be opened. Check source access before relying on this finding.",
        );
    } finally {
      if (controller.current === active) setPending(false);
    }
  }
  const seek = () => {
    if (player.current && descriptor)
      player.current.currentTime =
        Math.max(0, source.start - descriptor.descriptor.startMs) / 1000;
  };
  return (
    <div className="private-player">
      {url ? (
        <>
          {source.kind === "audio" ? (
            <audio
              controls
              src={url}
              ref={(element) => {
                player.current = element;
              }}
              onLoadedMetadata={seek}
            />
          ) : (
            <video
              controls
              playsInline
              src={url}
              ref={(element) => {
                player.current = element;
              }}
              onLoadedMetadata={seek}
            />
          )}
          <button type="button" className="text-button" onClick={close}>
            Close original recording
          </button>
        </>
      ) : descriptor ? (
        <button
          type="button"
          className="secondary"
          disabled={pending || descriptor.state !== "available"}
          onClick={() => void open()}
        >
          {pending ? "Opening original…" : "Open original at cited time"}
        </button>
      ) : (
        <>
          <p className="muted">
            Locate the retained recording descriptor to open its exact cited
            time.
          </p>
          <Pages {...media} />
          {media.done && <p>Recording unavailable in this session.</p>}
        </>
      )}
      {error && <Notice error>{error}</Notice>}
    </div>
  );
}
