import { useEffect, useRef, useState, type FormEvent } from "react";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api";
import {
  Brand,
  DateTime,
  Field,
  Notice,
  Pages,
  SourceList,
} from "./components";
import { usePages, useRead } from "./data";
import { ResearchCapture, type CaptureControls } from "./ResearchCapture";
import {
  CAPABILITY_KEY,
  clearSessionItem,
  errorText,
  isDefinitiveError,
  readCapability,
  readPending,
  type Participant,
  type PendingSource,
  type Source,
} from "./state";

function takeCapability() {
  let previous: string | null = null;
  try {
    previous = sessionStorage.getItem(CAPABILITY_KEY);
  } catch {
    /* Original invitation still permits a later visit. */
  }
  const token = readCapability(window.location.hash, previous);
  if (window.location.hash || window.location.search)
    window.history.replaceState(null, "", window.location.pathname);
  try {
    if (token) sessionStorage.setItem(CAPABILITY_KEY, token);
    else sessionStorage.removeItem(CAPABILITY_KEY);
  } catch {
    /* Memory-only access remains usable. */
  }
  return token;
}
// Extract before the first rendered tree and strip the fragment immediately.
const initialCapability =
  window.location.pathname === "/participate" ? takeCapability() : null;

export function ParticipantApp() {
  const [token, setToken] = useState(initialCapability);
  const record = useRead(api.participant.resume, token ? { token } : null);
  const [now, setNow] = useState(Date.now());
  const deadline = record.data
    ? Math.min(record.data.expiresAt, record.data.retainUntil)
    : null;
  useEffect(() => {
    if (deadline === null) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (now < deadline) setNow(Date.now());
      return;
    }
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining + 20, 2147483647),
    );
    const focus = () => setNow(Date.now());
    window.addEventListener("focus", focus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, [deadline, now]);
  const expired = deadline !== null && deadline <= now;
  useEffect(() => {
    if (!expired) return;
    clearSessionItem(CAPABILITY_KEY);
    if (record.data)
      clearSessionItem(`corvo.research.pending.${record.data.sessionId}`);
  }, [expired, record.data?.sessionId]);
  const forget = () => {
    try {
      sessionStorage.removeItem(CAPABILITY_KEY);
      if (record.data)
        sessionStorage.removeItem(
          `corvo.research.pending.${record.data.sessionId}`,
        );
    } catch {
      /* Tab still clears memory. */
    }
    setToken(null);
  };
  return (
    <>
      <header className="topbar participant-topbar">
        <Brand />
        <span className="demo-label">Synthetic research</span>
      </header>
      <main id="main" className="participant-main">
        {!token ? (
          <>
            <h1>Open your research invitation</h1>
            <p>
              Use the private link from Corvo Labs to begin or return to your
              interview. If you have just left, your saved answers remain with
              the study.
            </p>
          </>
        ) : record.error || expired ? (
          <>
            <h1>This invitation is unavailable</h1>
            <p>
              The link may have expired, been revoked, or the study may be
              archived. Contact the person who invited you for help.
            </p>
            {!expired && (
              <button onClick={record.refresh}>Check access again</button>
            )}
            <button className="secondary" onClick={forget}>
              Clear this tab’s access
            </button>
          </>
        ) : !record.data ? (
          <p role="status">Opening your interview…</p>
        ) : (
          <Interview
            key={record.data.sessionId}
            token={token}
            session={record.data}
            refresh={record.refresh}
            forget={forget}
          />
        )}
      </main>
    </>
  );
}

