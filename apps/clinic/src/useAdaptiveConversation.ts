import { useEffect, useRef, useState } from 'react';
import type { AdaptiveOperationView, AdaptiveTurnResult, ClinicSessionView } from '../../../packages/clinic-contract/src/index';
import { request, RequestError } from './api';
import { AdaptiveResponseGuard, answerBlockedByInterpretation, canQueueNextSource, isPendingInterpretation } from './adaptive-state';

export function useAdaptiveConversation({ session, getSession, onSession, onOperation }: {
  session?: ClinicSessionView; getSession: () => ClinicSessionView | undefined; onSession: (session: ClinicSessionView) => void;
  onOperation?: (result: AdaptiveTurnResult) => void;
}) {
  const guard = useRef(new AdaptiveResponseGuard());
  const [interpreting, setInterpreting] = useState<string>();
  const [uncertain, setUncertain] = useState<string>();
  const [message, setMessage] = useState('');
  const [slow, setSlow] = useState(false);
  const operation = session?.adaptive?.operation;
  const working = Boolean(operation && (interpreting === operation.id || operation.status === 'processing'));

  useEffect(() => {
    setSlow(false);
    if (!working) return;
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [working, operation?.id]);
  useEffect(() => () => guard.current.invalidate(), []);

  // Status reads can reveal a durably saved question before the same POST has
  // finished capture. They cannot dispatch inference or replace a newer scope.
  useEffect(() => {
    if (!operation || !(operation.status === 'processing' || operation.queuedWaiting || interpreting === operation.id)) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const current = getSession(); if (!current) return;
    const ticket = guard.current.ticket(current, operation.id);
    const poll = async () => {
      try {
        const result = await request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${encodeURIComponent(operation.id)}`);
        if (stopped || !guard.current.accepts(ticket, getSession(), result)) return;
        onSession(result.session);
        onOperation?.(result);
        if (!isPendingInterpretation(result.operation)) { setUncertain(undefined); setInterpreting(undefined); return; }
        if (result.operation.queuedAfter && !result.operation.queuedWaiting && result.operation.status === 'accepted') void interpret(result.operation);
      } catch { /* A lost status read does not retry inference or erase words. */ }
      if (!stopped) timer = setTimeout(() => void poll(), 500);
    };
    timer = setTimeout(() => void poll(), 250);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [operation?.id, operation?.status, operation?.queuedWaiting, interpreting, getSession, onSession]);

  const invalidate = () => {
    guard.current.invalidate(); setInterpreting(undefined); setUncertain(undefined); setMessage('');
  };
  const interpret = async (savedOperation: AdaptiveOperationView) => {
    const current = getSession();
    if (!current || current.adaptive?.operation?.id !== savedOperation.id || !guard.current.claimInterpretation(savedOperation)) return;
    const ticket = guard.current.ticket(current, savedOperation.id);
    setInterpreting(savedOperation.id); setUncertain(undefined); setMessage('');
    try {
      const result = await request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${encodeURIComponent(savedOperation.id)}/interpret`, {});
      if (!guard.current.accepts(ticket, getSession(), result)) return;
      onSession(result.session);
      onOperation?.(result);
      return result;
    } catch (e) {
      if (!guard.current.isCurrent(ticket, getSession())) return;
      setUncertain(savedOperation.id);
      setMessage('Your message is saved, but we couldn’t confirm it was read. Check its status, or switch to set questions.');
    } finally {
      if (guard.current.isCurrent(ticket, getSession())) setInterpreting(undefined);
    }
  };
  const checkStatus = async () => {
    const current = getSession(), op = current?.adaptive?.operation;
    if (!current || !op) return;
    const ticket = guard.current.ticket(current, op.id);
    const result = await request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${encodeURIComponent(op.id)}`);
    if (!guard.current.accepts(ticket, getSession(), result)) {
      const displayed = getSession();
      if (guard.current.isCurrent(ticket, displayed) && result.session.revision >= displayed!.revision
        && result.session.adaptive?.operation?.id !== op.id) {
        throw new RequestError('The saved conversation changed elsewhere. Reload saved answers before continuing. Your unsent text is still here.', 409, 'conversation-changed', false);
      }
      return;
    }
    onSession(result.session); onOperation?.(result); setMessage('');
    if (!isPendingInterpretation(result.operation)) { setUncertain(undefined); setInterpreting(undefined); }
  };
  const discardPending = async (): Promise<ClinicSessionView | undefined> => {
    const current = getSession(), op = current?.adaptive?.operation;
    invalidate();
    if (!current || !op || !isPendingInterpretation(op)) return current;
    // Processing claims can advance the revision without a browser response. Read it before discarding.
    const ticket = guard.current.ticket(current, op.id);
    const fresh = await request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${encodeURIComponent(op.id)}`);
    if (!guard.current.accepts(ticket, getSession(), fresh)) throw new RequestError('The saved conversation changed. Reload saved answers before continuing.', 409, 'conversation-changed', false);
    onSession(fresh.session);
    if (!isPendingInterpretation(fresh.operation)) return fresh.session;
    try {
      const result = await request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${encodeURIComponent(op.id)}/discard`, { expectedRevision: fresh.session.revision });
      if (!guard.current.accepts(ticket, getSession(), result)) throw new RequestError('The saved conversation changed. Reload saved answers before continuing.', 409, 'conversation-changed', false);
      onSession(result.session); return result.session;
    } catch (e) {
      // Reconcile a racing result once; this GET cannot dispatch another interpretation.
      if (e instanceof RequestError && e.status === 409) {
        const result = await request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${encodeURIComponent(op.id)}`);
        if (guard.current.accepts(ticket, getSession(), result)) {
          onSession(result.session);
          if (!isPendingInterpretation(result.operation)) return result.session;
        }
      }
      setMessage('We couldn’t confirm that stopping worked. Your message is still saved. Check its status before continuing.');
      throw e;
    }
  };
  return {
    operation, working, slow, message,
    uncertain: Boolean(operation && uncertain === operation.id),
    pending: isPendingInterpretation(operation),
    answerBlocked: answerBlockedByInterpretation(operation),
    canQueueNextSource: canQueueNextSource(operation),
    canInterpret: Boolean(operation?.status === 'accepted' && !operation.queuedWaiting && !guard.current.hasAttempted(operation.id) && !working),
    interpret, checkStatus, discardPending, invalidate,
  };
}
