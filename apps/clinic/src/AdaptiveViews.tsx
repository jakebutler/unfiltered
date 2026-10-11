import { useEffect, useRef, useState } from 'react';
import { Check, MessageSquare, RefreshCw } from 'lucide-react';
import type { AdaptiveOperationView, ClinicSessionView, SourceTurn } from '../../../packages/clinic-contract/src/index';
import { Button, dateTime, Notice, patientAnswerLabels, detailDisplayText, time } from './components';
import { isPendingInterpretation } from './adaptive-state';

const speechNote = (turn: SourceTurn) => turn.channel === 'unreviewed-transcript' ? ' · Speech-to-text, not checked' : turn.channel === 'confirmed-transcript' ? ' · Spoken, checked by you' : '';

/** Shown only when the patient has something to decide: a slow, idle, uncertain or incomplete reading of their message.
 * A normal in-progress reading is shown as a typing indicator in the conversation instead. */
export function AdaptiveStatus({ operation, working, slow, uncertain, message, canInterpret, busy, hasDraft, onCheck, onInterpret, onStop, onGuided }: {
  operation: AdaptiveOperationView; working: boolean; slow: boolean; uncertain: boolean; message: string; canInterpret: boolean; busy: boolean; hasDraft: boolean;
  onCheck: () => void; onInterpret: () => void; onStop: () => void; onGuided: () => void;
}) {
  const pending = isPendingInterpretation(operation);
  const failed = operation.status === 'failed' || operation.status === 'unresolved';
  const terminalGap = failed || operation.status === 'discarded' || Boolean(operation.hasUnresolvedInterpretation);
  if (!pending && !terminalGap && !uncertain) return null;
  // Still reading within the expected time, or waiting behind the previous message: the typing indicator covers it.
  if (pending && !uncertain && !message && ((working && !slow) || (!working && operation.queuedWaiting))) return null;
  const idle = pending && !working;
  const description = message || (working && !uncertain ? 'This is taking longer than usual. Your message is saved, so nothing is lost if you stop.'
    : idle && canInterpret && !uncertain ? 'Your last message is saved but hasn’t been read yet.'
      : pending || uncertain ? 'Your message is saved, but we couldn’t confirm it was read.'
        : operation.status === 'discarded' ? 'Stopped. Your message is saved as you wrote it. Anything it didn’t cover stays open for later.'
          : 'Some of your last message couldn’t be turned into answers. It’s saved as you wrote it, and you can add what’s missing now or at review.');
  const showCheck = uncertain || (idle && !canInterpret);
  return <Notice tone={uncertain || failed || (idle && !canInterpret) ? 'attention' : 'info'}><p>{description}</p><div className="adaptive-status-actions">
    {canInterpret && !uncertain && <Button onClick={onInterpret} disabled={busy}>Continue</Button>}
    {showCheck && <Button onClick={onCheck} disabled={busy}><RefreshCw size={15} aria-hidden="true" />Check status</Button>}
    {pending && <Button onClick={onStop} disabled={busy}>Stop and keep my message as written</Button>}
    <Button variant="text" onClick={onGuided} disabled={busy || hasDraft}>{pending ? 'Stop and switch to set questions' : 'Switch to set questions'}</Button>
  </div></Notice>;
}

/** The conversation so far as chat bubbles. Older messages fold away so the current question stays in view. */
export function ChatTranscript({ turns, recent = 4 }: { turns: SourceTurn[]; recent?: number }) {
  const [showEarlier, setShowEarlier] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const revealed = useRef(false);
  useEffect(() => {
    if (showEarlier && !revealed.current) { revealed.current = true; listRef.current?.focus({ preventScroll: true }); }
  }, [showEarlier]);
  if (!turns.length) return null;
  const hidden = showEarlier || turns.length <= recent + 2 ? 0 : turns.length - recent;
  return <section className="chat-transcript" aria-label="Conversation so far">
    {hidden > 0 && <Button variant="text" className="chat-earlier" onClick={() => setShowEarlier(true)}><MessageSquare size={15} aria-hidden="true" />Show {hidden} earlier message{hidden === 1 ? '' : 's'}</Button>}
    <ol ref={listRef} tabIndex={-1} className="chat-list">{turns.slice(hidden).map(turn => <li key={turn.id} className={`chat-bubble chat-bubble--${turn.role}`}>
      <span className="sr-only">{turn.role === 'patient' ? 'You' : 'Corvo Clinic'}: </span><p>{turn.text}</p>
      {turn.role === 'patient' && <p className="chat-meta">{time(turn.at)}{turn.corrects && ' · Correction'}{speechNote(turn)}</p>}
    </li>)}</ol>
  </section>;
}

