import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { z } from 'zod';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { errorText, isDefinitiveError, type Study } from './state';

type Scope = { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'> };
const intentSchema = z.object({ clientId: z.string(), projectId: z.string(), expectedRevision: z.number().int().nonnegative(), expectedVersion: z.number().int().positive(), sourceVersion: z.number().int().positive(), acceptedVersion: z.number().int().positive().optional() }).strict();
type Intent = z.infer<typeof intentSchema>;
function read(key: string, scope: Scope): Intent | null {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return null;
  if (raw.length > 4096) throw new Error('Stored run cannot be checked');
  const value = intentSchema.parse(JSON.parse(raw));
  if (value.clientId !== scope.clientId || value.projectId !== scope.projectId || value.acceptedVersion !== undefined && value.acceptedVersion !== value.expectedVersion) throw new Error('Stored run cannot be checked');
  return value;
}

export function NewInterviewRun({ scope, sourceVersion, definition, project, active, allowNavigation, onSaved, onPending }: {
  scope: Scope; sourceVersion: number; definition: Study; project: { revision: number; latestStudyVersion: number }; active: boolean;
  allowNavigation: () => boolean; onSaved: (version: number) => void; onPending: (pending: boolean) => void;
}) {
  const convex = useConvex(), key = `corvo.research.new-run.v1.${scope.projectId}`;
  const [retained, setRetained] = useState<{ intent: Intent | null; unreadable: boolean }>(() => { try { return { intent: read(key, scope), unreadable: false }; } catch { return { intent: null, unreadable: true }; } });
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [checkedVersion, setCheckedVersion] = useState<number | null>(null);
  const inFlight = useRef(false), alive = useRef(true);
  const held = busy || retained.unreadable || !!retained.intent;
  useEffect(() => { onPending(held); }, [held, onPending]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; onPending(false); }; }, [onPending]);

  function select(version: number) {
    try { onSaved(version); }
    catch { setError('The saved version is confirmed, but this tab could not open it. Open it from the saved-version list.'); return; }
    try { sessionStorage.removeItem(key); }
    catch { setError('The saved run is confirmed, but this tab could not clear its saved check. Reopen this project before another run.'); return; }
    setRetained({ intent: null, unreadable: false }); setCheckedVersion(null); setConfirming(false);
  }
  async function start() {
    if (!active || held || inFlight.current || !confirming) return;
    const original: Intent = { ...scope, expectedRevision: project.revision, expectedVersion: project.latestStudyVersion + 1, sourceVersion };
    const frozen = JSON.parse(JSON.stringify(definition)) as Study;
    try { if (read(key, scope)) throw new Error('Earlier run pending'); sessionStorage.setItem(key, JSON.stringify(original)); }
    catch { setError('This tab could not retain the unfinished run safely. No new run was sent. Reopen the project and check its latest saved version.'); return; }
    inFlight.current = true; setRetained({ intent: original, unreadable: false }); setBusy(true); setError(''); setMessage(''); setConfirming(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = convex.mutation(api.research.saveStudy, { ...scope, expectedRevision: original.expectedRevision, definition: frozen }).then(result => {
      if (result.version !== original.expectedVersion || result.projectRevision !== original.expectedRevision + 1 || !result.studyId) throw new Error('Unconfirmed saved run');
      // A late acknowledgement may belong to a remounted control. Never overwrite a later attempt.
      try { const current = read(key, scope); if (current?.expectedRevision === original.expectedRevision && current.expectedVersion === original.expectedVersion) sessionStorage.setItem(key, JSON.stringify({ ...original, acceptedVersion: result.version })); } catch { /* The original marker still blocks a repeat. */ }
      return result;
    });
    try {
      const result = await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Run save unconfirmed')), 30_000); })]);
      if (alive.current) { setRetained({ intent: { ...original, acceptedVersion: result.version }, unreadable: false }); setMessage(`New interview run saved as version ${result.version}. Create new invitations and authorize its prototype before recording.`); select(result.version); }
    } catch (cause) {
      if (isDefinitiveError(cause)) { try { sessionStorage.removeItem(key); if (alive.current) setRetained({ intent: null, unreadable: false }); } catch { /* Retain the original marker. */ } }
      if (alive.current) setError(errorText(cause));
    } finally { if (timer) clearTimeout(timer); inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function check() {
    if (busy || inFlight.current || retained.unreadable) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const original = read(key, scope); if (!original) throw new Error('No retained run');
      if (original.acceptedVersion !== undefined) { setRetained({ intent: original, unreadable: false }); setMessage(`New interview run saved as version ${original.acceptedVersion}. Create new invitations and authorize its prototype before recording.`); return; }
      const current = await convex.query(api.research.project, scope);
      if (current.project._id !== scope.projectId || current.client._id !== scope.clientId || current.project.revision <= original.expectedRevision || current.project.latestStudyVersion < original.expectedVersion - 1) throw new Error('Original run remains unconfirmed');
      // Every project write advances the CAS. This proves the old save cannot create a later version;
      // it does not identify which writer saved any identical definition.
      setCheckedVersion(current.project.latestStudyVersion); setMessage('The project has changed. Review its latest saved version before starting another run. The earlier save’s outcome remains unconfirmed and it will not be repeated.');
    } catch { setError('The unfinished run cannot be confirmed yet. Keep it here and check again; no other run has been requested.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <section aria-label="New interview run">
    <button type="button" className="secondary" disabled={!active || held || confirming} onClick={() => { if (allowNavigation()) { setConfirming(true); setError(''); setMessage(''); } }}>Start a new interview run</button>
    {confirming && <div className="confirmation"><p>Save an unchanged copy of version {sourceVersion} as a new run. Existing invitations, results and used allowances stay with their original run. Create new invitations for this run and authorize its controlled prototype before recording.</p><button type="button" disabled={!active || held} onClick={() => void start()}>Create new run</button><button type="button" className="text-button" onClick={() => setConfirming(false)}>Keep current run</button></div>}
    {retained.intent?.acceptedVersion !== undefined ? <button type="button" disabled={busy} onClick={() => select(retained.intent!.acceptedVersion!)}>Open new run</button> : retained.intent && <button type="button" disabled={busy} onClick={() => void check()}>{busy ? 'Checking saved run…' : 'Check unfinished run'}</button>}
    {checkedVersion !== null && <button type="button" disabled={busy} onClick={() => select(checkedVersion)}>Review latest saved version</button>}
    {busy && <p role="status">Saving or checking this run…</p>}
    {retained.unreadable && <p role="alert">This tab’s unfinished run could not be read safely. Contact the study organizer before starting another run.</p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
