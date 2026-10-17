import { useState, type ReactNode } from "react";
import { sourceHistory, type Source } from "./state";

export function Brand() {
  return (
    <a className="brand" href="/">
      Corvo Labs <span>Research</span>
    </a>
  );
}
export function DateTime({ value }: { value: number }) {
  return (
    <time dateTime={new Date(value).toISOString()}>
      {new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(value)}
    </time>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={error ? "notice error" : "notice"}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Pages({
  loading,
  done,
  error,
  more,
  refresh,
}: {
  loading: boolean;
  done: boolean;
  error?: string;
  more: () => unknown;
  refresh: () => unknown;
}) {
  return (
    <div className="page-actions">
      {loading && <span role="status">Loading…</span>}
      {error && (
        <Notice error>
          {error} <button onClick={() => void refresh()}>Refresh</button>
        </Notice>
      )}
      {!loading && !done && !error && (
        <button className="secondary" onClick={() => void more()}>
          Load more
        </button>
      )}
    </div>
  );
}
export function SourceList({
  sources,
  canCorrect,
  onCorrect,
  reviewedSpokenSourceIds = [],
}: {
  sources: Source[];
  reviewedSpokenSourceIds?: string[];
  canCorrect?: boolean;
  onCorrect?: (source: Source) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const replaced = new Set(sources.map((s) => s.supersedes).filter(Boolean));
  return (
    <ol className="transcript">
      {sources.map((source) => {
        const old = replaced.has(source.sourceId);
        const history = sourceHistory(source, sources);
        return (
          <li
            key={source.sourceId}
            className={`source ${source.author} ${old ? "superseded" : ""}`}
            id={`source-${source.sequence}`}
          >
            <div className="source-top">
              <strong>
                {source.author === "participant"
                  ? "Participant"
                  : "Interviewer"}
              </strong>
              <span>
                {source.channel === 'spoken-answer'
                  ? reviewedSpokenSourceIds.includes(source.sourceId) ? 'Spoken answer · wording reviewed' : 'Spoken answer · wording unreviewed'
                  : source.channel === 'confirmed-transcript'
                    ? 'Reviewed voice transcript'
                  : source.supersedes
                    ? "Correction"
                  : source.channel === "follow-up"
                    ? 'Interview follow-up'
                  : source.channel === "script"
                    ? "Study script"
                    : source.channel === 'unreviewed-transcript'
                      ? 'Original voice transcript · unreviewed'
                    : source.channel === "text"
                      ? "Text"
                      : "Reviewed voice transcript"}
              </span>
              {old && <span>Earlier version</span>}
            </div>
            <p className="source-text">{source.text}</p>
            <div className="source-foot">
              <button
                className="text-button"
                aria-expanded={selected === source.sourceId}
                onClick={() =>
                  setSelected(
                    selected === source.sourceId ? null : source.sourceId,
                  )
                }
              >
                Source {source.sequence + 1}
              </button>
              <DateTime value={source.recordedAt} />
              {canCorrect && source.author === "participant" && source.channel !== 'unreviewed-transcript' && !old && (
                <button
                  className="text-button"
                  onClick={() => onCorrect?.(source)}
                >
                  Correct answer
                </button>
              )}
            </div>
            {selected === source.sourceId && (
              <div className="source-details">
                <p>
                  Source ID <code>{source.sourceId}</code>
                </p>
                <p>
                  Question <code>{source.questionId}</code>
                </p>
                {source.supersedes && (
                  <>
                    <p>
                      Replaces <code>{source.supersedes}</code>. Earlier wording
                      remains in the record.
                    </p>
                    {history.map((item) => (
                      <blockquote key={item.sourceId}>{item.text}</blockquote>
                    ))}
                    {history.length === 0 && (
                      <p>
                        Load earlier sources to inspect the original wording.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
