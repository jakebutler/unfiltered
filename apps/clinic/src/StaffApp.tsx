import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, ClipboardList, LogOut, RefreshCw } from 'lucide-react';
import type { SafetyCategoryView, SafetyLevelView, StaffHandoffView, StaffIdentity, StaffQueueItem, StaffRecoveryItem, StaffSafetyAction, StaffSafetyItem, StaffSafetyView, TopicView } from '../../../packages/clinic-contract/src/index';
import { messageOf, request, RequestError } from './api';
import { freezeStaffAction, handoffRevision, reconcileStaffAction, StaffResponseScope, type PendingStaffAction } from './staff-delivery-state';
import { Button, EmptyQueue, Header, Loading, Notice, SourceInspector, WorkHistory, TopicContent, answerLabels, topicLabels, deliveryLabels, workDeliveryLabels, dateTime, outcomeLabels, responsibilityLabels, roleLabels, time, type SourceSelection } from './components';

type Outcome = 'reviewed' | 'needs-information' | 'declined' | 'resolved';
type QueuePage = { items: StaffQueueItem[]; recovery: StaffRecoveryItem[]; earlierVersion?: number; nextCursor?: string; recoveryCursor?: string };
const canInspect = (handoff: StaffHandoffView) => handoff.anchorsVerified === true;
type StaffSafetyPage = { items: StaffSafetyItem[]; nextCursor?: string };
type SafetyOutcome = StaffSafetyAction['outcome'];
const safetyOutcomes: SafetyOutcome[] = ['no-concern', 'contacted-patient', 'escalated'];
const safetyLevelLabels: Record<SafetyLevelView, string> = { none: 'None', low: 'Low', moderate: 'Moderate', high: 'High', imminent: 'Imminent' };
const safetyCategoryLabels: Record<SafetyCategoryView, string> = { 'self-harm': 'Self-harm', 'medical-urgent': 'Urgent medical', 'medication-substance': 'Medication or substance', eating: 'Eating', 'abuse-safety': 'Abuse or safety', 'mental-distress': 'Mental distress' };
const safetyOutcomeLabels: Record<SafetyOutcome, string> = { 'no-concern': 'No concern', 'contacted-patient': 'Contacted patient', escalated: 'Escalated' };
const categoryText = (values: SafetyCategoryView[]) => values.length ? values.map(value => safetyCategoryLabels[value]).join(', ') : 'None';
const roleText = (role: string) => (roleLabels as Record<string, string>)[role] ?? role;

