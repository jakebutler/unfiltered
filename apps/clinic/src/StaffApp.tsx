import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, ClipboardList, LogOut, RefreshCw } from 'lucide-react';
import type { StaffHandoffView, StaffIdentity, StaffQueueItem } from '../../../packages/clinic-contract/src/index';
import { messageOf, request, RequestError } from './api';
import { Button, EmptyQueue, Header, Loading, Notice, SourceInspector, TopicContent, dateTime, outcomeLabels, responsibilityLabels, roleLabels, time, type SourceSelection } from './components';

type Outcome = 'reviewed' | 'needs-information' | 'declined' | 'resolved';
const revisionKey = (handoff: StaffHandoffView) => `${handoff.version}:${handoff.work.map(work => `${work.id}:${work.revision}`).join('|')}`;

export function StaffApp() {
  const [identity, setIdentity] = useState<StaffIdentity>();
  const [queue, setQueue] = useState<StaffQueueItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [queueLoaded, setQueueLoaded] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState(false);
  const [handoff, setHandoff] = useState<StaffHandoffView>();
  const [source, setSource] = useState<SourceSelection>();
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState('');
  const operation = useRef(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [success, setSuccess] = useState('');
  const [stale, setStale] = useState<'refresh' | 'review' | false>(false);
  const [pendingAction, setPendingAction] = useState(false);
  const [hasNote, setHasNote] = useState(false);
  const [navigation, setNavigation] = useState<(() => void)>();

  useEffect(() => {
    request<StaffIdentity>('/api/staff/me').then(setIdentity).catch(e => {
      if (!(e instanceof RequestError && e.status === 401)) setError(messageOf(e));
    }).finally(() => setBooting(false));
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [handoff?.id]);
  const handleError = (e: unknown) => {
    if (e instanceof RequestError && [401, 403].includes(e.status)) {
      setHandoff(undefined); setSource(undefined); setQueue([]);
      setQueueLoaded(false); setQueueError(true); setUpdatedAt(''); setNextCursor(undefined);
      if (e.status === 401) setIdentity(undefined);
    }
    if (e instanceof RequestError && e.status === 409) setStale('refresh');
    setError(messageOf(e));
  };
  const loadQueue = async (cursor?: string) => {
    setQueueLoading(true);
    try {
      const value = await request<{ items: StaffQueueItem[]; nextCursor?: string }>(`/api/staff/queue${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`);
      setQueue(previous => cursor === undefined ? value.items : [...new Map([...previous, ...value.items].map(item => [`${item.id}:${item.responsibility}`, item])).values()]);
      setNextCursor(value.nextCursor); setUpdatedAt(new Date().toISOString());
      setQueueLoaded(true); setQueueError(false);
    } catch (e) {
      setQueueError(true);
      if (e instanceof RequestError && [401, 403].includes(e.status)) handleError(e);
      throw e;
    } finally { setQueueLoading(false); }
  };
  const run = async (name: string, fn: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(name); setError('');
    try { await fn(); } catch (e) { handleError(e); }
    finally { operation.current = false; setBusy(''); }
  };
  const refresh = () => run('refresh', async () => {
    await loadQueue();
    if (handoff) {
      const next = await request<StaffHandoffView>(`/api/staff/handoffs/${encodeURIComponent(handoff.id)}`);
      if (revisionKey(next) !== revisionKey(handoff) || stale || pendingAction) {
        setStale('review'); setSuccess('Saved state refreshed. Review the current answers and recorded work before taking another action.');
      }
      setHandoff(next); setSource(undefined); setPendingAction(false);
    }
  });
  useEffect(() => { if (identity) void run('queue', loadQueue); }, [identity]);
  const openHandoff = (id: string) => run(`open:${id}`, async () => {
    const next = await request<StaffHandoffView>(`/api/staff/handoffs/${encodeURIComponent(id)}`);
    setHandoff(next); setSource(undefined); setSuccess(''); setStale(false); setPendingAction(false);
  });
  const logout = () => run('logout', async () => {
    await request('/api/staff/logout', {});
    setIdentity(undefined); setHandoff(undefined); setQueue([]); setSource(undefined); setSuccess(''); setHasNote(false);
    setQueueLoaded(false); setQueueError(false); setUpdatedAt(''); setNextCursor(undefined);
  });
  const navigate = (action: () => void) => {
    if (hasNote) setNavigation(() => action); else action();
  };
  const recordAction = async (workId: string, outcome: Outcome, note: string) => {
    const work = handoff?.work.find(item => item.id === workId);
    if (!handoff || !work || operation.current) return false;
    operation.current = true; setBusy('action'); setError(''); setSuccess('');
    try {
      const value = await request<StaffHandoffView>(`/api/staff/handoffs/${encodeURIComponent(handoff.id)}/actions`, {
        workId, expectedVersion: handoff.version, expectedWorkVersion: work.revision, outcome, note,
      });
      setHandoff(value); setSuccess('Your outcome was recorded. The patient’s request status now includes it.');
      try { await loadQueue(); } catch { setError('Your outcome is recorded, but the work queue could not refresh. Refresh saved state to update the queue.'); }
      return true;
    } catch (e) {
      if (e instanceof RequestError && e.uncertain) setPendingAction(true);
      handleError(e); return false;
    } finally { operation.current = false; setBusy(''); }
  };
  const selectSource = (selection: SourceSelection, trigger: HTMLButtonElement) => { sourceTrigger.current = trigger; setSource(selection); };
  const closeSource = () => { setSource(undefined); sourceTrigger.current?.focus(); };

  if (booting) return <Loading staff />;
  if (!identity) return <StaffLogin error={error} onSignIn={value => { setIdentity(value); setError(''); setQueueLoaded(false); setQueueError(false); setUpdatedAt(''); }} />;
  return <><Header staff><div className="staff-identity"><strong>{identity.name}</strong><span>{roleLabels[identity.role]}</span></div><Button variant="text" onClick={() => navigate(() => { void logout(); })} disabled={Boolean(busy)}><LogOut size={16} aria-hidden="true" />Sign out</Button></Header>
    <main id="main" className="staff-shell">
      <aside className={`queue-panel ${handoff ? 'has-selection' : ''}`} aria-label="Assigned work queue"><div className="queue-heading"><h1>Work queue</h1><Button variant="text" onClick={refresh} disabled={Boolean(busy)} aria-label="Refresh work queue"><RefreshCw size={18} aria-hidden="true" /></Button></div><p className="queue-context">{queueError ? queueLoaded && queue.length > 0 ? 'Previously loaded work · may be out of date' : 'Current assignments are unavailable' : queueLoading ? busy === 'more' ? 'Loading more assigned work…' : queueLoaded ? 'Refreshing assigned work…' : 'Loading assigned work…' : queueLoaded ? `Assigned to you · ${queue.length} loaded${nextCursor === undefined ? '' : ' · more available'}` : 'Queue not yet loaded'}</p><p className="queue-context mobile-staff-name">{identity.name} · {roleLabels[identity.role]}</p><p className="metadata queue-updated">{updatedAt ? `${queueError ? 'Last successful load' : queueLoading ? 'Previous load' : 'Updated'} at ${time(updatedAt)}` : queueLoading ? 'Loading assigned work…' : 'No successful queue load yet'}</p><div className="queue-list">
        {queueError && <div className="queue-empty queue-unavailable" role="status"><h2>{queueLoaded ? 'Could not refresh the queue' : 'Queue unavailable'}</h2><p>{queueLoaded && queue.length > 0 ? 'Showing previously loaded work. Current assignments may have changed.' : 'Current assignments could not be checked. This does not mean there is no assigned work.'}</p><Button onClick={refresh} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Try loading the queue again</Button></div>}
        {queue.map((item, index) => <button key={`${item.id}:${item.responsibility}:${index}`} className={`queue-item ${handoff?.id === item.id ? 'is-selected' : ''}`} aria-pressed={handoff?.id === item.id} onClick={() => { if (handoff?.id !== item.id) navigate(() => { void openHandoff(item.id); }); }} disabled={Boolean(busy)}><span className="queue-patient">{item.patientName}<ChevronRight size={17} aria-hidden="true" /></span><span className="queue-purpose">{item.scenarioTitle}</span><span className="queue-detail">{responsibilityLabels[item.responsibility]} · {dateTime(item.receivedAt)}</span><span className="queue-status">{outcomeLabels[item.status]}{item.completeness === 'partial' && ' · Partial'}</span></button>)}
        {queueLoaded && !queueError && !queueLoading && !queue.length && nextCursor === undefined && <EmptyQueue />}
        {queueLoaded && !queueError && nextCursor !== undefined && <div className="queue-empty"><p>{queue.length ? 'More assigned work is available.' : 'No work to show on this page. Continue checking your assigned work.'}</p><Button onClick={() => { void run('more', () => loadQueue(nextCursor)); }} disabled={Boolean(busy)}>{busy === 'more' ? 'Loading more work…' : 'Load more work'}<ArrowRight size={16} aria-hidden="true" /></Button></div>}
      </div></aside>
      <section className="handoff-workspace" aria-busy={busy.startsWith('open:')}>
        {error && <Notice tone="attention" action={<Button onClick={refresh} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Refresh saved state</Button>}>{error}{pendingAction && <p>The result of your last action is unconfirmed. Refresh before recording anything else. Your note is still below.</p>}</Notice>}
        {success && <Notice>{success}</Notice>}
        {handoff ? <>
          <Button className="mobile-only queue-back" variant="text" onClick={() => navigate(() => { setHandoff(undefined); setSource(undefined); })}><ArrowLeft size={16} aria-hidden="true" />Work queue</Button>
          <div className="handoff-header"><div><h1 ref={heading} tabIndex={-1}>{handoff.patientName}</h1><p>{handoff.title}</p></div><span className="status-label">Received version {handoff.version}</span></div>
          <div className="handoff-meta"><span>Received {dateTime(handoff.receivedAt)}</span><span>{handoff.completeness === 'partial' ? 'Partial handoff · detail missing' : 'Required details recorded'}</span></div>
          <p className="scope-note">{identity.role === 'administrative' ? 'Administrative request context. Action availability follows your assigned responsibilities.' : 'Full intake and original answers. Clinical context is shared with the assigned care team; available actions follow your role.'}</p>
          {handoff.sources.some(turn => turn.corrects) && <Notice>This record includes corrected answers. Open a detail’s source to compare its current and earlier wording.</Notice>}
          <div className={`handoff-body ${source ? 'with-source' : ''}`}><section className="handoff-answers"><div className="section-heading"><h2>{identity.role === 'administrative' ? 'Request details' : 'Full intake'}</h2><span className="metadata">Patient-reported</span></div>
            {handoff.topics.map(topic => <article className={`staff-answer ${source?.topicId === topic.id ? 'is-selected' : ''}`} key={topic.id}>
              <TopicContent topic={topic} onSource={selectSource} />
              {source?.topicId === topic.id && <div className="mobile-source"><SourceInspector title={source.title} ids={source.ids} sources={handoff.sources} onClose={closeSource} /></div>}
            </article>)}
          </section>{source && <div className="desktop-source"><SourceInspector title={source.title} ids={source.ids} sources={handoff.sources} onClose={closeSource} /></div>}</div>
          <section className="staff-work"><h2>Care-team work</h2>{handoff.work.map(work => <article className="work-item" key={work.id}><div className="section-heading"><h3>{work.title}</h3><span className="status-label">{outcomeLabels[work.status]}</span></div><p className="metadata">{responsibilityLabels[work.responsibility]}</p>{work.outcome ? <><p className="work-outcome">{work.outcome}</p><p className="metadata">{work.author || 'Care team'} · {dateTime(work.at)}</p></> : <p className="metadata">No recorded outcome yet.</p>}</article>)}</section>
          {stale && <Notice tone="attention" action={stale === 'refresh' ? <Button onClick={refresh} disabled={Boolean(busy)}>Refresh the handoff</Button> : <Button onClick={() => setStale(false)}>I’ve reviewed the current version</Button>}>{stale === 'refresh' ? 'This handoff or work item changed. Refresh to see the saved state before recording an outcome.' : 'Review the current answers and recorded outcome before taking another action. Your unrecorded note has been kept.'}</Notice>}
          <StaffActionForm key={handoff.id} handoff={handoff} identity={identity} disabled={Boolean(busy) || Boolean(stale) || pendingAction} onRecord={recordAction} onDraftChange={setHasNote} />
        </> : <div className="handoff-empty"><ClipboardList size={36} aria-hidden="true" /><h2>{busy.startsWith('open:') ? 'Opening handoff…' : 'Select a handoff to review'}</h2><p>Read what the patient shared, inspect its source, and record an outcome for your assigned work.</p></div>}
      </section>
    </main>
    {navigation && <DiscardNoteDialog onCancel={() => setNavigation(undefined)} onDiscard={() => { const action = navigation; setNavigation(undefined); setHasNote(false); action(); }} />}
  </>;
}

function StaffLogin({ error: externalError, onSignIn }: { error: string; onSignIn: (identity: StaffIdentity) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [show, setShow] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submitting = useRef(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { onSignIn(await request<StaffIdentity>('/api/staff/login', { email: email.trim(), password })); setPassword(''); }
    catch (e) { setError(messageOf(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <><Header staff><a className="text-link" href="/">Patient demo<ArrowRight size={15} aria-hidden="true" /></a></Header><main id="main" className="login-page"><h1>Staff sign in</h1><p className="lead">Open your assigned patient handoffs and record the next step.</p><form onSubmit={submit}><div className="field"><label htmlFor="email">Work email</label><input id="email" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} autoCapitalize="none" spellCheck={false} /></div><div className="field"><label htmlFor="password">Password</label><div className="password-input"><input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /><Button variant="text" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>{show ? 'Hide' : 'Show'}</Button></div></div>{(error || externalError) && <Notice tone="attention">{error || externalError}</Notice>}<Button variant="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={17} aria-hidden="true" /></Button></form><p className="login-help">Use the named staff account provided for this demo. Access and available actions are checked by the clinic service.</p></main></>;
}

function StaffActionForm({ handoff, identity, disabled, onRecord, onDraftChange }: {
  handoff: StaffHandoffView; identity: StaffIdentity; disabled: boolean;
  onRecord: (workId: string, outcome: Outcome, note: string) => Promise<boolean>; onDraftChange: (dirty: boolean) => void;
}) {
  const [workId, setWorkId] = useState(handoff.allowedActions[0]?.workId ?? '');
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [note, setNote] = useState('');
  const allowed = handoff.allowedActions.find(action => action.workId === workId);
  const outcomeAllowed = allowed?.outcomes.some(value => value === outcome);
  useEffect(() => { onDraftChange(Boolean(note.trim() || outcome)); }, [note, outcome, onDraftChange]);
  useEffect(() => () => onDraftChange(false), [onDraftChange]);
  useEffect(() => {
    if (!note && !outcome) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [note, outcome]);
  if (!handoff.allowedActions.length) return <p className="scope-note">You can inspect this handoff. No work actions are currently available to your account.</p>;
  return <section className="staff-action-form"><h2>Record your outcome</h2><p>This deliberate review action is attributed to {identity.name}, {roleLabels[identity.role].toLowerCase()}.</p><form onSubmit={async event => { event.preventDefault(); if (outcome && outcomeAllowed && await onRecord(workId, outcome, note.trim())) { setNote(''); setOutcome(''); } }}><fieldset disabled={disabled}><legend className="sr-only">Review outcome</legend><div className="field"><label htmlFor="work-item">Work item</label><select id="work-item" value={workId} onChange={event => { setWorkId(event.target.value); setOutcome(''); }}><option value="" disabled>Choose a work item</option>{handoff.allowedActions.map(action => <option key={action.workId} value={action.workId}>{handoff.work.find(work => work.id === action.workId)?.title || action.workId}</option>)}</select></div><div className="field"><label htmlFor="outcome">Review result</label><select id="outcome" required value={outcomeAllowed ? outcome : ''} onChange={event => setOutcome(event.target.value as Outcome | '')}><option value="">Choose a result</option>{allowed?.outcomes.map(value => <option key={value} value={value}>{outcomeLabels[value]}</option>)}</select></div><div className="field"><label htmlFor="outcome-note">Outcome and next step</label><textarea id="outcome-note" rows={4} required value={note} onChange={event => setNote(event.target.value)} aria-describedby="outcome-help" /><p className="field-hint" id="outcome-help">Visible in the patient’s request status. Describe what you reviewed, any remaining question, and the next step. Record only actions that actually happened.</p></div><Button variant="primary" type="submit" disabled={!outcomeAllowed || !note.trim() || disabled}>Record outcome<Check size={17} aria-hidden="true" /></Button></fieldset></form></section>;
}

function DiscardNoteDialog({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className="discard-dialog" aria-labelledby="discard-note-title" aria-describedby="discard-note-description" onCancel={event => { event.preventDefault(); onCancel(); }}><h2 id="discard-note-title">Leave this unrecorded note?</h2><p id="discard-note-description">Your outcome has not been recorded. Leaving this handoff will discard the note you entered.</p><div className="button-row"><Button variant="primary" autoFocus onClick={onCancel}>Keep editing</Button><Button onClick={onDiscard}>Discard note and continue</Button></div></dialog>;
}
