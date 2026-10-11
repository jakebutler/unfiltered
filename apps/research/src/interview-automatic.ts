import type { Participant } from './state';
type Pending = NonNullable<Participant['pendingInterview']>;
export function interviewRequestKey(pending: Pending) {
  return `corvo.research.interview.${pending.scope.sessionId}.${pending.scope.requestId}`;
}
/** Browser claim is only a conservative replay guard. Native admission is authority. */
export function claimInterviewAutomatic(pending: Pending, storage: Pick<Storage, 'getItem' | 'setItem'>): 'claimed' | 'unconfirmed' | 'unavailable' {
  if (!pending.automaticAllowed) return 'unconfirmed';
  try {
    const key = interviewRequestKey(pending);
    if (storage.getItem(key)) return 'unconfirmed';
    storage.setItem(key, 'started');
    return 'claimed';
  } catch { return 'unavailable'; }
}