export function StaffApp() {
  const [identity, setIdentity] = useState<StaffIdentity>();
  const [queue, setQueue] = useState<StaffQueueItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [recovery, setRecovery] = useState<StaffRecoveryItem[]>([]);
  const [recoveryCursor, setRecoveryCursor] = useState<string>();
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const scope = useRef(new StaffResponseScope());
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
  const [pendingAction, setPendingAction] = useState<PendingStaffAction>();
  const [recordedActionId, setRecordedActionId] = useState<string>();
  const [hasNote, setHasNote] = useState(false);
  const [navigation, setNavigation] = useState<(() => void)>();
  const [safetySessionId, setSafetySessionId] = useState<string>();

  const clearScope = () => {
    scope.current.invalidate(); operation.current = false; setBusy(''); setQueueLoading(false); setRecoveryLoading(false);
    setHandoff(undefined); setSource(undefined); sourceTrigger.current = null; setQueue([]); setRecovery([]);
    setQueueLoaded(false); setRecoveryLoaded(false); setQueueError(false); setRecoveryError(false);
    setUpdatedAt(''); setNextCursor(undefined); setRecoveryCursor(undefined);
    setPendingAction(undefined); setRecordedActionId(undefined); setSuccess(''); setStale(false); setHasNote(false); setNavigation(undefined); setSafetySessionId(undefined);
  };
  useEffect(() => {
    const generation = scope.current.capture();
    request<StaffIdentity>('/api/staff/me').then(value => {
      if (scope.current.accepts(generation)) setIdentity(value);
    }).catch(e => {
      if (scope.current.accepts(generation) && !(e instanceof RequestError && e.status === 401)) setError(messageOf(e));
    }).finally(() => { if (scope.current.accepts(generation)) setBooting(false); });
    return () => scope.current.invalidate();
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [handoff?.id]);
  const handleError = (e: unknown) => {
    if (e instanceof RequestError && [401, 403].includes(e.status)) {
      clearScope(); setIdentity(undefined);
    }
    if (e instanceof RequestError && e.status === 409) setStale('refresh');
    setError(messageOf(e));
  };
  const [earlierVersion, setEarlierVersion] = useState(0);
  const loadQueue = async (kind: 'both' | 'snapshots' | 'drafts' = 'both', cursor?: string) => {
    const generation = scope.current.capture();
    if (kind !== 'drafts') setQueueLoading(true);
    setRecoveryLoading(true);
    const parameter = kind === 'drafts' ? 'recoveryCursor' : 'cursor';
    try {
      const value = await request<QueuePage>(`/api/staff/queue${cursor === undefined ? '' : `?${parameter}=${encodeURIComponent(cursor)}`}`);
      if (!scope.current.accepts(generation)) return;
      if (kind !== 'drafts') {
        setQueue(previous => cursor === undefined ? value.items : [...new Map([...previous, ...value.items].map(item => [`${item.id}:${item.responsibility}`, item])).values()]);
        setNextCursor(value.nextCursor); setQueueLoaded(true); setQueueError(false);
        setEarlierVersion(previous => (cursor === undefined ? 0 : previous) + (value.earlierVersion ?? 0));
      }
      // Snapshot pages contain both received assignments and pending deliveries.
      // Draft pages add no-snapshot confirmations; they must not rewind the snapshot cursor.
      setRecovery(previous => kind === 'both' ? value.recovery : [...new Map([...previous, ...value.recovery].map(item => [item.id, item])).values()]);
      if (kind !== 'snapshots') setRecoveryCursor(value.recoveryCursor);
      setRecoveryLoaded(true); setRecoveryError(false);
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      if (!scope.current.accepts(generation)) return;
      if (kind !== 'drafts') setQueueError(true);
      setRecoveryError(true);
      if (e instanceof RequestError && [401, 403].includes(e.status)) handleError(e);
      throw e;
    } finally {
      if (scope.current.accepts(generation)) { setQueueLoading(false); setRecoveryLoading(false); }
    }
  };
  const run = async (name: string, fn: () => Promise<void>) => {
    if (operation.current) return;
    const generation = scope.current.capture();
    operation.current = true; setBusy(name); setError('');
    try { await fn(); } catch (e) { if (scope.current.accepts(generation)) handleError(e); }
    finally { if (scope.current.accepts(generation)) { operation.current = false; setBusy(''); } }
  };
  const acceptReadback = (next: StaffHandoffView) => {
    if (handoff && next.id !== handoff.id) return;
    if (pendingAction) {
      const result = reconcileStaffAction(pendingAction, next);
      if (result === 'recorded') {
        setRecordedActionId(pendingAction.request.actionId); setPendingAction(undefined);
        const work = next.work.find(item => item.id === pendingAction.request.workId);
        if (stale === 'refresh' || work?.status === 'external-change' || work?.history?.at(-1)?.actionId !== pendingAction.request.actionId) setStale('review');
        setSuccess('Your earlier outcome is confirmed in authenticated action history. Any later outcome is shown separately.');
      } else {
        setPendingAction({ ...pendingAction, checked: result === 'unconfirmed' });
        setSuccess('');
        setError(result === 'conflict' ? 'This saved action does not match the original request. Keep the original request and ask the clinic operator to investigate.' : 'The result of your earlier action is still unconfirmed. You can explicitly retry the same request with its original action ID and saved revision.');
      }
    } else if (handoff && (handoffRevision(next) !== handoffRevision(handoff) || stale === 'refresh')) {
      setStale('review'); setSuccess('Saved state refreshed. Review the current answers and recorded work before taking another action.');
    }
    setHandoff(next);
    // Keep the open source and editor mounted during readback of the same immutable version.
    if (!canInspect(next)) { setSource(undefined); sourceTrigger.current = null; }
  };
  const refresh = () => run('refresh', async () => {
    const generation = scope.current.capture();
    // The selected action readback is independent of queue availability.
    const results = await Promise.allSettled([
      loadQueue(),
      handoff ? request<StaffHandoffView>(`/api/staff/handoffs/${encodeURIComponent(handoff.id)}`).catch(e => {
        if (scope.current.accepts(generation) && e instanceof RequestError && [401, 403].includes(e.status)) handleError(e);
        throw e;
      }) : Promise.resolve(undefined),
    ]);
    if (!scope.current.accepts(generation)) return;
    const selected = results[1];
    if (selected.status === 'fulfilled' && selected.value) acceptReadback(selected.value);
    for (const result of results) if (result.status === 'rejected') {
      handleError(result.reason);
      if (result.reason instanceof RequestError && [401, 403].includes(result.reason.status)) break;
    }
  });
  useEffect(() => { if (identity) void run('queue', () => loadQueue()); }, [identity]);
  const openHandoff = (id: string) => run(`open:${id}`, async () => {
    if (pendingAction) return;
    const generation = scope.current.capture();
    const next = await request<StaffHandoffView>(`/api/staff/handoffs/${encodeURIComponent(id)}`);
    if (!scope.current.accepts(generation)) return;
    if (next.id !== id) throw new RequestError('The returned handoff did not match your selection. Refresh saved state.', 0, 'handoff-scope-changed', true);
    setHandoff(next); setSource(undefined); sourceTrigger.current = null;
    setSuccess(''); setStale(false); setRecordedActionId(undefined); setSafetySessionId(undefined);
  });
  const logout = () => run('logout', async () => {
    await request('/api/staff/logout', {});
    clearScope(); setIdentity(undefined);
  });
  const navigate = (action: () => void) => {
    if (pendingAction && !pendingAction.checked) { setError('Check the original action before leaving this handoff. Its result is still unconfirmed.'); return; }
    if (hasNote || pendingAction) setNavigation(() => action); else action();
  };
  const submitAction = async (attempt: PendingStaffAction) => {
    if (operation.current) return false;
    const generation = scope.current.capture();
    operation.current = true; setBusy('action'); setError(''); setSuccess('');
    setPendingAction({ ...attempt, checked: false });
    try {
      const value = await request<StaffHandoffView>(`/api/staff/handoffs/${encodeURIComponent(attempt.handoffId)}/actions`, attempt.request);
      if (!scope.current.accepts(generation)) return false;
      if (value.id !== attempt.handoffId || value.version !== attempt.request.expectedVersion) {
        setError('The returned action did not match the original handoff scope. Check saved state before taking another action.');
        return false;
      }
      setHandoff(value);
      if (reconcileStaffAction(attempt, value) !== 'recorded') {
        setError('The service response did not confirm this action in authenticated history. Refresh saved state before taking another action.');
        return false;
      }
      setPendingAction(undefined); setRecordedActionId(attempt.request.actionId);
      const work = value.work.find(item => item.id === attempt.request.workId);
      if (work?.status === 'external-change' || work?.history?.at(-1)?.actionId !== attempt.request.actionId) setStale('review');
      setSuccess('Your outcome was recorded. The patient’s request status now includes it.');
      try { await loadQueue(); } catch (e) {
        if (scope.current.accepts(generation)) {
          if (e instanceof RequestError && [401, 403].includes(e.status)) handleError(e);
          else setError('Your outcome is recorded, but the work queue could not refresh. Refresh saved state to update the queue.');
        }
      }
      return scope.current.accepts(generation);
    } catch (e) {
      if (!scope.current.accepts(generation)) return false;
      // Unknown outcomes retain the exact UUID, bytes and original expected revision.
      if (e instanceof RequestError && !e.uncertain && ![409, 429].includes(e.status)) setPendingAction(undefined);
      handleError(e); return false;
    } finally { if (scope.current.accepts(generation)) { operation.current = false; setBusy(''); } }
  };
  const recordAction = async (workId: string, outcome: Outcome, note: string) => {
    const work = handoff?.work.find(item => item.id === workId);
    if (!identity || !handoff || !work || pendingAction || operation.current || !canInspect(handoff) || work.delivery !== 'verified' || !handoff.allowedActions.some(action => action.workId === workId && action.outcomes.includes(outcome))) return false;
    return submitAction(freezeStaffAction(handoff, identity, {
      actionId: crypto.randomUUID(), workId, expectedVersion: handoff.version, expectedWorkVersion: work.revision, outcome, note,
    }));
  };
  const resumeDelivery = () => run('resume', async () => {
    if (!handoff?.canResume || pendingAction) return;
    const generation = scope.current.capture();
    const next = await request<StaffHandoffView>(`/api/staff/handoffs/${encodeURIComponent(handoff.id)}/resume`, {});
    if (!scope.current.accepts(generation)) return;
    if (next.id !== handoff.id || next.version !== handoff.version) throw new RequestError('Delivery readback did not match the saved confirmation. Refresh saved state.', 0, 'handoff-scope-changed', true);
    acceptReadback(next);
    setSuccess(next.deliveryState === 'received' ? 'Complete delivery is verified. The saved confirmation has been received.' : 'Delivery progress checked. The complete handoff is still awaiting verification.');
    await loadQueue();
  });
  const selectSource = (selection: SourceSelection, trigger: HTMLButtonElement) => { sourceTrigger.current = trigger; setSource(selection); };
  const closeSource = () => { setSource(undefined); sourceTrigger.current?.focus(); };
  const openSafety = (sessionId: string) => navigate(() => {
    setHandoff(undefined); setSource(undefined); sourceTrigger.current = null;
    setSuccess(''); setStale(false); setRecordedActionId(undefined); setSafetySessionId(sessionId);
  });

  if (booting) return <Loading staff />;
  if (!identity) return <StaffLogin error={error} onSignIn={value => { clearScope(); setIdentity(value); setError(''); setQueueLoaded(false); setQueueError(false); setUpdatedAt(''); }} />;
  return <><Header staff><div className="staff-identity"><strong>{identity.name}</strong><span>{roleLabels[identity.role]}</span></div><Button variant="text" onClick={() => navigate(() => { void logout(); })} disabled={Boolean(busy)}><LogOut size={16} aria-hidden="true" />Sign out</Button></Header>
    <main id="main" tabIndex={-1} className="staff-shell">
      <aside className={`queue-panel ${handoff ? 'has-selection' : ''}`} aria-label="Assigned work queue"><div className="queue-heading"><h1>Work queue</h1><Button variant="text" onClick={refresh} disabled={Boolean(busy)} aria-label="Refresh work queue"><RefreshCw size={18} aria-hidden="true" /></Button></div><p className="queue-context">{queueError ? queueLoaded && queue.length > 0 ? 'Previously loaded work · may be out of date' : 'Current assignments are unavailable' : queueLoading ? busy === 'more' ? 'Loading more assigned work…' : queueLoaded ? 'Refreshing assigned work…' : 'Loading assigned work…' : queueLoaded ? `Assigned to you · ${queue.length} loaded${nextCursor === undefined ? '' : ' · more available'}` : 'Queue not yet loaded'}</p>{earlierVersion > 0 && <p className="queue-context">{earlierVersion === 1 ? '1 earlier handoff was' : `${earlierVersion} earlier handoffs were`} recorded under a previous questionnaire version. It stays in the record but can’t be shown here.</p>}<p className="queue-context mobile-staff-name">{identity.name} · {roleLabels[identity.role]}</p><p className="metadata queue-updated">{updatedAt ? `${queueError ? 'Last successful load' : queueLoading ? 'Previous load' : 'Updated'} at ${time(updatedAt)}` : queueLoading ? 'Loading assigned work…' : 'No successful queue load yet'}</p><div className="queue-list">
        {queueError && <div className="queue-empty queue-unavailable" role="status"><h2>{queueLoaded ? 'Could not refresh the queue' : 'Queue unavailable'}</h2><p>{queueLoaded && queue.length > 0 ? 'Showing previously loaded work. Current assignments may have changed.' : 'Current assignments could not be checked. This does not mean there is no assigned work.'}</p><Button onClick={refresh} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Try loading the queue again</Button></div>}
        {queue.map((item, index) => <button key={`${item.id}:${item.responsibility}:${index}`} className={`queue-item ${handoff?.id === item.id ? 'is-selected' : ''}`} aria-pressed={handoff?.id === item.id} onClick={() => { if (handoff?.id !== item.id) navigate(() => { void openHandoff(item.id); }); }} disabled={Boolean(busy) || Boolean(pendingAction)}><span className="queue-patient">{item.patientName}<ChevronRight size={17} aria-hidden="true" /></span><span className="queue-purpose">{item.scenarioTitle}</span><span className="queue-detail">{responsibilityLabels[item.responsibility]}{item.receivedAt ? ` · Complete delivery ${dateTime(item.receivedAt)}` : ' · Work received; open for complete-delivery status'}</span><span className="queue-status">{outcomeLabels[item.status]}{identity.role !== 'administrative' && item.completeness === 'partial' && ' · Partial'}</span></button>)}
        {queueLoaded && !queueError && !queueLoading && !queue.length && nextCursor === undefined && <EmptyQueue />}
        {queueLoaded && !queueError && nextCursor !== undefined && <div className="queue-empty"><p>{queue.length ? 'More assigned work is available.' : 'No work to show on this page. Continue checking your assigned work.'}</p><Button onClick={() => { void run('more', () => loadQueue('snapshots', nextCursor)); }} disabled={Boolean(busy)}>{busy === 'more' ? 'Loading more work…' : 'Load more work'}<ArrowRight size={16} aria-hidden="true" /></Button></div>}
      </div><RecoveryQueue items={recovery} loaded={recoveryLoaded} loading={recoveryLoading} error={recoveryError} cursor={nextCursor ?? recoveryCursor} selectedId={handoff?.id} disabled={Boolean(busy) || Boolean(pendingAction)} onOpen={id => { if (handoff?.id !== id) navigate(() => { void openHandoff(id); }); }} onMore={() => { void run('more-recovery', () => loadQueue(nextCursor !== undefined ? 'snapshots' : 'drafts', nextCursor ?? recoveryCursor)); }} onRefresh={refresh} /><SafetyQueue selectedId={safetySessionId} disabled={Boolean(busy) || Boolean(pendingAction)} onOpen={id => { if (safetySessionId !== id) openSafety(id); }} onAuthError={handleError} /></aside>
      <section className="handoff-workspace" aria-busy={busy.startsWith('open:')}>
        {error && <Notice tone="attention" action={<Button onClick={refresh} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Refresh saved state</Button>}>{error}</Notice>}
        {success && <Notice>{success}</Notice>}
        {pendingAction && <Notice tone="attention" action={<div className="button-row"><Button onClick={refresh} disabled={Boolean(busy)}>Check original action</Button>{pendingAction.checked && <Button onClick={() => { void submitAction(pendingAction); }} disabled={Boolean(busy)}>Retry original action</Button>}</div>}>The result of your last action is unconfirmed. Your original request and note are retained. Check saved state before retrying.<p className="metadata break-anywhere">Action reference: {pendingAction.request.actionId}</p></Notice>}
        {safetySessionId ? <SafetyDetail key={safetySessionId} sessionId={safetySessionId} onBack={() => setSafetySessionId(undefined)} onAuthError={handleError} /> : handoff ? <>
          <Button disabled={Boolean(busy) || Boolean(pendingAction)} className="mobile-only queue-back" variant="text" onClick={() => navigate(() => { setHandoff(undefined); setSource(undefined); })}><ArrowLeft size={16} aria-hidden="true" />Work queue</Button>
          <div className="handoff-header"><div><h1 ref={heading} tabIndex={-1}>{handoff.patientName}</h1><p>{handoff.title}</p></div><span className="status-label">{handoff.deliveryState === 'received' ? 'Received' : 'Confirmed'} version {handoff.version}</span></div>
          <div className="handoff-meta"><span>{handoff.deliveryState === 'received' ? handoff.receivedAt ? `Complete delivery ${dateTime(handoff.receivedAt)}` : 'Complete delivery verified · receipt time not established' : 'Complete delivery pending'}</span>{identity.role !== 'administrative' && handoff.completeness !== undefined && <span>{handoff.completeness === 'partial' ? 'Partial handoff · detail missing' : 'Required details recorded'}</span>}</div>
          <StaffDeliverySummary handoff={handoff} busy={Boolean(busy) || Boolean(pendingAction)} onResume={resumeDelivery} />
          <p className="scope-note">{identity.role === 'administrative' ? 'Administrative details only. Clinical history and conversation sources are available to the clinical care team. Action availability follows your assigned responsibilities.' : 'Full intake and original answers. Clinical context is shared with the assigned care team; available actions follow your role.'}</p>
          {identity.role !== 'administrative' && canInspect(handoff) && handoff.sources.some(turn => turn.corrects) && <Notice>This record includes corrected answers. Open a detail’s source to compare its current and earlier wording.</Notice>}
          {canInspect(handoff) ? <div className={`handoff-body ${source ? 'with-source' : ''}`}><section className="handoff-answers"><div className="section-heading"><h2>{identity.role === 'administrative' ? 'Request details' : 'Full intake'}</h2><span className="metadata">Patient-reported</span></div>
            {handoff.topics.map(topic => <article className={`staff-answer ${source?.topicId === topic.id ? 'is-selected' : ''}`} key={topic.id}>
              {identity.role === 'administrative' ? <AdministrativeTopicContent topic={topic} /> : <TopicContent topic={topic} onSource={selectSource} />}
              {source?.topicId === topic.id && <div className="mobile-source"><SourceInspector title={source.title} ids={source.ids} provenance={source.provenance} sources={handoff.sources} onClose={closeSource} /></div>}
            </article>)}
          </section>{source && <div className="desktop-source"><SourceInspector title={source.title} ids={source.ids} provenance={source.provenance} sources={handoff.sources} onClose={closeSource} /></div>}</div> : <Notice tone="attention">Confirmed delivery metadata only. The clinical anchors have not been verified, so answers and conversation sources are unavailable here.</Notice>}
          <section className="staff-work"><h2>Care-team work</h2>{handoff.work.map(work => <article className="work-item" key={work.id}><div className="section-heading"><h3>{work.title}</h3><span className="status-label">{outcomeLabels[work.status]}</span></div><p className="metadata">{responsibilityLabels[work.responsibility]} · {workDeliveryLabels[work.delivery ?? 'unknown']}</p>{work.status === 'external-change' && <p className="work-waiting">The current work item changed outside an authenticated clinic action. Earlier authenticated outcomes remain in history.</p>}{canInspect(handoff) && work.status !== 'external-change' && work.outcome ? <><p className="work-outcome">{work.outcome}</p><p className="metadata">{work.author || 'Care team'} · {dateTime(work.at)}</p></> : <p className="metadata">No recorded outcome yet.</p>}{canInspect(handoff) && <WorkHistory work={work} />}</article>)}</section>
          {stale && <Notice tone="attention" action={stale === 'refresh' ? <Button onClick={refresh} disabled={Boolean(busy)}>Refresh the handoff</Button> : <Button onClick={() => setStale(false)}>I’ve reviewed the current version</Button>}>{stale === 'refresh' ? 'This handoff or work item changed. Refresh to see the saved state before recording an outcome.' : 'Review the current answers and recorded outcome before taking another action. Your unrecorded note has been kept.'}</Notice>}
          <StaffActionForm key={handoff.id} recordedActionId={recordedActionId} handoff={handoff} identity={identity} disabled={Boolean(busy) || Boolean(stale) || Boolean(pendingAction) || !canInspect(handoff)} onRecord={recordAction} onDraftChange={setHasNote} />
        </> : <div className="handoff-empty"><ClipboardList size={36} aria-hidden="true" /><h2>{busy.startsWith('open:') ? 'Opening handoff…' : 'Select a handoff to review'}</h2><p>Read what the patient shared, inspect its source, and record an outcome for your assigned work.</p></div>}
      </section>
    </main>
    {navigation && <DiscardNoteDialog unknownAction={pendingAction?.request.actionId} onCancel={() => setNavigation(undefined)} onDiscard={() => { const action = navigation; setNavigation(undefined); setHasNote(false); action(); }} />}
  </>;
}

export function RecoveryQueue({ items, loaded, loading, error, cursor, selectedId, disabled, onOpen, onMore, onRefresh }: {
  items: StaffRecoveryItem[]; loaded: boolean; loading: boolean; error: boolean; cursor?: string; selectedId?: string;
  disabled: boolean; onOpen: (id: string) => void; onMore: () => void; onRefresh: () => void;
}) {
  return <section className="recovery-queue" aria-labelledby="recovery-queue-title" aria-busy={loading}>
    <h2 id="recovery-queue-title">Delivery to complete</h2><p className="queue-context">Saved patient confirmations · delivery still pending</p>
    {error && <div className="queue-empty" role="status"><p>Delivery recovery could not be checked. Previously loaded items may be out of date.</p><Button onClick={onRefresh} disabled={disabled}>Check delivery recovery</Button></div>}
    {items.map(item => <button className={`queue-item recovery-item ${selectedId === item.id ? 'is-selected' : ''}`} key={item.id} aria-pressed={selectedId === item.id} onClick={() => onOpen(item.id)} disabled={disabled}>
      <span className="queue-patient">{item.patientName}<ChevronRight size={17} aria-hidden="true" /></span><span className="queue-purpose">{item.scenarioTitle}</span><span className="queue-status">{deliveryLabels[item.deliveryState]}</span><span className="queue-detail">{item.anchorsVerified ? 'Verified answers available · routing pending' : 'Confirmation saved · metadata only'}</span>
    </button>)}
    {loading && <p className="queue-context" role="status">Checking saved confirmations…</p>}
    {loaded && !loading && !error && items.length === 0 && cursor === undefined && <p className="queue-context">No incomplete deliveries in your current scope.</p>}
    {loaded && !error && cursor !== undefined && <div className="queue-empty"><p>More saved confirmations may need delivery.</p><Button onClick={onMore} disabled={disabled}>Load more pending deliveries<ArrowRight size={16} aria-hidden="true" /></Button></div>}
  </section>;
}

export function StaffDeliverySummary({ handoff, busy, onResume }: { handoff: StaffHandoffView; busy: boolean; onResume: () => void }) {
  const state = handoff.deliveryState ?? 'unknown';
  return <section className="staff-delivery-summary" aria-label="Delivery status"><div className="section-heading"><h2>Delivery status</h2><span className="status-label">{deliveryLabels[state]}</span></div>
    <p>{state === 'received' ? 'The complete saved handoff is verified. Care-team review outcomes are shown separately.' : handoff.anchorsVerified ? 'The confirmed answers are verified and available to your assigned team. Delivery of all required work is still pending.' : 'Patient confirmation is saved. Delivery of the confirmed answers has not yet been verified.'}</p>
    {handoff.canResume && <Button onClick={onResume} disabled={busy}>Complete delivery of this saved version<ArrowRight size={16} aria-hidden="true" /></Button>}
    {state !== 'received' && <p className="metadata">Each explicit delivery action checks this saved confirmation once. Refresh reads the current state.</p>}
  </section>;
}

const administrativeChoiceLabels: Record<string, Record<string, string>> = {
  issueType: { 'bill-question': 'A bill question', 'coverage-question': 'A coverage question', 'payment-question': 'A payment question', 'other-request': 'Another billing request' },
  requestedResolution: { explanation: 'An explanation', 'review-possible-error': 'Review a possible error', 'payment-options': 'Discuss payment options', 'contact-me': 'Contact me' },
  intent: { request: 'Request a visit', change: 'Change a visit', cancel: 'Cancel a visit' },
  visitCategory: { 'first-visit': 'First visit', 'follow-up': 'Follow-up visit', 'not-sure': 'Not sure' },
  timezone: { 'America/New_York': 'Eastern time', 'America/Chicago': 'Central time', 'America/Denver': 'Mountain time', 'America/Los_Angeles': 'Pacific time', 'America/Anchorage': 'Alaska time', 'Pacific/Honolulu': 'Hawaii time' },
};

function administrativeDetailText(detail: NonNullable<TopicView['details']>[number]) {
  const value = detail.text;
  if (detail.state !== 'answered' || !value) return value || 'No value recorded.';
  if (['serviceDate', 'requestedDate'].includes(detail.id) && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
  }
  const choices = Object.hasOwn(administrativeChoiceLabels, detail.id) ? administrativeChoiceLabels[detail.id] : undefined;
  return choices && Object.hasOwn(choices, value) ? choices[value] : value;
}

function AdministrativeTopicContent({ topic }: { topic: TopicView }) {
  return <>
    <div className="section-heading"><h3>{topic.title}</h3></div>
    <dl className="answer-details">{topic.details?.map(detail => <div className="answer-detail" key={detail.id}><dt>{detail.label}</dt><dd><p className="answer-label">{answerLabels[detail.state]}</p><p className="answer-text">{administrativeDetailText(detail)}</p></dd></div>)}</dl>
    {topic.missingDetails.length > 0 && <details className="detail-gaps"><summary>Still to clarify · {topic.missingDetails.length} detail{topic.missingDetails.length === 1 ? '' : 's'}</summary><ul>{topic.missingDetails.map((detail, index) => <li key={`${index}:${detail}`}>{detail}</li>)}</ul></details>}
    <div className="answer-footer"><span className={`topic-status topic-status--${topic.status}`}>{topicLabels[topic.status]}</span></div>
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
  return <><Header staff><a className="text-link" href="/">Patient demo<ArrowRight size={15} aria-hidden="true" /></a></Header><main id="main" tabIndex={-1} className="login-page"><h1>Staff sign in</h1><p className="lead">Open your assigned patient handoffs and record the next step.</p><form onSubmit={submit}><div className="field"><label htmlFor="email">Work email</label><input id="email" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} autoCapitalize="none" spellCheck={false} /></div><div className="field"><label htmlFor="password">Password</label><div className="password-input"><input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /><Button variant="text" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>{show ? 'Hide' : 'Show'}</Button></div></div>{(error || externalError) && <Notice tone="attention">{error || externalError}</Notice>}<Button variant="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={17} aria-hidden="true" /></Button></form><p className="login-help">Use the named staff account provided for this demo. Access and available actions are checked by the clinic service.</p></main></>;
}

