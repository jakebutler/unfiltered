import { useRef, useState } from 'react';
import { Button, Header, Notice } from './components';
import { request } from './api';

export function JoinApp({ initialToken }: { initialToken?: string }) {
  const token = useRef(initialToken);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialToken ? '' : 'This invitation is invalid. Ask the clinic for a new link.');
  const started = useRef(false);
  const join = async () => {
    if (!acknowledged || !token.current || started.current) return;
    started.current = true; setBusy(true);
    const capability = token.current; token.current = undefined;
    try {
      await request('/api/clinic/invitations/redeem', { token: capability, syntheticAcknowledged: true });
      window.location.replace('/');
    } catch {
      setError('This invitation could not be confirmed. It may already have been used. Ask the clinic for a new link.');
      setBusy(false);
    }
  };
  return <><Header /><main id="main" tabIndex={-1} className="login-page"><h1>Your clinic check-in</h1><p className="lead">This is a synthetic clinic demo. Use fictional information only.</p>{error ? <Notice tone="attention">{error}</Notice> : <form onSubmit={event => { event.preventDefault(); void join(); }}><label className="acknowledgement"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy} />I understand this is a synthetic demo and will use fictional information only.</label><Button type="submit" variant="primary" disabled={!acknowledged || busy}>{busy ? 'Opening your check-in…' : 'Open check-in'}</Button></form>}</main></>;
}
