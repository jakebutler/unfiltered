import { useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { errorText, isDefinitiveError, type Participant } from './state';

export function ConsentWithdrawal({ token, session, blocked, stop, onWithdrawn }: {
  token: string; session: Participant; blocked: boolean;
  stop: () => Promise<void>; onWithdrawn: (revision: number) => void;
}) {
  const convex = useConvex();
  const [reviewRevision, setReviewRevision] = useState<number | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingKey = `corvo.research.withdrawal.${session.sessionId}`;
  const [acceptedRevision, setAcceptedRevision] = useState<number | null>(() => { try { const value = sessionStorage.getItem(pendingKey); return value && /^accepted:[0-9]+$/.test(value) ? Number(value.slice(9)) : null; } catch { return null; } });
  const [unknown, setUnknown] = useState(() => { try { const value = sessionStorage.getItem(pendingKey); return value !== null && !/^accepted:[0-9]+$/.test(value); } catch { return false; } });
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const submitted = useRef(unknown || acceptedRevision !== null);
  if (!session.consent) return null;
  const stale = reviewRevision !== null && reviewRevision !== session.revision;
  async function open() {
    if (blocked || inFlight.current || submitted.current || unknown) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await stop(); setReviewRevision(session.revision); setAcknowledged(false); }
    catch { setError('Recording could not be stopped safely. No consent change was sent.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function confirm() {
    if (blocked || inFlight.current || submitted.current || unknown || !acknowledged || stale || reviewRevision === null || !session.consent) return;
    inFlight.current = true; setBusy(true); setError('');
    try { sessionStorage.setItem(pendingKey, String(reviewRevision)); }
    catch { inFlight.current = false; setBusy(false); setError('This tab could not retain a safe withdrawal receipt. No consent change was sent.'); return; }
    submitted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let accepted: number;
    try {
      const request = convex.mutation(api.capture.changeConsent, { token, expectedRevision: reviewRevision,
        consent: { ...session.consent, storage: false, analysis: false, microphone: false, camera: false, screen: false, dom: false,
          shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, shareDom: false, retainApprovedExcerpts: false } });
      accepted = await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Withdrawal acknowledgement timeout')), 30_000); })]);

    } catch (cause) {
      if (isDefinitiveError(cause)) { submitted.current = false; try { sessionStorage.removeItem(pendingKey); } catch { /* A retained marker fails closed on reload. */ } setError(errorText(cause)); }
      else { setUnknown(true); setError('Your withdrawal result is unconfirmed. It may already have been accepted. Do not submit it again; contact the study organizer to check deletion.'); }
      return;
    } finally { if (timer) clearTimeout(timer); inFlight.current = false; setBusy(false); }
    // Native commitment is independent of local notification or storage failure.
    setAcceptedRevision(accepted);
    try { sessionStorage.setItem(pendingKey, `accepted:${accepted}`); } catch { /* Keep the local positive receipt. */ }
    try { onWithdrawn(accepted); } catch { /* The component still shows the accepted native receipt. */ }
  }
  if (acceptedRevision !== null) return <section role="status"><h2>You withdrew consent</h2><p>Your withdrawal was accepted at interview revision {acceptedRevision}. Access has stopped and permanent deletion is queued. Copies already viewed or downloaded cannot be recalled.</p></section>;
  return <section className="consent-withdrawal">
    {error && <p role="alert">{error}</p>}
    {unknown && !error && <p role="alert">A withdrawal was already submitted from this tab. Its result is unconfirmed. Contact the study organizer to check deletion; do not submit it again.</p>}
    {reviewRevision === null ? <button className="secondary" disabled={blocked || busy || unknown} onClick={open}>Withdraw my consent</button> : <section className="confirmation" aria-labelledby="withdraw-consent-title">
      <h2 id="withdraw-consent-title">Withdraw consent and delete study sources?</h2>
      <p>This stops access to your saved interview answers, original sources and recordings. They will be queued for permanent deletion. Reports and shared excerpts that depend on these sources will become unavailable.</p>
      <p>Deletion cannot be undone. Copies people have already viewed or downloaded cannot be recalled. Opening this review has stopped recording; cancelling does not restart it.</p>
      {stale && <p role="alert">Your interview changed while this review was open. Cancel and review withdrawal again.</p>}
      <label className="check"><input type="checkbox" checked={acknowledged} disabled={busy || unknown || stale} onChange={event => setAcknowledged(event.target.checked)} /><span>I understand that my study sources and recordings will be permanently deleted.</span></label>
      <div className="actions"><button disabled={blocked || busy || unknown || stale || !acknowledged} onClick={confirm}>{busy ? 'Submitting withdrawal…' : 'Confirm consent withdrawal'}</button><button className="secondary" disabled={busy || unknown} onClick={() => { setReviewRevision(null); setAcknowledged(false); setError(''); }}>Keep my consent</button></div>
    </section>}
  </section>;
}
