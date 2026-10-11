import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  PublishedReport,
  PublishedEvidence,
} from "../../../packages/research-core/src/publication";
import { Brand, DateTime, Field, Notice } from "./components";
import { EvidenceLabel, ReportContent } from "./PublicationPreview";

// Cookie-authenticated portal reads retain the same-origin Referer required by the gateway.
// The page-wide no-referrer policy remains in place for other destinations.
export function portalGet(path: string, signal?: AbortSignal) {
  return fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "same-origin",
    signal,
  });
}

export function ClientReportApp() {
  const slug = window.location.pathname.slice("/report/".length);
  const [report, setReport] = useState<PublishedReport | null>(null);
  const [pending, setPending] = useState(true);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const [show, setShow] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  async function read(signal?: AbortSignal) {
    const response = await portalGet(
      `/api/research/portal/report?slug=${encodeURIComponent(slug)}`,
      signal,
    );
    if (!response.ok) throw new Error("Report unavailable");
    return (await response.json()) as PublishedReport;
  }
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setReport(value);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [slug]);
  // A visible report is removed at its access deadline; sources also recheck server authority.
  useEffect(() => {
    if (!report) return;
    const remaining =
      Math.min(report.expiresAt, report.accessExpiresAt) - Date.now();
    if (remaining <= 0) {
      setReport(null);
      setError(
        "This report is unavailable. Ask your research contact for current access.",
      );
      return;
    }
    const timeout = window.setTimeout(
      () => {
        setReport(null);
        setError(
          "This report is unavailable. Ask your research contact for current access.",
        );
      },
      Math.min(remaining, 2147483647),
    );
    return () => window.clearTimeout(timeout);
  }, [report]);
  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    const value = password.current?.value ?? "";
    if (password.current) password.current.value = "";
    try {
      const response = await fetch("/api/research/portal/unlock", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, password: value }),
      });
      if (!response.ok) throw new Error("Access unavailable");
      setReport(await read());
    } catch {
      setReport(null);
      setError(
        "This report could not be opened. The password may be incorrect or access may have ended. Ask the research contact who shared your link for help.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function downloadReport() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const response = await portalGet(
        `/api/research/portal/download?slug=${encodeURIComponent(slug)}`,
      );
      if (!response.ok) throw new Error();
      const blob = await boundedSourceBlob(response);
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `research-report-v${report?.version ?? "published"}.json`;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      setError(
        "The approved report could not be downloaded. Check current access or ask your research contact for help.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function logout() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setSigningOut(true);
    setError("");
    try {
      const response = await fetch("/api/research/portal/session", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (response.status !== 204) throw new Error();
      setReport(null);
    } catch {
      setError(
        "Sign-out was not confirmed by the server. Try signing out again before leaving this device.",
      );
    } finally {
      busy.current = false;
      setPending(false);
      setSigningOut(false);
    }
  }
  return (
    <>
      <header className="topbar">
        <Brand />
        {report && (
          <button
            type="button"
            className="text-button"
            disabled={pending}
            onClick={() => void logout()}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        )}
      </header>
      {report ? (
        <main id="main" tabIndex={-1} className="client-report">
          <div className="client-report-meta">
            <span>
              {report.clientName} · {report.projectName}
            </span>
            <span>
              Published <DateTime value={report.publishedAt} /> · version{" "}
              {report.version}
            </span>
            <span>
              Access until <DateTime value={report.accessExpiresAt} />
            </span>
          </div>
          {error && <Notice error>{error}</Notice>}
          <ReportContent document={report} />
          <div className="report-download">
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => void downloadReport()}
            >
              {signingOut ? "Signing out…" : pending ? "Checking download…" : "Download approved report"}
            </button>
            <p className="muted">
              Downloads this exact published report as a JSON file.
            </p>
          </div>
          <section className="client-sources">
            <h2>Shared source material</h2>
            <p className="muted">
              Only these approved sources are available. A cited excerpt does
              not grant access to the entire original source.
            </p>
            {report.evidence
              .filter((source) =>
                report.grants.some(
                  (grant) =>
                    grant.evidenceId === source.evidenceId &&
                    (grant.view || grant.download),
                ),
              )
              .map((source) => (
                <ClientSource
                  key={source.evidenceId}
                  source={source}
                  expiresAt={report.accessExpiresAt}
                  slug={slug}
                />
              ))}
            {!report.grants.some((grant) => grant.view || grant.download) && (
              <p>
                No original source material was released with this report.
                Approved excerpts are included above.
              </p>
            )}
            <p className="muted">People can retain what they view. Revoking this link stops future access.</p>
          </section>
        </main>
      ) : (
        <main id="main" tabIndex={-1} className="entry">
          <h1>Open your research report</h1>
          <p className="lede">
            Enter the password provided with your private report link.
          </p>
          <form className="stack" onSubmit={unlock}>
            <Field label="Report password">
              <input
                ref={password}
                name="report-password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                required
                maxLength={256}
                disabled={pending}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={show}
                onChange={(e) => setShow(e.target.checked)}
              />
              <span>Show password</span>
            </label>
            {error && <Notice error>{error}</Notice>}
            <button type="submit" disabled={pending}>
              {pending ? "Checking access…" : "Open report"}
            </button>
          </form>
          <p className="muted">
            For help, contact the researcher who sent you this link.
          </p>
        </main>
      )}
    </>
  );
}
function ClientSource({
  source,
  expiresAt,
  slug,
}: {
  source: PublishedEvidence;
  expiresAt: number;
  slug: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const object = useRef<string | null>(null);
  const player = useRef<HTMLMediaElement | null>(null);
  function close() {
    controller.current?.abort();
    controller.current = null;
    player.current?.pause();
    if (object.current) URL.revokeObjectURL(object.current);
    object.current = null;
    setUrl(null);
    setText(null);
  }
  useEffect(() => () => close(), [source.evidenceId]);
  useEffect(() => {
    const remaining = Math.min(expiresAt, source.sourceUntil) - Date.now();
    if (remaining <= 0) {
      close();
      return;
    }
    const timeout = window.setTimeout(close, Math.min(remaining, 2147483647));
    return () => window.clearTimeout(timeout);
  }, [expiresAt, source.sourceUntil]);
  async function open(intent: "view" | "download") {
    if (pending) return;
    close();
    setPending(true);
    setError("");
    const active = new AbortController();
    controller.current = active;
    try {
      if (Date.now() >= Math.min(expiresAt, source.sourceUntil))
        throw new Error();
      const response = await portalGet(
        `/api/research/portal/source/${encodeURIComponent(source.evidenceId)}?intent=${intent}&slug=${encodeURIComponent(slug)}`,
        active.signal,
      );
      if (!response.ok) throw new Error();
      const blob = await boundedSourceBlob(response);
      if (active.signal.aborted || controller.current !== active) return;
      if (
        intent === "view" &&
        ["self-report", "dom-event", "capture-gap"].includes(source.kind)
      ) {
        setText(await blob.text());
      } else {
        object.current = URL.createObjectURL(blob);
        if (intent === "view") setUrl(object.current);
        else {
          const anchor = document.createElement("a");
          anchor.href = object.current;
          anchor.download = `approved-${source.kind}-${source.evidenceId}`;
          anchor.click();
          URL.revokeObjectURL(object.current);
          object.current = null;
        }
      }
    } catch {
      if (!active.signal.aborted)
        setError(
          "This source is unavailable. Its access or retention may have ended. Ask your research contact for current access.",
        );
    } finally {
      if (controller.current === active) setPending(false);
    }
  }
  return (
    <div className="client-source">
      <h3>
        <EvidenceLabel source={source} />
      </h3>
      <p className="muted">{source.fullArtifactLabel}</p>
      <p>
        {source.sourceAvailable ? (
          <>
            Source available until <DateTime value={source.sourceUntil} />
          </>
        ) : (
          "Original source unavailable · its retention has ended"
        )}
      </p>
      <div className="actions">
        {source.view && (
          <button
            type="button"
            className="secondary"
            disabled={pending || !source.sourceAvailable}
            onClick={() => void open("view")}
          >
            {pending ? "Opening source…" : "View approved source"}
          </button>
        )}
        {source.download && (
          <button
            type="button"
            className="secondary"
            disabled={pending || !source.sourceAvailable}
            onClick={() => void open("download")}
          >
            Download approved source
          </button>
        )}
        {!source.download && (
          <span className="muted">Download not enabled</span>
        )}
      </div>
      {text !== null && <pre>{text}</pre>}
      {url &&
        (source.kind === "audio" ? (
          <audio
            controls
            preload="metadata"
            src={url}
            ref={(element) => {
              player.current = element;
            }}
            onLoadedMetadata={() => {
              if (player.current)
                player.current.currentTime =
                  Math.max(
                    0,
                    source.start - (source.artifactStart ?? source.start),
                  ) / 1000;
            }}
          />
        ) : (
          <video
            controls
            preload="metadata"
            playsInline
            src={url}
            ref={(element) => {
              player.current = element;
            }}
            onLoadedMetadata={() => {
              if (player.current)
                player.current.currentTime =
                  Math.max(
                    0,
                    source.start - (source.artifactStart ?? source.start),
                  ) / 1000;
            }}
          />
        ))}
      {(url || text !== null) && (
        <button type="button" className="text-button" onClick={close}>
          Close source
        </button>
      )}
      {error && <Notice error>{error}</Notice>}
    </div>
  );
}

export async function boundedSourceBlob(response: Response): Promise<Blob> {
  const maximum = 8_000_000;
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > maximum) throw new Error("Source exceeds bounds");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Source unavailable");
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > maximum) throw new Error("Source exceeds bounds");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new Blob(chunks as BlobPart[], {
    type: response.headers.get("Content-Type") ?? "application/octet-stream",
  });
}
