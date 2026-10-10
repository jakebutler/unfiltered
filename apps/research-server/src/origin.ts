import type { IncomingHttpHeaders } from 'node:http';

/** Browser same-origin GET may omit Origin. Normalize only an authenticated
 * same-origin fetch with its exact public Referer; this grants no byte authority. */
export function trustedFacadeOrigin(method: string, headers: IncomingHttpHeaders, origin: string): boolean {
  if (headers.origin !== undefined) return headers.origin === origin;
  if (method !== 'GET' || typeof headers.authorization !== 'string' || !/^Bearer [^\s]{1,4096}$/.test(headers.authorization) || headers['sec-fetch-site'] !== 'same-origin' || typeof headers.referer !== 'string') return false;
  try { return new URL(headers.referer).origin === origin; } catch { return false; }
}
