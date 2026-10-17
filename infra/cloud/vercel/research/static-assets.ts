import { loadClinicAssets, type ClinicAssets } from '../static-assets';
export { loadClinicAssets as loadResearchAssets };
export type ResearchAssets = ClinicAssets;
export function researchHeaders(origin: string) {
  return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'microphone=(self), camera=(self), display-capture=(self)', 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace('https:', 'wss:')} https://elegant-crane-662.convex.cloud wss://elegant-crane-662.convex.cloud https://elegant-crane-662.convex.site; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` };
}
export function serveResearchAsset(request: Request, assets: ResearchAssets, origin: string) {
  const url = new URL(request.url), headers = { ...researchHeaders(origin), 'Cache-Control': 'private, no-store' };
  if (url.origin !== origin || request.headers.get('Host') !== new URL(origin).host) return new Response('Access unavailable', { status: 403, headers });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  const route = ['/', '/participate', '/participate/'].includes(url.pathname) || /^\/report\/[a-zA-Z0-9_-]{1,128}$/.test(url.pathname);
  const asset = assets.get(route ? '/index.html' : url.pathname);
  if (!asset) return new Response('Not found', { status: 404, headers });
  const responseHeaders = { ...headers, 'Content-Type': asset.contentType, ETag: `"${asset.digest}"`, ...(asset.immutable ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}) };
  if (asset.body.byteLength > 4000000) return new Response('Asset exceeds platform envelope', { status: 413, headers });
  if (request.headers.get('If-None-Match') === `"${asset.digest}"`) return new Response(null, { status: 304, headers: responseHeaders });
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.body), { headers: { ...responseHeaders, 'Content-Length': String(asset.body.byteLength) } });
}
