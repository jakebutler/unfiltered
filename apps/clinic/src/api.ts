import type { ApiError } from '../../../packages/clinic-contract/src/index';

export class RequestError extends Error {
  constructor(message: string, public status: number, public code: string, public retryable: boolean) { super(message); }
  get uncertain() { return this.status === 0 || this.status >= 500; }
}

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
  } finally { window.clearTimeout(timeout); }
}

export const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed. Please try again.';
