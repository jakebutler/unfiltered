import { StudyWelcomePanel } from "./StudyWelcome";
import { ConsentWithdrawal } from "./ConsentWithdrawal";
import { ConsentSharing } from "./ConsentSharing";
import { InterviewNextStep } from "./InterviewNextStep";
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
import { readLocalDraft, saveLocalDraft, clearLocalDraft, type LocalDraftScope } from './local-draft';
import { ResearchCapture, type CaptureControls, type CaptureActivity } from "./ResearchCapture";
import { ResearchSpeech, type ResearchSpeechControls } from './ResearchSpeech';
import type { ResearchMediaFixture } from './synthetic-voice-fixture';
import type { ResearchTranscriptReceipt, ResearchSpokenReceipt } from '../../../packages/research-core/src/speech-contract';
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
  (window.location.pathname === "/participate" || import.meta.env.DEV && window.location.pathname === "/participate/synthetic-voice") ? takeCapability() : null;

export function ParticipantApp({ fixture }: { fixture?: ResearchMediaFixture } = {}) {
  const [token, setToken] = useState(initialCapability);
  const [withdrawalRevision, setWithdrawalRevision] = useState<number | null>(null);
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
  useEffect(() => { if (record.error) clearLocalDraft(record.data?.sessionId, sessionStorage); }, [record.error]);
  useEffect(() => {
    if (!expired) return;
    clearLocalDraft(record.data?.sessionId, sessionStorage);
    clearSessionItem(CAPABILITY_KEY);
    if (record.data)
      clearSessionItem(`corvo.research.pending.${record.data.sessionId}`);
  }, [expired, record.data?.sessionId]);
  const forget = () => {
    clearLocalDraft(record.data?.sessionId, sessionStorage);
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
        <span className="demo-label">{fixture ? "Synthetic voice fixture · no microphone or provider" : "Synthetic research"}</span>
      </header>
      <main id="main" tabIndex={-1} className="participant-main">
        {withdrawalRevision !== null ? (
          <>
            <h1>You withdrew consent</h1>
            <p>Your withdrawal was accepted. Access to this interview and its shared sources has stopped. Your saved answers and recordings are queued for permanent deletion.</p>
            <p>Reports and shared excerpts that depend on these sources are no longer available. Copies already viewed or downloaded cannot be recalled.</p>
            <p className="muted" role="status">Withdrawal accepted at interview revision {withdrawalRevision}. Deletion is queued; this receipt does not claim it has finished.</p>
          </>
        ) : !token ? (
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
            fixture={fixture}
            token={token}
            session={record.data}
            refresh={record.refresh}
            forget={forget}
            onWithdrawn={revision => { forget(); setWithdrawalRevision(revision); }}
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
  fixture,
  onWithdrawn,
}: {
  token: string;
  session: Participant;
  refresh: () => void;
  forget: () => void;
  fixture?: ResearchMediaFixture;
  onWithdrawn: (revision: number) => void;
}) {
  const convex = useConvex();
  const captureControls = useRef<CaptureControls | null>(null);
  const speechControls = useRef<ResearchSpeechControls | null>(null);
  const [captureActivity, setCaptureActivity] = useState<CaptureActivity>({ devices: [], page: false, pending: 0, controlPending: false });
  const draftScope: LocalDraftScope = { sessionId: session.sessionId, promptId: session.question?.id ?? '', revision: session.revision, expiresAt: Math.min(session.expiresAt, session.retainUntil) };
  const [restoredDraft, setRestoredDraft] = useState(() => readLocalDraft(draftScope, sessionStorage));
  const [draftStored, setDraftStored] = useState(true);
  const [voiceActive, setVoiceActive] = useState(false);
  const draftOrigin = useRef<'text' | 'voice'>('text');
  const [voiceDraft, setVoiceDraft] = useState(false);
  const [voiceReceipt, setVoiceReceipt] = useState<ResearchTranscriptReceipt | null>(null);
  const sources = usePages(api.participant.sources, { token });
  const finalReview = useRead(api.participant.reviewSnapshot, session.consent ? { token } : null);
  const [reviewPending, setReviewPending] = useState<{ expectedRevision: number; requestId: string; answerGeneration: number; manifestHash: string } | null>(null);
  const [draft, setDraft] = useState(restoredDraft?.current ? restoredDraft.draft.text : "");
  const [draftQuestion, setDraftQuestion] = useState(session.question?.id);
  const [correction, setCorrection] = useState<(Pick<Source, 'sourceId' | 'sequence' | 'text'> & { question?: string }) | null>(null);
  const [correctedText, setCorrectedText] = useState("");
  const storageKey = `corvo.research.pending.${session.sessionId}`;
  const [operation, setOperation] = useState<PendingSource | null>(() =>
    readPending(storageKey),
  );
  const [sharingPending, setSharingPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [review, setReview] = useState(false);
  const [finish, setFinish] = useState(false);
  const [leave, setLeave] = useState(false);
  const [uncertainTransition, setUncertainTransition] = useState(false);
  const closed = session.state === "completed" || session.state === "partial";
  useEffect(() => {
    if (closed) { clearLocalDraft(session.sessionId, sessionStorage); return; }
    if (draft && draftQuestion === session.question?.id) setDraftStored(saveLocalDraft(draftScope, draft, sessionStorage));
    else if (!draft && !restoredDraft) clearLocalDraft(session.sessionId, sessionStorage);
  }, [draft, draftQuestion, session.question?.id, session.revision, session.state, session.sessionId, restoredDraft]);
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
      setDraft(""); setRestoredDraft(null); clearLocalDraft(session.sessionId, sessionStorage);
      setVoiceDraft(false); setVoiceReceipt(null);
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
      if (state !== "active") { speechControls.current?.stop(); await captureControls.current?.stop(); }
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
  async function confirmWording() {
    const snapshot = finalReview.data;
    if (!snapshot || !reviewPending && snapshot.revision !== session.revision || session.pendingInterview) return;
    speechControls.current?.stop();
    const request = reviewPending ?? { expectedRevision: snapshot.revision, requestId: crypto.randomUUID(), answerGeneration: snapshot.answerGeneration, manifestHash: snapshot.manifestHash };
    setBusy(true); setError(''); setReviewPending(request);
    try {
      await convex.mutation(api.participant.confirmFinalReview, { token, ...request });
      setReviewPending(null); setSaved('Your current answer wording is reviewed.'); refresh(); finalReview.refresh();
    } catch (err) {
      setError(errorText(err));
      if (isDefinitiveError(err)) setReviewPending(null);
      refresh(); finalReview.refresh();
    } finally { setBusy(false); }
  }
  async function microphoneConsent(enabled: boolean) {
    if (!session.consent) return;
    speechControls.current?.stop(); setBusy(true); setError('');
    try { await convex.mutation(api.capture.changeConsent, { token, expectedRevision: session.revision, consent: { ...session.consent, microphone: enabled } }); refresh(); }
    catch (err) { setError(errorText(err)); setUncertainTransition(true); refresh(); }
    finally { setBusy(false); }
  }
  function spokenCommitted(receipt: ResearchSpokenReceipt, scope: { sessionId: string; promptId: string; expectedRevision: number }) {
    if (session.sessionId === scope.sessionId && draftQuestion === scope.promptId && draftOrigin.current === 'voice') {
      setDraft(''); setVoiceDraft(false); setVoiceReceipt(null); setRestoredDraft(null); clearLocalDraft(session.sessionId, sessionStorage);
    }
    setSaved('Spoken answer saved · awaiting your final wording review'); void sources.refresh(); refresh(); finalReview.refresh();
  }
  const baseBlocked = busy || !!operation || uncertainTransition || !!reviewPending;
  const blocked = baseBlocked || sharingPending;
  const draftMismatch = !!draft && draftQuestion !== session.question?.id;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!session.question || draftMismatch || blocked || voiceActive || voiceDraft && !voiceReceipt) return;
    if (voiceReceipt && (voiceReceipt.promptId !== session.question.id || voiceReceipt.expectedRevision !== session.revision)) { setError('The question changed. Review the original voice source before accepting this wording.'); return; }
    speechControls.current?.stop();
    void send({
      kind: "answer",
      args: {
        requestId: crypto.randomUUID(),
        expectedRevision: session.revision,
        questionId: session.question.id,
        text: draft,
        channel: voiceDraft && voiceReceipt ? "confirmed-transcript" : "text",
        ...(voiceDraft && voiceReceipt ? { speechAttemptId: voiceReceipt.attemptId } : {}),
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
            Pause and leave
          </button>
        )}
      </div>
      {session.welcome?.purpose === "readiness-test" ? <Notice>Capture test only. This session uses text and browser recording. It will not appear in findings or client reports.</Notice> : null}
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
          {leave && (
            <section className="confirmation">
              <h2>Pause and leave this interview?</h2>
              <p>
                Answers already saved will remain.{" "}
                {draft || correctedText
                  ? draftStored ? "Your draft stays only in this browser tab. It has not been sent; clearing this tab’s access removes it." : "Your draft has not been sent or retained. Copy it before leaving."
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
              {(captureActivity.devices.length > 0 || captureActivity.page) && <div className="active-recording-strip" role="status"><span>Study recording: {[...captureActivity.devices, ...(captureActivity.page ? ['page activity'] : [])].join(', ')}</span><button type="button" className="secondary" onClick={() => void captureControls.current?.endRecording?.()}>Stop study recording</button></div>}
              <div className="interview-toolbar">
                <span>Text or voice interview · recording is optional</span>
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
              <section className="question" aria-label="Current interview question">
                {session.question && !session.pendingInterview && <><p className="question-progress">Question {session.questionNumber} of {session.questionCount}</p><h2>{session.question.question}</h2></>}
                {session.welcome?.purpose !== "readiness-test" && <ResearchSpeech mediaSource={fixture?.speechSource} token={token} session={session} draft={draft} blocked={blocked} controls={speechControls} captureControls={captureControls} onActivity={setVoiceActive} onResetSpeech={() => { setVoiceDraft(false); setVoiceReceipt(null); }} onReceipt={setVoiceReceipt} onCommitted={spokenCommitted} onMicrophoneConsent={microphoneConsent} onDraft={(text, hasTranscript) => { draftOrigin.current = 'voice'; setDraft(text); setDraftQuestion(session.question?.id); if (hasTranscript) setVoiceDraft(true); }} />}
              {session.pendingInterview ? <InterviewNextStep key={session.pendingInterview.scope.requestId} token={token} pending={session.pendingInterview} refresh={refresh} /> : session.question ? (
                <>
                  <form onSubmit={submit}>
                    <Field label="Your answer">
                      <textarea
                        rows={5}
                        maxLength={8000}
                        required
                        disabled={blocked}
                        value={draft}
                        onChange={(e) => {
                          speechControls.current?.stop();
                          draftOrigin.current = 'text'; setDraft(e.target.value);
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
                            setVoiceDraft(false); setVoiceReceipt(null);
                            setDraftQuestion(session.question?.id);
                          }}
                        >
                          Clear unsent draft
                        </button>
                      </Notice>
                    )}
                    {draft && <p className="local-draft" role="status">{draftStored ? 'Unsent draft · retained only in this tab' : 'Unsent draft · this browser could not retain it'}</p>}
                    {restoredDraft && !restoredDraft.current && <Notice>The saved question or revision changed. This earlier draft is still local and has not been sent.<blockquote>{restoredDraft.draft.text}</blockquote>{restoredDraft.draft.promptId === session.question?.id && <button type="button" className="secondary" onClick={() => { setDraft(restoredDraft.draft.text); setDraftQuestion(session.question?.id); setVoiceDraft(false); setVoiceReceipt(null); setRestoredDraft(null); }}>Use this wording for the current question</button>}<button type="button" className="secondary" onClick={() => { setRestoredDraft(null); clearLocalDraft(session.sessionId, sessionStorage); }}>Discard local draft</button></Notice>}
                    <div className="composer-actions">
                      <small>
                        {voiceDraft ? 'Review your spoken wording before saving. The original transcript remains visible.' : 'Your exact words are saved when you continue.'}
                      </small>
                      <button
                        disabled={blocked || voiceActive || voiceDraft && !voiceReceipt || !draft.trim() || draftMismatch}
                      >
                        {busy ? "Saving answer…" : "Save answer & continue"}
                      </button>
                      <button className="secondary" type="button" disabled={blocked || voiceActive || draftMismatch} onClick={() => {
                        speechControls.current?.stop();
                        void send({ kind: 'answer', args: { requestId: crypto.randomUUID(), expectedRevision: session.revision, questionId: session.question!.id, text: draft || '[Skipped this question]', channel: 'text', intent: 'skip' } });
                      }}>Skip this question</button>
                    </div>
                  </form>
                </>
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
              </section>
              <div className="interview-bottom">
                <button
                  className="text-button"
                  disabled={blocked || voiceActive || !!draft || !!correctedText || !!session.pendingInterview}
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
          <ResearchCapture blocked={blocked} devices={fixture?.devices} onActivity={setCaptureActivity} token={token} session={session} controls={captureControls} refresh={refresh} />
          {review && <section className="final-review" aria-label="Exact answer wording review">
            <h2>Review your answer wording</h2>
            <p>These are the current answers. Spoken answers become available for analysis only after you confirm this exact wording. A new answer or correction requires a new review.</p>
            {finalReview.error ? <Notice error>{finalReview.error}</Notice> : !finalReview.data ? <p role="status">Loading current answer wording…</p> : <>
              <ol>{finalReview.data.answers.map((answer, index) => <li key={answer.sourceId}><h3>Question {index + 1}: {answer.question}</h3><p className="muted">{answer.channel === 'spoken-answer' ? finalReview.data!.reviewedCurrent ? 'Spoken answer · wording reviewed' : 'Spoken answer · awaiting wording review' : 'Saved answer'}</p><blockquote>{answer.text}</blockquote>{!closed && <button className="text-button" disabled={blocked || voiceActive || finalReview.data!.revision !== session.revision} onClick={() => { speechControls.current?.stop(); setCorrection({ sourceId: answer.sourceId, sequence: answer.sequence, text: answer.text, question: answer.question }); setCorrectedText(answer.text); setFinish(false); }}>Correct this wording</button>}</li>)}</ol>
              {finalReview.data.reviewedCurrent ? <p role="status">This exact answer set has been reviewed.</p> : <button disabled={blocked || voiceActive || !!session.pendingInterview || finalReview.data.revision !== session.revision || !finalReview.data.answers.length} onClick={() => void confirmWording()}>Confirm this answer wording</button>}
              {reviewPending && !busy && <button className="secondary" disabled={voiceActive} onClick={() => void confirmWording()}>Check the same review confirmation</button>}
            </>}
          </section>}
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
                reviewedSpokenSourceIds={finalReview.data?.reviewedCurrent ? finalReview.data.answers.filter(answer => answer.channel === 'spoken-answer').map(answer => answer.sourceId) : []}
                canCorrect={
                  !closed && !blocked && sources.done && !sources.error
                }
                onCorrect={(source) => {
                  speechControls.current?.stop();
                  setCorrection({ ...source, question: finalReview.data?.answers.find(answer => answer.sourceId === source.sourceId)?.question });
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
              {correction.question && <p>{correction.question}</p>}
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
                  disabled={blocked || voiceActive || !!draft || !!correctedText || !!session.pendingInterview || !finalReview.data || finalReview.data.revision !== session.revision || finalReview.data.answers.some(answer => answer.channel === 'spoken-answer') && !finalReview.data.reviewedCurrent}
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
            <ConsentSharing token={token} session={session} blocked={baseBlocked || voiceActive || captureActivity.devices.length > 0 || captureActivity.page || captureActivity.pending > 0 || captureActivity.controlPending || !!session.pendingInterview} refresh={refresh} onPending={setSharingPending} />
            <ConsentWithdrawal token={token} session={session} blocked={blocked} stop={async () => { speechControls.current?.stop(); await captureControls.current?.stop(false); }} onWithdrawn={onWithdrawn} />
          </details>
        </>
      )}
    </>
  );
}
function Consent({ session, pending, agree }: { session: Participant; pending: boolean; agree: (consent: NonNullable<Participant["consent"]>) => Promise<void> }) {
  return session.welcome ? <StudyWelcomePanel welcome={session.welcome} pending={pending} agree={agree} /> : <Notice error>The study welcome is unavailable. Check the saved session before starting.</Notice>;
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