export function StaffActionForm({ handoff, identity, disabled, recordedActionId, onRecord, onDraftChange }: {
  handoff: StaffHandoffView; identity: StaffIdentity; disabled: boolean; recordedActionId?: string;
  onRecord: (workId: string, outcome: Outcome, note: string) => Promise<boolean>; onDraftChange: (dirty: boolean) => void;
}) {
  const [workId, setWorkId] = useState(handoff.allowedActions[0]?.workId ?? '');
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [note, setNote] = useState('');
  useEffect(() => { if (recordedActionId) { setNote(''); setOutcome(''); } }, [recordedActionId]);
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

function DiscardNoteDialog({ unknownAction, onCancel, onDiscard }: { unknownAction?: string; onCancel: () => void; onDiscard: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className="discard-dialog" aria-labelledby="discard-note-title" aria-describedby="discard-note-description" onCancel={event => { event.preventDefault(); onCancel(); }}><h2 id="discard-note-title">{unknownAction ? 'Leave an unconfirmed action?' : 'Leave this unrecorded note?'}</h2><p id="discard-note-description">{unknownAction ? 'Saved state has been checked, but this action is still unconfirmed. It may already be recorded. Signing out clears the local original request and note.' : 'Your outcome has not been recorded. Leaving this handoff will discard the note you entered.'}</p>{unknownAction && <p className="metadata break-anywhere">Action reference: {unknownAction}</p>}<div className="button-row"><Button variant="primary" autoFocus onClick={onCancel}>Keep editing</Button><Button onClick={onDiscard}>Discard note and continue</Button></div></dialog>;
}

export function SafetyQueue({ selectedId, disabled, onOpen, onAuthError }: { selectedId?: string; disabled: boolean; onOpen: (sessionId: string) => void; onAuthError: (error: unknown) => void }) {
  const [access, setAccess] = useState<'checking' | 'granted' | 'hidden'>('checking');
  const [items, setItems] = useState<StaffSafetyItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(false);
  const load = async (cursor?: string) => {
    setLoading(true); setError(false);
    try {
      const value = await request<StaffSafetyPage>(`/api/staff/safety${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`);
      if (!alive.current) return;
      setItems(previous => cursor === undefined ? value.items : [...previous, ...value.items]);
      setNextCursor(value.nextCursor); setAccess('granted');
    } catch (e) {
      if (!alive.current) return;
      // Only clinicians can see safety reviews; other roles receive 404 and the section stays hidden.
      if (e instanceof RequestError && e.status === 404 && cursor === undefined) setAccess('hidden');
      else if (e instanceof RequestError && [401, 403].includes(e.status)) onAuthError(e);
      else setError(true);
    } finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  if (access === 'hidden') return null;
  // Open reviews first; the sort is stable, so server order is kept within each group.
  const ordered = [...items].sort((a, b) => Number(b.open > 0) - Number(a.open > 0));
  return <section className="safety-queue" aria-labelledby="safety-queue-title" aria-busy={loading}>
    <h2 id="safety-queue-title">Safety review</h2>
    <p className="queue-context">Patient messages flagged for clinician review{access === 'granted' ? ` · ${items.length} loaded${nextCursor === undefined ? '' : ' · more available'}` : ''}</p>
    {error && <div className="queue-empty" role="status"><p>Safety reviews could not be loaded. Previously loaded items may be out of date.</p><Button onClick={() => void load()} disabled={loading}><RefreshCw size={16} aria-hidden="true" />Try loading safety reviews again</Button></div>}
    {loading && <p className="queue-context" role="status">{items.length ? 'Loading more safety reviews…' : 'Loading safety reviews…'}</p>}
    {ordered.map(item => <button key={item.sessionId} className={`queue-item safety-item ${selectedId === item.sessionId ? 'is-selected' : ''}`} aria-pressed={selectedId === item.sessionId} onClick={() => onOpen(item.sessionId)} disabled={disabled}>
      <span className="queue-patient">{item.patientName}<ChevronRight size={17} aria-hidden="true" /></span>
      <span className="queue-purpose">{item.scenario}</span>
      <span className="queue-status">{item.open} open · highest {safetyLevelLabels[item.highestLevel]}{item.escalated && <span className="safety-badge">Model escalated</span>}</span>
      <span className="queue-detail">Categories: {categoryText(item.categories)}</span>
    </button>)}
    {access === 'granted' && !loading && !error && !items.length && <p className="queue-context">No flagged messages in your scope.</p>}
    {access === 'granted' && nextCursor !== undefined && <div className="queue-empty"><Button onClick={() => void load(nextCursor)} disabled={loading}>{loading ? 'Loading…' : 'Load more safety reviews'}<ArrowRight size={16} aria-hidden="true" /></Button></div>}
  </section>;
}

export function SafetyDetail({ sessionId, onBack, onAuthError }: { sessionId: string; onBack: () => void; onAuthError: (error: unknown) => void }) {
  const [view, setView] = useState<StaffSafetyView>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(false);
  // The latest submission attempt keeps its action ID so a retry of the same request is idempotent.
  const attempt = useRef<{ signalId: string; outcome: SafetyOutcome; note: string; actionId: string } | undefined>(undefined);
  const load = () => {
    setLoading(true); setError('');
    request<StaffSafetyView>(`/api/staff/safety/${encodeURIComponent(sessionId)}`)
      .then(value => { if (alive.current) setView(value); })
      .catch(e => { if (alive.current) { if (e instanceof RequestError && [401, 403].includes(e.status)) onAuthError(e); else setError(messageOf(e)); } })
      .finally(() => { if (alive.current) setLoading(false); });
  };
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [view?.sessionId]);
  const submitAction = async (signalId: string, outcome: SafetyOutcome, note: string): Promise<boolean> => {
    if (busy) return false;
    const previous = attempt.current;
    const current = previous?.signalId === signalId && previous.outcome === outcome && previous.note === note
      ? previous : { signalId, outcome, note, actionId: crypto.randomUUID() };
    attempt.current = current;
    setBusy(true); setError('');
    try {
      const next = await request<StaffSafetyView>(`/api/staff/safety/${encodeURIComponent(sessionId)}/actions`, { actionId: current.actionId, signalId, outcome, note });
      if (!alive.current) return false;
      attempt.current = undefined; setView(next);
      return true;
    } catch (e) {
      if (alive.current) { if (e instanceof RequestError && [401, 403].includes(e.status)) onAuthError(e); else setError(messageOf(e)); }
      return false;
    } finally { if (alive.current) setBusy(false); }
  };
  if (!view) return <div className="safety-detail" aria-busy={loading}>
    <Button variant="text" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Safety review list</Button>
    {loading && <p className="queue-context" role="status">Loading safety review…</p>}
    {error && <Notice tone="attention" action={<Button onClick={load} disabled={loading}><RefreshCw size={16} aria-hidden="true" />Try loading again</Button>}>{error}</Notice>}
  </div>;
  const openCount = view.reviews.filter(review => review.open).length;
  return <div className="safety-detail" aria-busy={busy}>
    <Button variant="text" onClick={onBack} disabled={busy}><ArrowLeft size={16} aria-hidden="true" />Safety review list</Button>
    {error && <Notice tone="attention">{error}</Notice>}
    <div className="handoff-header"><div><h1 ref={heading} tabIndex={-1}>{view.patientName}</h1><p>{view.scenario}</p></div><span className="status-label">{openCount} open {openCount === 1 ? 'review' : 'reviews'}</span></div>
    <section className="safety-reviews" aria-label="Safety reviews">
      {view.reviews.length === 0 && <p className="scope-note">No automated safety reviews are recorded for this conversation.</p>}
      {view.reviews.map((review, index) => <article className="safety-review" key={review.signalId} aria-labelledby={`safety-review-${review.signalId}`}>
        <div className="section-heading"><h2 id={`safety-review-${review.signalId}`}>Review {index + 1} · {review.open ? 'Open' : 'Closed'}</h2><span className="status-label">{review.status === 'needs-human-review' ? 'Needs human review' : 'Cleared by automated review'}</span></div>
        {review.reviewer === 'fail-closed' && <Notice tone="attention">Automated review did not complete. A clinician should review this message.</Notice>}
        <dl className="safety-facts">
          {review.question && <><dt>Question shown</dt><dd>{review.question}</dd></>}
          <dt>Patient message</dt><dd><p className="safety-message">{review.message ?? 'Not recorded'}</p>{review.messageAt && <span className="metadata">{dateTime(review.messageAt)}</span>}</dd>
          <dt>Flagged by screen</dt><dd>{categoryText(review.screened)}</dd>
          <dt>Reviewer level</dt><dd>{safetyLevelLabels[review.level]}{review.concern ? ' · concern' : ' · no concern'}</dd>
          <dt>Reviewer categories</dt><dd>{categoryText(review.categories)}</dd>
          <dt>Rationale</dt><dd>{review.rationale || 'None recorded'}</dd>
          <dt>Reviewer</dt><dd className="break-anywhere">{review.reviewer} · {dateTime(review.reviewedAt)}</dd>
          {review.escalated && <><dt>Model escalated</dt><dd>{review.escalated}</dd></>}
          {review.failure && <><dt>Failure reason</dt><dd>{review.failure}</dd></>}
        </dl>
        {review.open
          ? <SafetyActionForm signalId={review.signalId} disabled={busy} onSubmit={(outcome, note) => submitAction(review.signalId, outcome, note)} />
          : <p className="metadata">This review is closed.</p>}
      </article>)}
    </section>
    <section className="safety-history" aria-label="Recorded safety actions">
      <h2>Recorded actions</h2>
      {view.actions.length
        ? <ol className="safety-actions">{view.actions.map(action => {
          const reviewIndex = view.reviews.findIndex(review => review.signalId === action.signalId);
          return <li key={action.actionId}>
            <p><strong>{safetyOutcomeLabels[action.outcome]}</strong>{reviewIndex >= 0 && <span className="metadata"> · Review {reviewIndex + 1}</span>}</p>
            <p className="safety-message">{action.note}</p>
            <p className="metadata">{action.by} · {roleText(action.role)} · {dateTime(action.at)}</p>
          </li>;
        })}</ol>
        : <p className="scope-note">No actions recorded yet.</p>}
    </section>
  </div>;
}

function SafetyActionForm({ signalId, disabled, onSubmit }: { signalId: string; disabled: boolean; onSubmit: (outcome: SafetyOutcome, note: string) => Promise<boolean> }) {
  const [outcome, setOutcome] = useState<SafetyOutcome | ''>('');
  const [note, setNote] = useState('');
  const trimmed = note.trim();
  const valid = Boolean(outcome) && trimmed.length > 0 && trimmed.length <= 1000;
  return <form className="safety-action-form" onSubmit={async event => {
    event.preventDefault();
    if (!outcome || !valid || disabled) return;
    if (await onSubmit(outcome, trimmed)) { setNote(''); setOutcome(''); }
  }}>
    <h3>Record an action</h3>
    <div className="field"><label htmlFor={`safety-outcome-${signalId}`}>Outcome</label><select id={`safety-outcome-${signalId}`} required value={outcome} disabled={disabled} onChange={event => setOutcome(event.target.value as SafetyOutcome | '')}><option value="">Choose an outcome</option>{safetyOutcomes.map(value => <option key={value} value={value}>{safetyOutcomeLabels[value]}</option>)}</select></div>
    <div className="field"><label htmlFor={`safety-note-${signalId}`}>Note</label><textarea id={`safety-note-${signalId}`} rows={3} required maxLength={1000} value={note} disabled={disabled} onChange={event => setNote(event.target.value)} aria-describedby={`safety-note-help-${signalId}`} /><p className="field-hint" id={`safety-note-help-${signalId}`}>Required, up to 1000 characters. Describe what you reviewed and the next step. Record only actions that actually happened.</p></div>
    <Button variant="primary" type="submit" disabled={!valid || disabled}>Record action<Check size={17} aria-hidden="true" /></Button>
  </form>;
}
