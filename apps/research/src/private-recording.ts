/** Fetch once; never publish a partial recording or retry an uncertain read. */
export async function readPrivateRecording(
  url: string,
  token: string,
  expectedBytes: number,
  controller: AbortController,
  timeoutMs = 30_000,
): Promise<Uint8Array[]> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  const timer = setTimeout(() => controller.abort(new DOMException('Recording load timed out', 'TimeoutError')), timeoutMs);
  const receive = async () => {
    controller.signal.throwIfAborted();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store', referrerPolicy: 'same-origin' });
    if (controller.signal.aborted || !response.ok || Number(response.headers.get('Content-Length')) !== expectedBytes) {
      if (response.body) void response.body.cancel().catch(() => undefined);
      controller.signal.throwIfAborted();
      throw new Error('Source unavailable');
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('Source unavailable');
    const parts: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const next = await reader.read();
      controller.signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > expectedBytes) throw new Error('Source exceeds its receipt');
      parts.push(next.value);
    }
    if (bytes !== expectedBytes) throw new Error('Source incomplete');
    return parts;
  };
  try { return await Promise.race([receive(), aborted]); }
  finally {
    clearTimeout(timer);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    // A broken transport must not keep the UI waiting for cancellation acknowledgment.
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
