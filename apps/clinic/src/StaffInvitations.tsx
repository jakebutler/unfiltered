import { useEffect, useRef, useState } from 'react';
import type { ScenarioId } from '../../../packages/clinic-contract/src/index';
import type { InvitationIssueView, InvitationOptionsView } from '../../../packages/clinic-contract/src/invitations';
import { Button, Notice } from './components';
import { request, RequestError } from './api';

export function StaffInvitations({ disabled, onAuthError }: { disabled: boolean; onAuthError(error: unknown): void }) {
  const [options, setOptions] = useState<InvitationOptionsView>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [scenario, setScenario] = useState<ScenarioId | ''>('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false), mounted = useRef(false);
  const [receipt, setReceipt] = useState<InvitationIssueView>();
  const [attempt, setAttempt] = useState<{ patient: string; scenario: ScenarioId; requestId: string }>();
  const [copied, setCopied] = useState(false);
  const authError = useRef(onAuthError); authError.current = onAuthError;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    request<InvitationOptionsView>('/api/clinic/staff/invitations').then(value => { if (active) setOptions(value); }).catch(error => {
      if (!active) return;
      if (error instanceof RequestError && [401, 403].includes(error.status)) authError.current(error);
      setError('Assigned patients could not be loaded for invitations.');
    });
    return () => { active = false; mounted.current = false; };
  }, []);
  const issue = async (original?: typeof attempt) => {
    if (disabled || inFlight.current || !selected || !scenario) return;
    const input = original ?? { patient: selected, scenario, requestId: crypto.randomUUID() };
    inFlight.current = true; setBusy(true); setError(''); setAttempt(input);
    try {
      const result = await request<InvitationIssueView>('/api/clinic/staff/invitations', input);
      if (!mounted.current) return;
      setReceipt(result); setAttempt(undefined);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof RequestError && [401, 403].includes(error.status)) authError.current(error);
      setError('The invitation result is unconfirmed. Check the original request before creating another link.');
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className="staff-invitations safety-queue" aria-labelledby="invitation-section-title" aria-busy={busy}><h2 id="invitation-section-title">Invite a patient</h2><p className="queue-context">Send a synthetic check-in link to an assigned patient.</p>{error && <Notice tone="attention">{error}</Notice>}{options?.patients.map(patient => <div key={patient.reference} className="queue-item"><strong>{patient.displayName}</strong><Button disabled={disabled || busy || Boolean(attempt)} onClick={() => { setSelected(patient.reference); setScenario(''); setReceipt(undefined); setCopied(false); setError(''); }}>Send check-in link</Button>{selected === patient.reference && <div className="field"><label htmlFor="invitation-workflow">Workflow</label><select id="invitation-workflow" value={scenario} disabled={disabled || busy || Boolean(attempt) || Boolean(receipt)} onChange={event => setScenario(event.target.value as ScenarioId | '')}><option value="">Choose a workflow</option>{options.workflows.filter(workflow => patient.scenarios.includes(workflow.id)).map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.title}</option>)}</select>{!receipt && <Button disabled={disabled || busy || !scenario} onClick={() => { void issue(attempt); }}>{busy ? 'Checking invitation…' : attempt ? 'Check original invitation' : 'Create check-in link'}</Button>}{receipt && <div role="status"><p>{receipt.emailStatus === 'sent' ? 'Invitation email sent.' : receipt.emailStatus === 'failed' ? 'Email delivery is unconfirmed. You can copy the link below.' : receipt.emailStatus === 'not-repeated' ? 'Invitation recorded. A replay cannot return the one-time link or send another email.' : 'Copy the link to share this synthetic invitation.'}</p><p className="metadata">Expires {new Date(receipt.expiresAt).toLocaleString()}</p>{receipt.link && <><label htmlFor="invitation-link">One-time invitation link</label><textarea id="invitation-link" value={receipt.link} readOnly rows={3} /><Button onClick={() => { void navigator.clipboard.writeText(receipt.link!).then(() => setCopied(true)).catch(() => setError('Copy was unavailable. Select and copy the link shown above.')); }}>{copied ? 'Copied' : 'Copy link'}</Button></>}</div>}</div>}</div>)}{options && !options.patients.length && <p>No patients are currently assigned for invitations.</p>}</section>;
}
