import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Participant } from './state';
import { Notice } from './components';
import { claimInterviewAutomatic, interviewRequestKey } from './interview-automatic';
export function InterviewNextStep({ token, pending, refresh }: { token: string; pending: NonNullable<Participant['pendingInterview']>; refresh: () => void }) {
  const convex = useConvex(), [working, setWorking] = useState(false), [message, setMessage] = useState('Your answer is saved. Preparing the next question…');
  const key = interviewRequestKey(pending);
  const currentKey = useRef(key); currentKey.current = key;
  useEffect(() => {
    // Written before POST: StrictMode and reload never turn an ambiguous call
    // into another automatic dispatch. Native one-call fence is authoritative.
    let claim: ReturnType<typeof claimInterviewAutomatic>;
    try { claim = claimInterviewAutomatic(pending, sessionStorage); } catch { claim = 'unavailable'; }
    if (claim !== 'claimed') { setMessage(claim === 'unavailable' ? 'Your answer is saved. Automatic follow-up is unavailable in this browser; continue with the script.' : 'Your answer is saved. The next-step result is unconfirmed; check saved state or continue with the script.'); return; }
    setWorking(true);
    void fetch('/api/research/interview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Research-Participant': token }, body: JSON.stringify(pending.scope), signal: AbortSignal.timeout(26000) })
      .then(async response => { const result = await response.json(); if (!response.ok || !['advanced', 'ready'].includes(result.state)) throw new Error('Unresolved'); if (currentKey.current === key) refresh(); })
      .catch(() => { if (currentKey.current === key) { setMessage('Your answer is saved. The next step could not be confirmed. Check saved state or continue with the script; the model call will not be repeated.'); refresh(); } })
      .finally(() => { if (currentKey.current === key) setWorking(false); });
    // StrictMode cleanup must not hide the first call's receipt. No provider retry
    // or optimistic native cancellation claim; a changed request key fences updates.
  }, [key]);
  async function continueScript() {
    setWorking(true);
    try { await convex.mutation(api.participant.continueScript, { token, expectedRevision: pending.scope.expectedRevision, requestId: crypto.randomUUID(), answerSourceId: pending.scope.answerSourceId, promptId: pending.scope.promptId }); refresh(); }
    catch { setMessage('Check the saved interview state before continuing again. Your original answer remains saved.'); refresh(); }
    finally { setWorking(false); }
  }
  return <section aria-label="Saved answer and next question"><Notice>{working ? 'Your answer is saved. Preparing the next question…' : message}</Notice><div className="actions"><button className="secondary" onClick={refresh}>Check saved state</button><button disabled={working} onClick={() => void continueScript()}>Continue with script</button></div></section>;
}
