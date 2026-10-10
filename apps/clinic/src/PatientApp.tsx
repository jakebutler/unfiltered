import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, ClipboardList, Clock3, LogOut, MessageSquare, MicOff, RefreshCw, Send, X } from 'lucide-react';
import type { ClinicConfig, ClinicSessionView, DeliveryView, PromptView, ReviewPreview, ScenarioId, SourceTurn, TopicView, TurnInput } from '../../../packages/clinic-contract/src/index';
import { messageOf, request, RequestError } from './api';
import { Button, Header, Loading, Notice, SourceInspector, TopicContent, dateTime, outcomeLabels, responsibilityLabels, time, topicLabels, type SourceSelection } from './components';

export function PatientApp() {
  const [config, setConfig] = useState<ClinicConfig>();
  const [session, setSession] = useState<ClinicSessionView>();
  const [preview, setPreview] = useState<ReviewPreview>();
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState('');
  const operation = useRef(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [verified, setVerified] = useState(false);
  const [leftAt, setLeftAt] = useState('');
  const [identityRejected, setIdentityRejected] = useState(false);
  const [text, setText] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [heldPrompt, setHeldPrompt] = useState<PromptView>();
  const [pendingTurn, setPendingTurn] = useState<TurnInput>();
  const [confirmationUnknown, setConfirmationUnknown] = useState(false);
  const [previousReceiptChecked, setPreviousReceiptChecked] = useState<{ reference: string; at: string }>();
  const [topicOutline, setTopicOutline] = useState(false);
  const [returnToReview, setReturnToReview] = useState(false);
  const [reviewTopic, setReviewTopic] = useState('');
  const questionRef = useRef<HTMLHeadingElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const outlineTrigger = useRef<HTMLButtonElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const activePrompt = heldPrompt ?? session?.currentPrompt;
  const hasDraft = Boolean(text.trim() || Object.values(fields).some(value => value.trim()) || pendingTurn);

  const boot = async () => {
    setBooting(true); setError('');
    try {
      setConfig(await request<ClinicConfig>('/api/clinic/config'));
      try { setSession(await request<ClinicSessionView>('/api/clinic/session')); }
      catch (e) { if (!(e instanceof RequestError) || ![401, 404].includes(e.status)) throw e; }
    } catch (e) { setError(messageOf(e)); }
    finally { setBooting(false); }
  };
  useEffect(() => { void boot(); }, []);
  useEffect(() => {
    if (!hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDraft]);
  useEffect(() => {
    if (verified && !preview && session?.phase !== 'confirmed' && !confirmationUnknown) questionRef.current?.focus({ preventScroll: true });
  }, [session?.currentPrompt?.id, verified, preview, confirmationUnknown]);
  useEffect(() => {
    if (preview && reviewTopic) {
      const answer = document.getElementById(`answer-${reviewTopic}`);
      answer?.focus({ preventScroll: true }); answer?.scrollIntoView({ block: 'start' });
    } else if (verified && !preview && session?.phase === 'conversation' && session.currentPrompt) {
      questionRef.current?.focus({ preventScroll: true });
    } else headingRef.current?.focus({ preventScroll: true });
  }, [Boolean(preview), session?.phase, verified, leftAt, identityRejected, booting]);

  useEffect(() => {
    if (topicOutline) { outlineRef.current?.focus({ preventScroll: true }); outlineRef.current?.scrollIntoView({ block: 'start' }); }
  }, [topicOutline]);

  const run = async (name: string, fn: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(name); setError('');
    try { await fn(); }
    catch (e) {
      setError(messageOf(e));
      if (e instanceof RequestError && e.status === 409) setStale(true);
      if (e instanceof RequestError && [401, 403].includes(e.status)) setVerified(false);
    } finally { operation.current = false; setBusy(''); }
  };
  const clearComposer = () => { setText(''); setFields({}); setHeldPrompt(undefined); };
  const start = (scenario: ScenarioId) => run('start', async () => {
    const value = await request<ClinicSessionView>('/api/clinic/sessions', { scenario, syntheticAcknowledged: true });
    setSession(value); setPreview(undefined); setVerified(false); setLeftAt(''); setIdentityRejected(false);
    setConfirmationUnknown(false); clearComposer(); setPendingTurn(undefined); setStale(false);
  });
  const confirmIdentity = () => run('identity', async () => {
    const value = await request<ClinicSessionView>('/api/clinic/confirm-identity', { confirmed: true });
    setSession(value); setVerified(value.phase !== 'identity'); setStale(false);
  });
  const rejectIdentity = () => run('reject', async () => {
    setVerified(false);
    await request('/api/clinic/reject-identity', {});
    setSession(undefined); setPreview(undefined); setIdentityRejected(true); clearComposer(); setPendingTurn(undefined);
  });
  const updateTurn = (action: TurnInput['action']) => run('answer', async () => {
    if (!session?.currentPrompt || heldPrompt) return;
    const input = pendingTurn ?? {
      requestId: crypto.randomUUID(), expectedRevision: session.revision, promptId: session.currentPrompt.id, action,
      ...(action === 'answer' ? { text, fields } : {}),
    };
    setPendingTurn(input);
    let next: ClinicSessionView;
    try { next = await request<ClinicSessionView>('/api/clinic/turns', input); }
    catch (e) { if (e instanceof RequestError && !e.uncertain) setPendingTurn(undefined); throw e; }
    setSession(next); clearComposer(); setPendingTurn(undefined); setPreview(undefined); setStale(false);
    if (returnToReview) {
      const nextPreview = await request<ReviewPreview>('/api/clinic/review', { expectedRevision: next.revision });
      setPreview(nextPreview); setSession(nextPreview.session); setReturnToReview(false);
    }
  });
  const review = () => run('review', async () => {
    if (!session) return;
    const value = await request<ReviewPreview>('/api/clinic/review', { expectedRevision: session.revision });
    setSession(value.session); setPreview(value); setStale(false);
  });
  const changeTopic = (topicId: string, slotPath?: string) => run('topic', async () => {
    if (!session || hasDraft) return;
    const next = await request<ClinicSessionView>('/api/clinic/topics', { expectedRevision: session.revision, topicId, ...(slotPath ? { slotPath } : {}) });
    setSession(next); setReturnToReview(Boolean(preview) || session.phase === 'confirmed'); setReviewTopic(topicId);
    setPreview(undefined); clearComposer(); setTopicOutline(false); setStale(false);
  });
  const checkReceipt = () => run('receipt', async () => {
    const value = await request<ClinicSessionView>('/api/clinic/receipt');
    if (hasDraft && activePrompt && value.currentPrompt?.id !== activePrompt.id) setHeldPrompt(activePrompt);
    setSession(value); setStale(false);
    if (value.phase === 'confirmed') { setConfirmationUnknown(false); setPreview(undefined); }
    else if (confirmationUnknown) {
      setConfirmationUnknown(false); setPreview(undefined);
      setError('No confirmed handoff was found. Review your saved answers before sending.');
    } else setPreview(undefined);
  });
  const checkPreviousReceipt = () => run('previous-receipt', async () => {
    if (!session?.previousDelivery || pendingTurn) return;
    const value = await request<ClinicSessionView>('/api/clinic/receipt');
    if (value.id !== session.id || !value.previousDelivery) {
      throw new Error('The earlier receipt could not be refreshed. Your update is unchanged. Try checking its status again.');
    }
    // Reconciliation refreshes the earlier receipt, never the amendment or its composer.
    setSession(current => current?.id === value.id ? { ...current, previousDelivery: value.previousDelivery } : current);
    setPreview(current => current?.session.id === value.id ? { ...current, session: { ...current.session, previousDelivery: value.previousDelivery } } : current);
    setPreviousReceiptChecked({ reference: value.previousDelivery.reference, at: new Date().toISOString() });
    if (value.revision !== session.revision) {
      setStale(true);
      setError('The earlier receipt was refreshed, but your saved draft changed elsewhere. Reload saved answers before continuing. Your unsent answer is still here.');
    }
  });
  const retryDelivery = () => run('retry-delivery', async () => {
    if (session?.delivery?.canRetryDelivery !== true || confirmationUnknown) return;
    try {
      const value = await request<ClinicSessionView>('/api/clinic/retry-delivery', {});
      setSession(value); setPreview(undefined); setConfirmationUnknown(false);
    } catch (e) { if (e instanceof RequestError && e.uncertain) setConfirmationUnknown(true); throw e; }
  });
  const confirm = () => run('confirm', async () => {
    if (!preview) return;
    try {
      const value = await request<ClinicSessionView>('/api/clinic/confirm', { expectedRevision: preview.session.revision, digest: preview.digest });
      setSession(value); setPreview(undefined); setConfirmationUnknown(false); setStale(false);
    } catch (e) { if (e instanceof RequestError && e.uncertain) setConfirmationUnknown(true); throw e; }
  });
  const leave = () => run('leave', async () => {
    const value = await request<{ savedAt: string }>('/api/clinic/leave', {});
    setLeftAt(value.savedAt); setVerified(false); setPreview(undefined);
  });
  const restore = () => run('restore', async () => {
    setSession(await request<ClinicSessionView>('/api/clinic/session'));
    setPreview(undefined); setLeftAt(''); setVerified(false); setIdentityRejected(false);
  });

  if (booting) return <Loading />;
  if (!config) return <><Header /><main id="main" className="narrow-page"><h1 ref={headingRef} tabIndex={-1}>We couldn’t open the clinic</h1><Notice tone="attention" action={<Button onClick={boot}><RefreshCw size={16} />Try again</Button>}>{error || 'The clinic service is unavailable.'}</Notice></main></>;
  if (!session || leftAt || identityRejected) return <><Header><a className="text-link" href="/staff">Staff sign in<ArrowRight size={15} aria-hidden="true" /></a></Header><main id="main" className="entry-page">
    {leftAt ? <><div className="saved-mark"><CheckCheck size={26} aria-hidden="true" /></div><h1 ref={headingRef} tabIndex={-1}>Your saved answers are here</h1><p className="lead">Saved at {time(leftAt)}. Return in this browser to continue or check your request status.</p><Button variant="primary" onClick={restore} disabled={Boolean(busy)}>Return to my conversation<ArrowRight size={17} aria-hidden="true" /></Button></>
      : identityRejected ? <><h1 ref={headingRef} tabIndex={-1}>Let’s stop here</h1><p className="lead">This browser’s access to that conversation has been cleared. Its saved answers have not been deleted. You can choose a new synthetic scenario below.</p><Button variant="primary" onClick={() => setIdentityRejected(false)}>Return to demo launcher<ArrowRight size={17} aria-hidden="true" /></Button></>
        : <ScenarioEntry config={config} busy={Boolean(busy)} start={start} />}
    {error && <Notice tone="attention">{error}</Notice>}
  </main></>;
  if (!verified || session.phase === 'identity') return <><Header /><main id="main" className="identity-page"><h1 ref={headingRef} tabIndex={-1}>Before we begin</h1><p className="lead">Use the provided fictional patient for this conversation. Keep real personal and medical information out of the demo.</p><section className="persona"><h2>{session.persona.displayName}</h2><p>{session.persona.description}</p><p className="metadata">{session.title}</p></section><div className="button-row"><Button variant="primary" disabled={Boolean(busy)} onClick={confirmIdentity}>{busy === 'identity' ? 'Opening your conversation…' : `Continue as ${session.persona.displayName.split(' ')[0]}`}<ArrowRight size={17} aria-hidden="true" /></Button><Button variant="text" disabled={Boolean(busy)} onClick={rejectIdentity}>{busy === 'reject' ? 'Clearing browser access…' : 'This isn’t me'}</Button></div>{error && <Notice tone="attention">{error}</Notice>}</main></>;

  const isStatus = session.phase === 'confirmed' || confirmationUnknown;
  return <><Header><span className="header-patient">{session.persona.displayName}</span><Button variant="text" onClick={leave} disabled={Boolean(busy) || hasDraft || confirmationUnknown}><LogOut size={16} aria-hidden="true" />{busy === 'leave' ? 'Saving…' : 'Save and leave'}</Button></Header>
    <main id="main" className={`patient-shell ${isStatus ? 'patient-shell--status' : ''}`}>
      <aside ref={outlineRef} tabIndex={-1} id="topic-outline" className={`topic-outline ${topicOutline ? 'is-open' : ''}`} aria-label="Your answer topics"><div className="outline-heading"><h2>About your answers</h2><Button variant="text" className="mobile-only" onClick={() => { setTopicOutline(false); outlineTrigger.current?.focus(); }} aria-label="Close topic outline"><X size={19} aria-hidden="true" /></Button></div><p className="metadata">{session.title}</p><ol>{session.topics.map(topic => <li key={topic.id}><button className={`topic-link ${session.currentPrompt?.topicId === topic.id && !preview ? 'is-current' : ''}`} aria-current={session.currentPrompt?.topicId === topic.id && !preview ? 'step' : undefined} disabled={Boolean(busy) || hasDraft || confirmationUnknown || (isStatus && session.delivery?.state !== 'received')} onClick={() => changeTopic(topic.id)}><span className="topic-indicator">{topic.status === 'ready-for-review' && <Check size={13} aria-hidden="true" />}</span><span><span className="topic-title">{topic.title}</span><span className="topic-caption">{topicLabels[topic.status]}</span></span></button></li>)}</ol><div className="outline-footer"><span className="save-status" role="status">{busy === 'answer' ? 'Saving your answer…' : pendingTurn ? 'Latest answer not yet confirmed saved' : `Saved at ${time(session.savedAt)}`}</span><p className="metadata">{session.completeness === 'partial' ? 'Some details are still missing.' : 'Required details recorded.'}</p></div></aside>
      <div className="patient-workspace">
        <div className="mobile-topic-bar"><button ref={outlineTrigger} type="button" className="button button--secondary" onClick={() => setTopicOutline(!topicOutline)} aria-controls="topic-outline" aria-expanded={topicOutline}><ClipboardList size={16} aria-hidden="true" />Your topics</button><span className="metadata">{pendingTurn ? 'Save unconfirmed' : `Saved ${time(session.savedAt)}`}</span></div>
        <div className="workspace-meta"><span>{isStatus ? 'Request status' : preview ? 'Answer review' : 'Your conversation'}</span><span className="mode-label">{config.conversation.mode === 'adaptive' ? 'Adaptive questions' : 'Guided questions'}</span></div>
        {session.notice && <Notice tone={session.notice.tone}>{session.notice.text}</Notice>}
        {error && <Notice tone="attention" action={pendingTurn ? <Button onClick={() => updateTurn(pendingTurn.action)} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Retry saving this answer</Button> : stale ? <Button onClick={checkReceipt} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Reload saved answers</Button> : undefined}>{error}{pendingTurn && <p>Your unsent answer is still below. Retrying checks the same save request.</p>}</Notice>}
        {session.previousDelivery && <PreviousDelivery delivery={session.previousDelivery} currentState={confirmationUnknown ? 'uncertain' : session.phase === 'confirmed' ? 'confirmed' : 'draft'} busy={Boolean(busy)} checking={busy === 'previous-receipt'} saveUnconfirmed={Boolean(pendingTurn)} checkedAt={previousReceiptChecked?.reference === session.previousDelivery.reference ? previousReceiptChecked.at : undefined} onCheck={checkPreviousReceipt} />}
        {isStatus ? <Delivery session={session} uncertain={confirmationUnknown} busy={Boolean(busy)} onCheck={checkReceipt} onRetry={retryDelivery} onChange={changeTopic} /> : preview ? <section className="review-workspace">
          <h1 ref={headingRef} tabIndex={-1}>{session.previousDelivery ? 'Check your update' : 'Check your answers'}</h1><p className="lead">{session.previousDelivery ? 'Your changes have not been sent. Your care team will receive this updated version after you confirm.' : 'Your care team will receive this version after you confirm.'} You can change a detail or inspect its original wording.</p>
          <div className="review-state"><span className="status-label">Saved draft · version {session.revision}</span><span>{session.completeness === 'partial' ? 'Partial handoff' : 'Required details recorded'}</span></div>
          {session.completeness === 'partial' && <Notice tone="attention">Some details are still missing. Return to any topic, or send what you’ve shared as a partial handoff.</Notice>}
          {session.topics.map(topic => <PatientTopic key={topic.id} topic={topic} sources={session.turns} onChange={slotPath => changeTopic(topic.id, slotPath)} disabled={Boolean(busy) || stale} />)}
          <div className="confirmation-block"><p>{preview.confirmationText}</p><Button variant="primary" onClick={confirm} disabled={Boolean(busy) || stale}>{busy === 'confirm' ? 'Sending your confirmed answers…' : session.previousDelivery ? 'Confirm and send update to Corvo Clinic' : 'Confirm and send to Corvo Clinic'}<Send size={17} aria-hidden="true" /></Button><Button variant="text" onClick={() => { setPreview(undefined); setReturnToReview(false); }} disabled={Boolean(busy)}><ArrowLeft size={16} aria-hidden="true" />Back to conversation</Button></div>
        </section> : <section className="conversation">
          <div className="conversation-heading"><h1 ref={headingRef} tabIndex={-1}>{session.title}</h1><p>Your care team will review what you share. You can check and change your answers before sending.</p></div>
          <details className="persona-details"><summary>Synthetic patient details</summary><p><strong>{session.persona.displayName}</strong> — {session.persona.description}</p></details>
          {session.turns.length > 0 && <details className="conversation-history"><summary><MessageSquare size={16} aria-hidden="true" />Earlier conversation<span>{session.turns.length} saved turns</span></summary><div className="transcript">{session.turns.map(turn => <article key={turn.id} className={`transcript-turn transcript-turn--${turn.role}`}><div className="metadata">{turn.role === 'patient' ? 'You' : 'Corvo Clinic'} · {time(turn.at)}{turn.corrects && ' · Correction'}</div><p>{turn.text}</p></article>)}</div></details>}
          {heldPrompt && <Notice tone="attention">The saved conversation has moved on. Your unsent answer for the earlier question is still shown below. Copy any text you need, then clear it to continue.</Notice>}
          {activePrompt ? <form className="answer-form" onSubmit={event => { event.preventDefault(); void updateTurn('answer'); }}>
            <div className="question-block"><h2 ref={questionRef} tabIndex={-1}>{activePrompt.text}</h2><p className="current-topic">{session.topics.find(topic => topic.id === activePrompt.topicId)?.title}</p>{activePrompt.purpose && <details className="question-purpose"><summary><CircleHelp size={15} aria-hidden="true" />Why we’re asking</summary><p>{activePrompt.purpose}</p></details>}</div>
            <fieldset disabled={Boolean(busy) || Boolean(pendingTurn)} className="composer-fields"><legend className="sr-only">Answer the current question</legend>
              {activePrompt.fields?.map(field => <div className="field" key={field.id}><label htmlFor={`field-${field.id}`}>{field.label}{field.required && <span className="required-label">Required for a complete answer</span>}</label>{field.kind === 'choice' ? <select id={`field-${field.id}`} value={fields[field.id] ?? ''} onChange={event => setFields({ ...fields, [field.id]: event.target.value })} aria-describedby={field.hint ? `hint-${field.id}` : undefined}><option value="">Choose an answer</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input id={`field-${field.id}`} type={field.kind === 'number' ? 'number' : 'text'} inputMode={field.kind === 'number' ? 'decimal' : undefined} step={field.kind === 'number' ? 'any' : undefined} value={fields[field.id] ?? ''} onChange={event => setFields({ ...fields, [field.id]: event.target.value })} aria-describedby={field.hint ? `hint-${field.id}` : undefined} autoComplete="off" />}{field.hint && <p className="field-hint" id={`hint-${field.id}`}>{field.hint}</p>}</div>)}
              {Boolean(activePrompt.choices?.length) && <div className="choice-list" role="group" aria-label="Answer choices">{activePrompt.choices!.map(choice => <button type="button" key={choice.value} className={`choice ${text === choice.value ? 'is-selected' : ''}`} aria-pressed={text === choice.value} onClick={() => setText(text === choice.value ? '' : choice.value)}>{choice.label}{text === choice.value && <Check size={16} aria-hidden="true" />}</button>)}</div>}
              {!activePrompt.fields?.length && !activePrompt.choices?.length && <div className="field message-field"><label htmlFor="answer-text">Your answer</label><textarea id="answer-text" value={text} onChange={event => setText(event.target.value)} rows={3} placeholder="Type your answer here…" /></div>}
              <div className="composer-actions"><span className="draft-label">{hasDraft ? 'Unsent answer' : activePrompt.choices?.length ? 'Choose an answer' : 'Answer in your own words'}</span><Button type="submit" variant="primary" disabled={!hasDraft || Boolean(busy) || Boolean(heldPrompt) || stale}>{busy === 'answer' ? 'Saving…' : returnToReview ? 'Save correction' : 'Send answer'}<ArrowRight size={17} aria-hidden="true" /></Button></div>
              {hasDraft && !pendingTurn && <Button className="clear-answer" variant="text" onClick={clearComposer}>Clear unsent answer</Button>}
            </fieldset>
            <div className="alternative-actions"><Button variant="text" disabled={Boolean(busy) || hasDraft || Boolean(heldPrompt) || stale} onClick={() => updateTurn('unknown')}>I don’t know</Button><Button variant="text" disabled={Boolean(busy) || hasDraft || Boolean(heldPrompt) || stale} onClick={() => updateTurn('decline')}>I’d rather discuss this with my care team</Button><Button variant="text" disabled={Boolean(busy) || hasDraft || Boolean(heldPrompt) || stale} onClick={() => updateTurn('move-on')}>Move on<ChevronRight size={15} aria-hidden="true" /></Button></div>
          </form> : <div className="conversation-ready"><CheckCheck size={28} aria-hidden="true" /><h2>{session.notice?.tone === 'urgent' ? 'Routine questions are paused' : 'Your answers are ready to review'}</h2><p>{session.notice?.tone === 'urgent' ? 'Read the message above. You can review what you’ve already shared.' : 'Check what you’ve shared, make any changes, and decide what to send.'}</p></div>}
          <div className="conversation-bottom"><div className="voice-state"><MicOff size={17} aria-hidden="true" /><span>{config.voice.available ? 'Voice is available from the service, but this view supports typing only.' : config.voice.explanation || 'Voice is unavailable. You can continue by typing.'}</span></div><Button onClick={review} disabled={Boolean(busy) || hasDraft || stale}><ClipboardList size={17} aria-hidden="true" />{busy === 'review' ? 'Opening your answers…' : 'Review my answers'}</Button></div>
          {hasDraft && <p className="metadata unsent-guidance">Send or clear your current answer before reviewing, skipping, or leaving. Text in the composer has not been saved.</p>}
          {config.conversation.explanation && <details className="runtime-detail"><summary>About these questions</summary><p>{config.conversation.explanation}</p></details>}
        </section>}
      </div>
    </main>
  </>;
}

function ScenarioEntry({ config, busy, start }: { config: ClinicConfig; busy: boolean; start: (id: ScenarioId) => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [selected, setSelected] = useState<ScenarioId>();
  return <><div className="entry-heading"><h1>Start a clinic conversation</h1><p className="lead">Share what matters, check your answers, and send them to the right people at {config.clinicName}.</p></div><section className="scenario-section"><h2>Choose a demo conversation</h2><p className="section-intro">Each scenario uses a fictional patient. Nothing you submit is medical advice, a booking, or a prescription.</p><fieldset disabled={busy}><legend className="sr-only">Demo conversation</legend><div className="scenario-list">{config.scenarios.map(scenario => <label className={`scenario-option ${selected === scenario.id ? 'is-selected' : ''}`} key={scenario.id}><input type="radio" name="scenario" value={scenario.id} checked={selected === scenario.id} onChange={() => setSelected(scenario.id)} /><span className="scenario-copy"><strong>{scenario.title}</strong><span>{scenario.description}</span></span><ArrowRight size={20} aria-hidden="true" /></label>)}</div><label className="acknowledgement"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I’ll use only the provided synthetic patient details.</label><Button variant="primary" disabled={!selected || !acknowledged || busy} onClick={() => selected && start(selected)}>{busy ? 'Opening your conversation…' : 'Start conversation'}<ArrowRight size={17} aria-hidden="true" /></Button></fieldset></section><p className="entry-footnote">Your answers stay a draft until you review and confirm them.</p></>;
}

function PatientTopic({ topic, sources, onChange, disabled }: { topic: TopicView; sources: SourceTurn[]; onChange?: (slotPath?: string) => void; disabled?: boolean }) {
  const [source, setSource] = useState<SourceSelection>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  return <article className="answer-section" id={`answer-${topic.id}`} tabIndex={-1} aria-label={topic.title}>
    <TopicContent topic={topic} onChange={onChange} disabled={disabled} onSource={(selection, element) => { trigger.current = element; setSource(selection); }} />
    {source && <SourceInspector title={source.title} ids={source.ids} sources={sources} onClose={() => { setSource(undefined); trigger.current?.focus(); }} />}
  </article>;
}

function PreviousDelivery({ delivery, currentState, busy, checking, saveUnconfirmed, checkedAt, onCheck }: {
  delivery: DeliveryView; currentState: 'draft' | 'uncertain' | 'confirmed'; busy: boolean; checking: boolean;
  saveUnconfirmed: boolean; checkedAt?: string; onCheck: () => void;
}) {
  const receiptLabels: Record<DeliveryView['state'], string> = {
    pending: 'Delivery pending', unknown: 'Delivery not confirmed', incomplete: 'Handoff incomplete',
    received: 'Received by Corvo Clinic', conflict: 'Delivery needs attention',
  };
  return <section className="previous-delivery" aria-labelledby="previous-delivery-title">
    <div className="section-heading"><h2 id="previous-delivery-title">Earlier confirmed version {delivery.version}</h2><span className="status-label">{receiptLabels[delivery.state]}</span></div>
    <p className="previous-delivery-context">{currentState === 'draft' ? 'You’re editing an update that has not been sent.' : currentState === 'uncertain' ? 'The result of sending your update is not yet confirmed.' : 'The status of your current version is shown separately below.'} This receipt and these care-team outcomes belong to the earlier version.</p>
    <details className="previous-delivery-details"><summary>Earlier receipt and care-team outcomes</summary>
      <dl className="previous-receipt-facts"><div><dt>Reference</dt><dd className="break-anywhere">{delivery.reference}</dd></div><div><dt>Received</dt><dd>{dateTime(delivery.receivedAt)}</dd></div></dl>
      {delivery.work.length ? delivery.work.map(work => <article className="work-item" key={work.id}><div className="section-heading"><h3>{work.title}</h3><span className="status-label">{outcomeLabels[work.status]}</span></div><p className="metadata">{responsibilityLabels[work.responsibility]} · Earlier version {delivery.version}</p>{work.outcome ? <><p className="work-outcome">{work.outcome}</p><p className="metadata">{work.author || 'Care team'} · {dateTime(work.at)}</p></> : <p className="work-waiting">No staff-recorded outcome for this earlier version yet.</p>}</article>) : <p className="metadata">No care-team work is available for this earlier receipt.</p>}
    </details>
    <div className="previous-receipt-actions"><Button onClick={onCheck} disabled={busy || saveUnconfirmed}><RefreshCw size={16} aria-hidden="true" />{checking ? 'Checking earlier status…' : 'Check earlier version status'}</Button>{checkedAt && <span className="metadata" role="status">Earlier receipt checked at {time(checkedAt)}. Your update is unchanged.</span>}</div>
    {saveUnconfirmed && <p className="metadata">Resolve the unconfirmed answer save before checking the earlier receipt.</p>}
  </section>;
}

function Delivery({ session, uncertain, busy, onCheck, onRetry, onChange }: { session: ClinicSessionView; uncertain: boolean; busy: boolean; onCheck: () => void; onRetry: () => void; onChange: (id: string, slotPath?: string) => void }) {
  const delivery = session.delivery;
  const received = !uncertain && delivery?.state === 'received';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const title = heading.current;
    title?.focus({ preventScroll: true });
    // Start at the workspace so a delivery error remains visible above the receipt.
    title?.closest('.patient-workspace')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    title?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [received, uncertain, delivery?.state]);
  const title = received ? 'Received by Corvo Clinic' : delivery?.state === 'conflict' ? 'Your delivery needs attention' : 'Delivery not yet confirmed';
  return <section className="delivery-workspace"><div className={`receipt-mark ${received ? 'is-received' : ''}`}>{received ? <CheckCheck size={29} aria-hidden="true" /> : <Clock3 size={29} aria-hidden="true" />}</div><h1 ref={heading} tabIndex={-1}>{title}</h1><p className="lead">{received ? 'Your care team can now review this version. Sending your answers does not mean they have been reviewed or that treatment has been approved.' : uncertain ? 'We couldn’t confirm the result of your send request. Check its status before taking another action.' : 'Your confirmed answers are saved. Check delivery status to see whether the clinic has received the complete handoff.'}</p>
    <div className="receipt-facts"><div><span>Handoff</span><strong>{session.completeness === 'partial' ? 'Partial · detail missing' : 'Required details recorded'}</strong></div>{delivery && <><div><span>Version</span><strong>{delivery.version}</strong></div><div><span>Reference</span><strong className="break-anywhere">{delivery.reference}</strong></div>{delivery.receivedAt && <div><span>Received</span><strong>{dateTime(delivery.receivedAt)}</strong></div>}</>}</div>
    <div className="button-row"><Button onClick={onCheck} disabled={busy}><RefreshCw size={16} aria-hidden="true" />{busy ? 'Working…' : received ? 'Refresh care-team status' : 'Check delivery status'}</Button>{!uncertain && delivery?.canRetryDelivery === true && <Button variant="primary" onClick={onRetry} disabled={busy}>Retry sending saved version<Send size={16} aria-hidden="true" /></Button>}</div>
    {!uncertain && delivery?.canRetryDelivery === true && <p className="metadata retry-explanation">The clinic service found no receipt for this version. Retrying sends the same confirmed answers.</p>}
    {Boolean(delivery?.work.length) && <section className="work-status"><h2>With your care team</h2>{delivery!.work.map(work => <article className="work-item" key={work.id}><div className="section-heading"><h3>{work.title}</h3><span className="status-label">{outcomeLabels[work.status]}</span></div><p className="metadata">{responsibilityLabels[work.responsibility]}</p>{work.outcome ? <><p className="work-outcome">{work.outcome}</p><p className="metadata">{work.author || 'Care team'} · {dateTime(work.at)}</p></> : <p className="work-waiting">No staff-recorded outcome yet.</p>}</article>)}</section>}
    <section className="sent-answers"><div className="section-heading"><h2>{uncertain ? 'Answers in this send request' : 'Your confirmed answers'}</h2>{received && <span className="metadata">A correction creates an update</span>}</div>{session.topics.map(topic => <PatientTopic key={topic.id} topic={topic} sources={session.turns} onChange={received ? slotPath => onChange(topic.id, slotPath) : undefined} disabled={busy} />)}</section>
  </section>;
}
