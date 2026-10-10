import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { useAuthToken } from '@convex-dev/auth/react';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import { usePages } from './data';
import { DateTime, Field, Notice, Pages } from './components';
import { CAPTURE_LIMITS } from '../../../packages/research-capture/src/contracts';
type Scope = { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; sessionId: Id<'researchSessions'> };
type Media = FunctionReturnType<typeof api.capture.media>['page'][number];
export function CaptureSources({ scope }: { scope: Scope }) {
  const media = usePages(api.capture.media, scope);
  const gaps = usePages(api.capture.gaps, scope);
  const dom = usePages(api.capture.domBatches, scope);
  return <section className="capture-sources" aria-label="Recording sources">
    <div className="section-heading"><h3>Recordings & page activity</h3><button className="text-button" onClick={() => { void media.refresh(); void gaps.refresh(); void dom.refresh(); }}>Refresh recordings</button></div>
    <p className="muted">Recordings retain their question and source IDs. Page activity is a masked browser observation, with interruptions shown separately.</p>
    <ul className="transcript">{media.rows.map(row => <li className="source" key={row.id}><div className="source-top"><strong>{row.descriptor.modality} · {Math.round(row.descriptor.startMs / 1000)}–{Math.round(row.descriptor.endMs / 1000)} seconds</strong><span>{row.state}</span></div><p className="source-foot">Source {row.sourceId} · question {row.descriptor.questionId}</p>{row.state === 'available' && <PrivatePlayer key={row.id} scope={scope} row={row} />}</li>)}</ul><Pages {...media} />
    {!media.rows.length && !media.loading && !media.error && <p className="muted">No retained device recordings. Text sources remain above.</p>}
    <details><summary>Recording interruptions</summary><ul>{gaps.rows.map((gap, index) => <li key={index}>{gap.modality} · {Math.round(gap.atMs / 1000)} seconds · {gap.reason}</li>)}</ul><Pages {...gaps} />{!gaps.rows.length && !gaps.loading && !gaps.error && <p>No recorded interruptions.</p>}</details>
    <details><summary>Controlled page activity sources</summary>{dom.rows.map(batch => <div className="source" key={batch.sourceId}><p><strong>Source {batch.sourceId}</strong> · generation {batch.generation}</p><p className="muted">{batch.origin} · saved <DateTime value={batch.recordedAt} /></p><ol>{batch.events.map(event => <li key={event.sequence}>{Math.round(event.atMs / 1000)} seconds · {event.kind} · component {event.target} · {event.tag}</li>)}</ol></div>)}<Pages {...dom} />{!dom.rows.length && !dom.loading && !dom.error && <p>No retained page activity sources.</p>}</details>
  </section>;
}
function PrivatePlayer({ scope, row }: { scope: Scope; row: Media }) {
  const token = useAuthToken();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const object = useRef<string | null>(null);
  const player = useRef<HTMLMediaElement | null>(null);
  function clear() { active.current?.abort(); active.current = null; player.current?.pause(); if (object.current) URL.revokeObjectURL(object.current); object.current = null; setUrl(null); }
  useEffect(() => { clear(); return clear; }, [token, row.id, scope.clientId, scope.projectId, scope.sessionId]);
  async function load() {
    clear(); setLoading(true); setError(''); const controller = new AbortController(); active.current = controller;
    try {
      if (!token || row.descriptor.bytes > CAPTURE_LIMITS.segmentBytes) throw new Error('Access unavailable');
      const params = new URLSearchParams(scope);
      const response = await fetch(`/capture/media/${encodeURIComponent(row.id)}?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store', referrerPolicy: 'same-origin' });
      if (!response.ok || Number(response.headers.get('Content-Length')) !== row.descriptor.bytes) throw new Error('Source unavailable');
      const reader = response.body?.getReader(); if (!reader) throw new Error('Source unavailable');
      const parts: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > row.descriptor.bytes) throw new Error('Source exceeds its receipt'); parts.push(next.value); } } finally { await reader.cancel().catch(() => undefined); }
      if (bytes !== row.descriptor.bytes || controller.signal.aborted || active.current !== controller) throw new Error('Source incomplete');
      object.current = URL.createObjectURL(new Blob(parts as BlobPart[], { type: row.descriptor.mime })); setUrl(object.current);
    } catch { if (!controller.signal.aborted) setError('This source could not be opened. Refresh recordings to check current access.'); }
    finally { if (active.current === controller) setLoading(false); }
  }
  return <div className="private-player">{url ? <>{row.descriptor.modality === 'microphone' ? <audio ref={element => { player.current = element; }} controls src={url} preload="metadata" /> : <video ref={element => { player.current = element; }} controls src={url} preload="metadata" playsInline />}<button className="text-button" onClick={clear}>Close source</button><p className="muted">This bounded source is loaded into this tab. Closing it releases the local playback copy.</p></> : <button className="secondary" disabled={loading || !token} onClick={() => void load()}>{loading ? 'Opening private source…' : 'Open recording source'}</button>}{error && <Notice error>{error}</Notice>}</div>;
}
export function PrototypeAuthorization({ scope, studyId, prototypeUrl, active }: { scope: Omit<Scope, 'sessionId'>; studyId: Id<'researchStudies'>; prototypeUrl: string; active: boolean }) {
  const convex = useConvex();
  const [ids, setIds] = useState('');
  const [request, setRequest] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const origin = new URL(prototypeUrl).origin;
  async function authorize(components: string[]) {
    setRequest(components); setBusy(true); setError('');
    try { await convex.mutation(api.capture.authorizePrototype, { ...scope, studyId, origin, componentIds: components }); setRequest(null); setMessage('This saved study’s exact prototype origin and component IDs are authorized. Participant consent is still required.'); }
    catch { setError('Authorization result is unconfirmed. Check the original component list before changing it.'); }
    finally { setBusy(false); }
  }
  return <section className="capture-sources"><h3>Controlled prototype activity</h3><p className="muted">Authorize only a prototype you control and have instrumented. Ordinary websites can be screen shared. This study’s fixed origin is {origin}. Authorization is immutable for this saved version.</p><Field label="Instrumented component IDs" hint="Enter the application-owned opaque IDs from the prototype instrumentation, separated by commas. No selectors or page text."><input value={ids} disabled={!active || busy || !!request} onChange={event => setIds(event.target.value)} placeholder="c1, c2" /></Field><button className="secondary" disabled={!active || busy || !!request || !ids.trim()} onClick={() => { const components = ids.split(',').map(id => id.trim()); if (components.length > 64 || components.some(id => !/^c[0-9]{1,3}$/.test(id)) || new Set(components).size !== components.length) { setError('Use up to 64 distinct component IDs in the form c1, c2.'); return; } void authorize(components); }}>Authorize this prototype</button>{request && <button className="secondary" disabled={busy} onClick={() => void authorize(request)}>Check original authorization</button>}{message && <Notice>{message}</Notice>}{error && <Notice error>{error}</Notice>}</section>;
}
