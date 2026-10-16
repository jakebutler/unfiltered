import type { ApiError } from '../../../packages/clinic-contract/src/index';
import { newRequestId, parseServerTiming, recordTurnTiming, turnRouteName } from './turn-timing';

export class RequestError extends Error {
  constructor(message: string, public status: number, public code: string, public retryable: boolean) { super(message); }
  get uncertain() { return this.status === 0 || this.status >= 500; }
}

export async function request<T>(path: string, body?: unknown, timing?: { turnId?: string }): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25_000);
  const method = body === undefined ? 'GET' : 'POST';
  // Correlation id on every request; the server echoes it and returns Server-Timing. Turn routes are kept in window.__corvoTurnTimings.
  const requestId = newRequestId(), startedAt = new Date().toISOString(), started = performance.now(), route = turnRouteName(method, path);
  let status = 0, serverTiming: Record<string, number> = {};
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', 'X-Request-Id': requestId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    status = response.status;
    serverTiming = parseServerTiming(response.headers.get('Server-Timing'));
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (value as ApiError | null)?.error;
      throw new RequestError(error?.message || `The request could not be completed (${response.status}).`, response.status, error?.code || 'request-failed', error?.retryable ?? response.status >= 500);
    }
    if (value === null) throw new RequestError('The service returned an unreadable response. Check the saved state before trying again.', 0, 'unreadable-response', true);
    return value as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('The connection was interrupted. We could not confirm the result.', 0, 'connection-interrupted', true);
  } finally {
    window.clearTimeout(timeout);
    if (route) recordTurnTiming({ requestId, ...(timing?.turnId ? { turnId: timing.turnId } : {}), route, startedAt, clientMs: Math.round((performance.now() - started) * 10) / 10, status, serverTiming });
  }
}

export const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed. Please try again.';