/** Live region for the assistant's activity: typing indicator, its latest reply, and a short spoken summary of captured details. */
export function AssistantActivity({ thinking, updating, reply, added }: { thinking: boolean; updating: boolean; reply?: { id: string; text: string }; added: number }) {
  return <div className="chat-live" aria-live="polite">
    {thinking && <div className="chat-bubble chat-bubble--assistant chat-typing"><span className="typing-dots" aria-hidden="true"><span /><span /><span /></span><span className="sr-only">Corvo Clinic is reading your message…</span></div>}
    {added > 0 && <span className="sr-only">Added {added} detail{added === 1 ? '' : 's'} to your answers.</span>}
    {reply && <p className="chat-bubble chat-bubble--assistant adaptive-reply" key={reply.id}><span className="sr-only">Corvo Clinic: </span>{reply.text}</p>}
    {updating && <p className="chat-updating">Adding this to your answers…</p>}
  </div>;
}

export function AdaptiveReadback({ session, disabled, onChange }: { session: ClinicSessionView; disabled: boolean; onChange: (topicId: string, path: string) => void }) {
  const operation = session.adaptive?.operation;
  if (operation?.status !== 'applied' || !operation.updates?.length) return null;
  const details = operation.updates.flatMap(update => {
    const topic = session.topics.find(item => item.id === update.topicId);
    const detail = topic?.details?.find(item => item.id === update.path);
    return topic && detail ? [{ topic, detail }] : [];
  });
  const severalTopics = new Set(details.map(({ topic }) => topic.id)).size > 1;
  return <section className="adaptive-readback" aria-labelledby="adaptive-readback-title">
    <p className="adaptive-readback-title" id="adaptive-readback-title"><Check size={15} aria-hidden="true" />Added to your answers <span>from your message</span></p>
    <dl>{details.map(({ topic, detail }) => <div key={`${topic.id}:${detail.id}`}><dt>{detail.label}{severalTopics ? <span className="readback-topic"> · {topic.title}</span> : <span className="sr-only"> · {topic.title}</span>}</dt><dd><span>{detailDisplayText(detail) || patientAnswerLabels[detail.state]}</span>{detail.editable !== false && <Button variant="text" disabled={disabled} onClick={() => onChange(topic.id, detail.id)}>Change<span className="sr-only"> {detail.label}</span></Button>}</dd></div>)}</dl>
    {details.length !== operation.updates.length && <p>Other details were updated too. You’ll see them all at review.</p>}
  </section>;
}

/** Messages whose words were saved but not fully turned into answers. Compact in the conversation, open at review. */
export function UnresolvedSources({ session, expanded = false }: { session: ClinicSessionView; expanded?: boolean }) {
  const ids = new Set(session.adaptive?.unresolvedSources?.map(source => source.sourceId) ?? []);
  const operation = session.adaptive?.operation;
  const pending = isPendingInterpretation(operation);
  // While a message is still being read, the conversation shows it as a chat bubble instead.
  if (!expanded && pending) return null;
  if (operation && (['accepted', 'processing', 'failed', 'unresolved', 'discarded'].includes(operation.status) || operation.hasUnresolvedInterpretation)) ids.add(operation.sourceId);
  if (!ids.size) return null;
  const explanation = 'They’re saved as you wrote them and will be sent with your answers. Anything they didn’t cover stays open, and you can add it now or at review.';
  const list = [...ids].map(id => {
    const source = session.turns.find(turn => turn.id === id);
    return <article className="source-turn" key={id}>{source ? <><p className="metadata">Your message · {dateTime(source.at)}{speechNote(source)}</p><blockquote>{source.text}</blockquote></> : <Notice tone="attention">This message isn’t available here. Anything it covered stays open.</Notice>}</article>;
  });
  if (!expanded) return <details className="unresolved-sources unresolved-sources--compact"><summary>{ids.size === 1 ? 'One of your messages still needs a closer look' : `${ids.size} of your messages still need a closer look`}</summary><p>{explanation}</p>{list}</details>;
  return <section className="unresolved-sources"><h2>Some of your words still need a closer look</h2><p>{explanation}</p><details open>
    <summary>Show {ids.size} message{ids.size === 1 ? '' : 's'}</summary>{list}
  </details></section>;
}
