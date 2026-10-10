/** Only an explicit refused local TCP connection proves the listener absent.
 * A reachable, reset, timed-out or malformed service is never an owned process. */
export async function requireFreeListener(probe: () => Promise<Response>): Promise<void> {
  let response: Response;
  try { response = await probe(); }
  catch (error) {
    if (error instanceof TypeError && (error as TypeError & { cause?: { code?: unknown } }).cause?.code === 'ECONNREFUSED') return;
    throw error;
  }
  void response.body?.cancel().catch(() => undefined);
  throw new Error('Gateway listener already occupied');
}
