export interface InvitationLocation { pathname: string; search: string; hash: string; }
export interface InvitationHistory { state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void; }

/** Capture once and remove the capability before the first async operation. */
export function takeInvitationToken(location: InvitationLocation, history: InvitationHistory): string | undefined {
  const fragment = location.hash, query = location.search, pathname = location.pathname;
  // A join URL never retains query text or any fragment, including malformed inputs.
  history.replaceState(history.state, '', pathname);
  if (query || pathname !== '/join' || !/^#token=[a-f0-9]{64}$/.test(fragment)) return undefined;
  return fragment.slice('#token='.length);
}

export async function redeemJoinInvitation<T>(location: InvitationLocation, history: InvitationHistory, redeem: (token: string) => Promise<T>): Promise<T> {
  const token = takeInvitationToken(location, history);
  if (!token) throw new Error('invitation-invalid');
  // No persistence or automatic retry: a lost response can mean the link was consumed.
  return redeem(token);
}
