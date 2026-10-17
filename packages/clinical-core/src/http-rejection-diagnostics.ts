import type { Fetch } from './transport.js';

export const rejectionDiagnosticBounds = { maxBytes: 8192, maxReadMs: 150 } as const;
const codes = [
  'bad_request', 'unauthorized', 'forbidden', 'not_found', 'too_many_requests',
  'internal_server_error', 'service_unavailable', 'invalid_request_error',
  'invalid_json_schema', 'unsupported_parameter', 'invalid_parameter',
  'authentication_error', 'rate_limit_exceeded', 'insufficient_quota',
  'model_not_found', 'context_length_exceeded',
] as const;
const types = [
  'invalid_request_error', 'authentication_error', 'rate_limit_error', 'server_error',
  'content_filter',
] as const;
const params = [
  'model', 'messages', 'max_tokens', 'stream', 'stream_options',
  'stream_options.include_usage', 'response_format', 'response_format.type',
  'response_format.json_schema', 'response_format.json_schema.name',
  'response_format.json_schema.strict', 'response_format.json_schema.schema',
] as const;

export interface HttpRejectionDiagnostic {
  status: number;
  bodyRead: 'pending' | 'complete' | 'capped' | 'timed-out' | 'cancelled' | 'unreadable' | 'no-body';
  bytesCaptured: number;
  parse: 'not-attempted' | 'json' | 'invalid-json' | 'invalid-utf8' | 'non-object';
  errorId?: typeof codes[number];
  errorCode?: typeof codes[number];
  errorType?: typeof types[number];
  errorParam?: typeof params[number];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function allowed<T extends string>(value: unknown, list: readonly T[]): T | undefined {
  return typeof value === 'string' && list.includes(value as T) ? value as T : undefined;
}
function cancelUnclaimedBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
function parseComplete(bytes: Uint8Array, diagnostic: HttpRejectionDiagnostic): void {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { diagnostic.parse = 'invalid-utf8'; return; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { diagnostic.parse = 'invalid-json'; return; }
  const root = object(parsed);
  if (!root) { diagnostic.parse = 'non-object'; return; }
  diagnostic.parse = 'json';
  const error = object(root.error);
  // Exact finite tokens only. Never retain free-form message, request ID, reason
  // text, headers, URLs or an arbitrary string that merely looks like a code.
  const id = allowed(root.id, codes), code = allowed(error?.code, codes);
  const type = allowed(error?.type, types), param = allowed(error?.param, params);
  if (id) diagnostic.errorId = id;
  if (code) diagnostic.errorCode = code;
  if (type) diagnostic.errorType = type;
  if (param) diagnostic.errorParam = param;
}

async function readRejectedBody(
  response: Response, diagnostic: HttpRejectionDiagnostic,
  signal: AbortSignal | null | undefined, deadlineMs: number,
): Promise<void> {
  if (!response.body) { diagnostic.bodyRead = 'no-body'; return; }
  if (signal?.aborted) {
    diagnostic.bodyRead = 'cancelled'; cancelUnclaimedBody(response); return;
  }
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    diagnostic.bodyRead = 'timed-out'; cancelUnclaimedBody(response); return;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  const captured = new Uint8Array(rejectionDiagnosticBounds.maxBytes);
  type Stop = { stopped: 'timed-out' | 'cancelled' };
  const stop = new Promise<Stop>(resolve => {
    timer = setTimeout(() => resolve({ stopped: 'timed-out' }),
      Math.min(rejectionDiagnosticBounds.maxReadMs, remaining));
    const cancel = () => resolve({ stopped: 'cancelled' });
    signal?.addEventListener('abort', cancel, { once: true });
    removeAbort = () => signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) cancel();
  });
  try {
    reader = response.body.getReader();
    for (;;) {
      const next = await Promise.race([reader.read(), stop]);
      if ('stopped' in next) { diagnostic.bodyRead = next.stopped; return; }
      if (next.done) {
        diagnostic.bodyRead = 'complete';
        parseComplete(captured.subarray(0, diagnostic.bytesCaptured), diagnostic);
        return;
      }
      const count = Math.min(next.value.byteLength,
        rejectionDiagnosticBounds.maxBytes - diagnostic.bytesCaptured);
      captured.set(next.value.subarray(0, count), diagnostic.bytesCaptured);
      diagnostic.bytesCaptured += count;
      // Do not read another chunk or parse a possibly truncated prefix.
      if (diagnostic.bytesCaptured === rejectionDiagnosticBounds.maxBytes) {
        diagnostic.bodyRead = 'capped'; return;
      }
    }
  } catch { diagnostic.bodyRead = signal?.aborted ? 'cancelled' : 'unreadable'; }
  finally {
    if (timer) clearTimeout(timer);
    removeAbort();
    // A hostile cancel acknowledgement must not extend the original deadline.
    void reader?.cancel().catch(() => undefined);
    try { reader?.releaseLock(); } catch { /* diagnostic failure is already bounded */ }
    captured.fill(0);
  }
}

/** Isolated qualification wrapper, never mounted by a provider factory. The
 * supplied absolute deadline may only shorten the unchanged adapter deadline.
 * Success is the original Response object; rejection is the same numeric status
 * with an empty body. There is exactly one underlying fetch and no observer. */
export function diagnosticFetch(fetcher: Fetch, deadlineMs: number): {
  fetcher: Fetch; snapshot: () => HttpRejectionDiagnostic | undefined;
} {
  if (!Number.isFinite(deadlineMs)) throw new Error('invalid-diagnostic-deadline');
  let diagnostic: HttpRejectionDiagnostic | undefined;
  return {
    snapshot: () => diagnostic ? { ...diagnostic } : undefined,
    fetcher: async (input, init) => {
      if (init?.signal?.aborted || Date.now() >= deadlineMs)
        throw new DOMException('Diagnostic request cancelled', 'AbortError');
      const response = await fetcher(input, init);
      if (response.ok) return response;
      diagnostic = { status: response.status, bodyRead: 'pending', bytesCaptured: 0, parse: 'not-attempted' };
      // Opaque synthetic responses have status 0 and cannot be reconstructed.
      if (response.status < 200 || response.status > 599) {
        diagnostic.bodyRead = 'unreadable'; cancelUnclaimedBody(response); return response;
      }
      await readRejectedBody(response, diagnostic, init?.signal, deadlineMs);
      return new Response(null, { status: response.status });
    },
  };
}
