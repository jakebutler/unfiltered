import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { clearSessionItem, errorText, isDefinitiveError, type Participant } from './state';
type Consent = NonNullable<Participant['consent']>;
type Intent = { expectedRevision: number; consent: Consent };
const required = ['storage', 'analysis', 'microphone', 'camera', 'screen', 'shareTranscript', 'shareAudio', 'shareCamera', 'shareScreen', 'retainApprovedExcerpts'];
function readIntent(key: string): Intent | 'unreadable' | null {
  try {
    const text = sessionStorage.getItem(key); if (text === null) return null;
    if (text.length > 4096) return 'unreadable';
    const value = JSON.parse(text), consent = value?.consent;
    if (!Number.isSafeInteger(value?.expectedRevision) || value.expectedRevision < 0 || !consent || consent.version !== 'research-consent-1'
      || required.some(key => typeof consent[key] !== 'boolean') || Object.keys(consent).some(key => !['version', ...required, 'dom', 'shareDom'].includes(key))
      || ['dom', 'shareDom'].some(key => key in consent && typeof consent[key] !== 'boolean')) return 'unreadable';
    return value;
  } catch { return 'unreadable'; }
}
function sameConsent(a: Consent | null, b: Consent) {
  return !!a && [...new Set([...Object.keys(a), ...Object.keys(b)])].every(key => a[key as keyof Consent] === b[key as keyof Consent]);
}
export function ConsentSharing({ token, session, blocked, refresh, onPending }: {
  token: string; session: Participant; blocked: boolean; refresh: () => void; onPending: (pending: boolean) => void;
}) {
  const convex = useConvex(), key = `corvo.research.sharing.${session.sessionId}`;
  const [pending, setPending] = useState<Intent | 'unreadable' | null>(() => readIntent(key));
  const [choice, setChoice] = useState<{ revision: number; value: boolean } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const [acceptedRevision, setAcceptedRevision] = useState<number | null>(null);
  const inFlight = useRef(false), submitted = useRef(!!pending), acceptedFloor = useRef<number | null>(null);
  const awaitingRefresh = acceptedRevision !== null && session.revision < acceptedRevision;
  useEffect(() => { onPending(busy || !!pending || awaitingRefresh); }, [busy, pending, awaitingRefresh, onPending]);
  if (!session.consent?.storage || !session.consent.analysis) return null;
  const stale = !!choice && choice.revision !== session.revision;
  const locked = blocked || busy || !!pending || awaitingRefresh;
  function accepted(revision: number) {
    acceptedFloor.current = revision; setAcceptedRevision(revision); setPending(null); submitted.current = false; clearSessionItem(key); setChoice(null); setError('');
    setSaved(`Transcript sharing choice saved at interview revision ${revision}.`);
    try { refresh(); } catch { /* Native acknowledgement is independent of rendering. */ }
  }
  async function save() {
    if (locked || stale || inFlight.current || submitted.current || acceptedFloor.current !== null && session.revision < acceptedFloor.current || !choice || choice.value === session.consent!.shareTranscript) return;
    const intent: Intent = { expectedRevision: choice.revision, consent: { ...session.consent!, shareTranscript: choice.value } };
    try { sessionStorage.setItem(key, JSON.stringify(intent)); }
    catch { setError('This tab could not retain the sharing choice safely. No change was sent.'); return; }
    inFlight.current = true; submitted.current = true; setPending(intent); setBusy(true); setError(''); setSaved('');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = convex.mutation(api.capture.changeConsent, { token, ...intent });
      const revision = await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sharing acknowledgement timeout')), 30_000); })]);
      if (revision !== intent.expectedRevision + 1) throw new Error('Sharing acknowledgement unavailable');
      accepted(revision);
    } catch (cause) {
      if (isDefinitiveError(cause)) { clearSessionItem(key); setPending(null); submitted.current = false; setError(errorText(cause)); try { refresh(); } catch { /* Preserve rejection. */ } }
      else setError('Your sharing change is unconfirmed. Check the saved choice below; do not submit it again.');
    } finally { if (timer) clearTimeout(timer); inFlight.current = false; setBusy(false); }
  }
  async function check() {
    if (busy || inFlight.current || !pending) return;
    if (pending === 'unreadable') { setError('This tab has an unreadable pending sharing choice. Contact the study organizer; no change will be resubmitted.'); return; }
    const original = pending; inFlight.current = true; setBusy(true); setError('');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const current = await Promise.race([convex.query(api.participant.resume, { token }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sharing readback timeout')), 10_000); })]);
      if (current.sessionId === session.sessionId && current.revision === original.expectedRevision + 1 && sameConsent(current.consent, original.consent)) accepted(current.revision);
      else { setError('The original sharing change cannot be confirmed from the saved interview. Contact the study organizer; it will not be resubmitted.'); try { refresh(); } catch { /* Retain original intent. */ } }
    } catch { setError('The saved sharing choice could not be checked. The original change remains unconfirmed.'); }
    finally { if (timer) clearTimeout(timer); inFlight.current = false; setBusy(false); }
  }
  return <section aria-label="Transcript sharing choice">
    <p>Permit this study’s answers to be deliberately published as client excerpts or selected sources for viewing and download. Device recording and audio sharing stay under their existing choices. Removing permission stops future access; copies already viewed or downloaded cannot be recalled.</p>
    <label className="check"><input type="checkbox" checked={choice?.value ?? session.consent.shareTranscript} disabled={locked} onChange={event => { setChoice({ revision: session.revision, value: event.target.checked }); setSaved(''); }} /><span>Allow transcript sharing with the client</span></label>
    {stale && <p role="alert">Your interview changed. Review the current sharing choice again before saving.</p>}
    <div className="actions"><button className="secondary" disabled={locked || stale || !choice || choice.value === session.consent.shareTranscript} onClick={save}>{busy ? 'Saving sharing choice…' : 'Save transcript sharing choice'}</button>{stale && !pending && <button className="text-button" disabled={busy} onClick={() => { setChoice(null); setError(''); }}>Review current sharing choice</button>}{pending && <button className="secondary" disabled={busy} onClick={check}>Check saved sharing choice</button>}</div>
    {saved && <p role="status">{saved}</p>}{pending && !error && <p role="status">A sharing change is pending or unconfirmed. Check the saved choice before continuing.</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