function Interview({
  token,
  session,
  refresh,
  forget,
}: {
  token: string;
  session: Participant;
  refresh: () => void;
  forget: () => void;
}) {
  const convex = useConvex();
  const captureControls = useRef<CaptureControls | null>(null);
  const sources = usePages(api.participant.sources, { token });
  const [draft, setDraft] = useState("");
  const [draftQuestion, setDraftQuestion] = useState(session.question?.id);
  const [correction, setCorrection] = useState<Source | null>(null);
  const [correctedText, setCorrectedText] = useState("");
  const storageKey = `corvo.research.pending.${session.sessionId}`;
  const [operation, setOperation] = useState<PendingSource | null>(() =>
    readPending(storageKey),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [review, setReview] = useState(false);
  const [finish, setFinish] = useState(false);
  const [leave, setLeave] = useState(false);
  const [uncertainTransition, setUncertainTransition] = useState(false);
  const closed = session.state === "completed" || session.state === "partial";
  useEffect(() => {
    void sources.refresh();
  }, [session.revision]);
  async function send(operationToSend: PendingSource) {
    setBusy(true);
    setError("");
    setSaved("");
    setOperation(operationToSend);
    // Store the exact in-flight draft for explicit same-request recovery. It is
    // tab-scoped and removed after acknowledgement or a known rejection.
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(operationToSend));
    } catch {
      setError(
        "This browser could not retain the answer for safe recovery. Enable session storage before saving. Your text has not been sent.",
      );
      setOperation(null);
      setBusy(false);
      return;
    }
    try {
      const receipt =
        operationToSend.kind === "answer"
          ? await convex.mutation(api.participant.answer, {
              token,
              ...operationToSend.args,
            })
          : await convex.mutation(api.participant.correct, {
              token,
              ...operationToSend.args,
            });
      setOperation(null);
      clearSessionItem(storageKey);
      setDraft("");
      setCorrection(null);
      setCorrectedText("");
      setSaved(`Answer saved · source ${receipt.sequence + 1}`);
      await sources.refresh();
      refresh();
    } catch (err) {
      setError(errorText(err));
      if (isDefinitiveError(err)) {
        setOperation(null);
        clearSessionItem(storageKey);
        refresh();
        await sources.refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  async function transition(
    state: "active" | "paused" | "completed" | "partial",
  ) {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      if (state !== "active") await captureControls.current?.stop();
      await convex.mutation(api.participant.transition, {
        token,
        expectedRevision: session.revision,
        state,
      });
      setFinish(false);
      setLeave(false);
      refresh();
      await sources.refresh();
    } catch (err) {
      setError(errorText(err));
      setUncertainTransition(true);
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function agree(consent: NonNullable<Participant["consent"]>) {
    setBusy(true);
    setError("");
    try {
      await convex.mutation(api.participant.agree, {
        token,
        expectedRevision: session.revision,
        consent,
      });
      refresh();
      await sources.refresh();
    } catch (err) {
      setError(errorText(err));
      setUncertainTransition(true);
      refresh();
    } finally {
      setBusy(false);
    }
  }
  const blocked = busy || !!operation || uncertainTransition;
  const draftMismatch = !!draft && draftQuestion !== session.question?.id;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!session.question || draftMismatch || blocked) return;
    void send({
      kind: "answer",
      args: {
        requestId: crypto.randomUUID(),
        expectedRevision: session.revision,
        questionId: session.question.id,
        text: draft,
        channel: "text",
      },
    });
  }
  return (
    <>
      <div className="participant-heading">
        <div>
          <h1>{session.title}</h1>
          <p className="muted">A research interview with Corvo Labs</p>
        </div>
        {session.consent && !closed && (
          <button
            className="text-button"
            disabled={blocked}
            onClick={() => setLeave(true)}
          >
            Save and leave
          </button>
        )}
      </div>
      {error && <Notice error>{error}</Notice>}
      {saved && <Notice>{saved}</Notice>}
      {uncertainTransition && (
        <Notice>
          A change may already have saved. Check the current session state
          before continuing.
          <button
            className="secondary"
            onClick={() => {
              refresh();
              setUncertainTransition(false);
            }}
          >
            Check saved state
          </button>
        </Notice>
      )}
      {operation && (
        <Notice>
          {busy ? (
            <>Saving your {operation.kind === "correction" ? "correction" : "answer"}…</>
          ) : (
            <>
              Your {operation.kind === "correction" ? "correction" : "answer"} has
              an unconfirmed result. Check the same saved request before writing
              another answer.
            </>
          )}
          <blockquote>{operation.args.text}</blockquote>
          {!busy && <button onClick={() => void send(operation)}>Check this answer</button>}
        </Notice>
      )}
      {!session.consent ? (
        <Consent session={session} pending={blocked} agree={agree} />
      ) : (
        <>
          <ResearchCapture token={token} session={session} controls={captureControls} refresh={refresh} />
          {leave && (
            <section className="confirmation">
              <h2>Pause and leave this interview?</h2>
              <p>
                Answers already saved will remain.{" "}
                {draft || correctedText
                  ? "The text still in your editor has not been saved; copy it before leaving."
                  : "Use your original invitation to return before its expiry."}
              </p>
              <div className="actions">
                <button
                  disabled={blocked}
                  onClick={() => void transition("paused")}
                >
                  Pause interview
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setLeave(false)}
                >
                  Stay here
                </button>
              </div>
            </section>
          )}
          {closed ? (
            <section className="completion">
              <h2>
                {session.state === "completed"
                  ? "Your interview is complete"
                  : "Your interview was submitted with some questions unanswered"}
              </h2>
              <p>
                Thank you. Corvo Labs can review your saved answers. This
                interview is now closed for changes.
              </p>
              <p>
                Saved <DateTime value={session.savedAt} />
              </p>
              <button className="secondary" onClick={() => setReview(!review)}>
                {review ? "Hide saved answers" : "Review saved answers"}
              </button>
            </section>
          ) : session.state === "paused" ? (
            <section className="completion">
              <h2>Interview paused</h2>
              <p>Your saved answers are safe. Nothing is being recorded.</p>
              <div className="actions">
                <button
                  disabled={blocked}
                  onClick={() => void transition("active")}
                >
                  Resume interview
                </button>
                <button
                  className="secondary"
                  disabled={blocked}
                  onClick={forget}
                >
                  Leave this tab
                </button>
              </div>
              <p className="muted">
                Return using your original invitation before{" "}
                <DateTime value={session.expiresAt} />.
              </p>
            </section>
          ) : (
            <>
              <div className="interview-toolbar">
                <span>Text interview · recording is optional</span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setReview(!review)}
                >
                  {review ? "Hide source review" : "Review my answers"}
                </button>
              </div>
              {session.prototypeUrl && (
                <p className="prototype-link">
                  <a
                    href={session.prototypeUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open the study prototype
                  </a>
                  <span>
                    Opens in a separate tab. Choose optional screen sharing
                    or controlled page activity below to record it.
                  </span>
                </p>
              )}
              {session.question ? (
                <section
                  className="question"
                  aria-label="Current interview question"
                >
                  <p className="question-progress">
                    Question {session.questionNumber} of {session.questionCount}
                  </p>
                  <h2>{session.question.question}</h2>
                  <form onSubmit={submit}>
                    <Field label="Your answer">
                      <textarea
                        rows={5}
                        maxLength={8000}
                        required
                        disabled={blocked}
                        value={draft}
                        onChange={(e) => {
                          setDraft(e.target.value);
                          setDraftQuestion(session.question?.id);
                        }}
                        placeholder="Write what you noticed, in your own words."
                      />
                    </Field>
                    {draftMismatch && (
                      <Notice error>
                        The current question changed while your draft was open.
                        Review the saved sources before answering this question.
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => {
                            setDraft("");
                            setDraftQuestion(session.question?.id);
                          }}
                        >
                          Clear unsent draft
                        </button>
                      </Notice>
                    )}
                    <div className="composer-actions">
                      <small>
                        Your exact words are saved when you continue.
                      </small>
                      <button
                        disabled={blocked || !draft.trim() || draftMismatch}
                      >
                        {busy ? "Saving answer…" : "Save answer & continue"}
                      </button>
                    </div>
                  </form>
                </section>
              ) : (
                <section className="completion">
                  <h2>You’ve reached the end of the questions</h2>
                  <p>
                    Review your answers and make any corrections before
                    finishing.
                  </p>
                  <button className="secondary" onClick={() => setReview(true)}>
                    Review my answers
                  </button>
                </section>
              )}
              <div className="interview-bottom">
                <button
                  className="text-button"
                  disabled={blocked || !!draft || !!correctedText}
                  onClick={() => {
                    setFinish(true);
                    setReview(true);
                  }}
                >
                  {session.question
                    ? "Finish with questions unanswered"
                    : "Finish interview"}
                </button>
                {(draft || correctedText) && (
                  <small>Save or clear your draft before finishing.</small>
                )}
                <p className="muted">
                  Last saved <DateTime value={session.savedAt} />
                </p>
              </div>
            </>
          )}
          {review && (
            <section className="source-review">
              <div className="section-heading">
                <h2>Your saved sources</h2>
                <button
                  className="text-button"
                  onClick={() => void sources.refresh()}
                >
                  Refresh sources
                </button>
              </div>
              <p className="muted">
                Your original wording stays visible when you make a correction.
              </p>
              {!sources.done && !closed && (
                <p className="muted">
                  Load all saved sources below before correcting an answer, so
                  you can see its latest wording.
                </p>
              )}
              <SourceList
                sources={sources.rows}
                canCorrect={
                  !closed && !blocked && sources.done && !sources.error
                }
                onCorrect={(source) => {
                  setCorrection(source);
                  setCorrectedText(source.text);
                  setFinish(false);
                }}
              />
              <Pages {...sources} />
              {!sources.rows.length && !sources.loading && !sources.error && (
                <p>No answers have been saved yet.</p>
              )}
            </section>
          )}
          {correction && !closed && (
            <section className="correction-editor">
              <h2>Correct your answer</h2>
              <p className="muted">
                This appends a correction to source {correction.sequence + 1};
                it does not erase the original.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!blocked)
                    void send({
                      kind: "correction",
                      args: {
                        requestId: crypto.randomUUID(),
                        expectedRevision: session.revision,
                        sourceId: correction.sourceId,
                        text: correctedText,
                      },
                    });
                }}
              >
                <Field label="Corrected answer">
                  <textarea
                    autoFocus
                    rows={5}
                    maxLength={8000}
                    required
                    disabled={blocked}
                    value={correctedText}
                    onChange={(e) => setCorrectedText(e.target.value)}
                  />
                </Field>
                <div className="actions">
                  <button disabled={blocked || !correctedText.trim()}>
                    Save correction
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setCorrection(null);
                      setCorrectedText("");
                    }}
                  >
                    Cancel correction
                  </button>
                </div>
              </form>
            </section>
          )}
          {finish && !closed && (
            <section className="confirmation">
              <h2>
                {session.question
                  ? "Finish this partial interview?"
                  : "Finish and close your interview?"}
              </h2>
              <p>
                {session.question
                  ? "Some questions are unanswered. Your saved answers will be marked as a partial interview."
                  : "Your saved answers will be marked complete."}{" "}
                You can inspect the sources above. Once finished, you cannot
                edit this interview.
              </p>
              <div className="actions">
                <button
                  disabled={blocked || !!draft || !!correctedText}
                  onClick={() =>
                    void transition(session.question ? "partial" : "completed")
                  }
                >
                  {session.question
                    ? "Confirm partial interview"
                    : "Confirm and finish"}
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setFinish(false)}
                >
                  Keep reviewing
                </button>
              </div>
            </section>
          )}
          <details className="consent-details">
            <summary>Consent, storage and link access</summary>
            <ConsentSummary session={session} />
          </details>
        </>
      )}
    </>
  );
}
function Consent({
  session,
  pending,
  agree,
}: {
  session: Participant;
  pending: boolean;
  agree: (consent: NonNullable<Participant["consent"]>) => Promise<void>;
}) {
  const [storage, setStorage] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [share, setShare] = useState(false);
  const [excerpts, setExcerpts] = useState(false);
  return (
    <>
      <p className="introduction">{session.introduction}</p>
      <Notice>
        Use fictional details only. This is a synthetic demonstration; do not
        enter personal, confidential or patient information.
      </Notice>
      <form
        className="consent-form"
        onSubmit={(e) => {
          e.preventDefault();
          void agree({
            version: "research-consent-1",
            storage,
            analysis,
            microphone: false,
            camera: false,
            screen: false,
            shareTranscript: share,
            shareAudio: false,
            shareCamera: false,
            shareScreen: false,
            retainApprovedExcerpts: excerpts,
          });
        }}
      >
        <h2>Before we begin</h2>
        <p>
          Begin with text. Optional microphone, camera, screen sharing and
          controlled page activity each need a separate choice during the interview.
        </p>
        <fieldset disabled={pending}>
          <legend>Required to take part</legend>
          <label className="check">
            <input
              type="checkbox"
              required
              checked={storage}
              onChange={(e) => setStorage(e.target.checked)}
            />
            <span>
              I agree to Corvo Labs storing my interview answers and corrections
              until <DateTime value={session.retainUntil} />.
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              required
              checked={analysis}
              onChange={(e) => setAnalysis(e.target.checked)}
            />
            <span>
              I agree to Corvo Labs analyzing these answers for this study,
              including analysis assisted by AI when enabled.
            </span>
          </label>
          <h3 className="consent-sharing-title">Optional client sharing</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => setShare(e.target.checked)}
            />
            <span>
              Corvo Labs may share my transcript with the study’s client when it
              publishes selected research material.
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={excerpts}
              onChange={(e) => setExcerpts(e.target.checked)}
            />
            <span>
              Corvo Labs may retain approved excerpts in a published report for
              90 days after publication, even after the original transcript
              expires.
            </span>
          </label>
        </fieldset>
        <p className="muted">
          These choices permit storage, analysis or future sharing; they do not
          publish anything. You can complete the interview without device recording.
        </p>
        <button disabled={pending || !storage || !analysis}>
          {pending ? "Saving your choices…" : "Agree and start interview"}
        </button>
        <p className="muted">
          Your invitation works until <DateTime value={session.expiresAt} />.
          Keep the original link if you want to return.
        </p>
      </form>
    </>
  );
}
function ConsentSummary({ session }: { session: Participant }) {
  return (
    <dl>
      <dt>Interview sources available until</dt>
      <dd>
        <DateTime value={session.retainUntil} />
      </dd>
      <dt>Invitation access ends</dt>
      <dd>
        <DateTime value={session.expiresAt} />
      </dd>
      <dt>Device capture</dt>
      <dd>{(["microphone", "camera", "screen", "dom"] as const).filter(mode => session.consent?.[mode]).join(", ") || "No device or page activity recording permitted"}</dd>
      <dt>Transcript sharing with the client</dt>
      <dd>
        {session.consent?.shareTranscript
          ? "Permitted when deliberately published"
          : "Not permitted"}
      </dd>
      <dt>Approved excerpts retained in published reports</dt>
      <dd>
        {session.consent?.retainApprovedExcerpts
          ? "Permitted for 90 days after publication"
          : "Not permitted"}
      </dd>
      <dt>Consent version</dt>
      <dd>{session.consent?.version}</dd>
    </dl>
  );
}
