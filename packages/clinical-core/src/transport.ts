export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export class TransportError extends Error {
  constructor(public readonly code: 'timeout' | 'network' | 'http' | 'invalid-json' | 'response-too-large', public readonly status?: number) { super(code); this.name = 'TransportError'; }
}
export interface HttpResult { status: number; body: unknown; }
/** One portable native-fetch boundary. No logging, retry, redirects, or provider error-body exposure. */
export async function requestJson(fetcher: Fetch, url: string, init: RequestInit, timeoutMs: number, maxResponseBytes = 2_000_000): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, redirect: 'error' });
    const reader = response.body?.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxResponseBytes) throw new TransportError('response-too-large');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
    }
    if (!response.ok) throw new TransportError('http', response.status);
    if (!length) return { status: response.status, body: undefined };
    const bytes = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    try { return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) }; }
    catch { throw new TransportError('invalid-json'); }
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError(controller.signal.aborted ? 'timeout' : 'network');
  } finally { clearTimeout(timer); }
}
