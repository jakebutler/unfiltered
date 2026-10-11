import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface ClinicAsset { body: Uint8Array; contentType: string; digest: string; immutable: boolean; }
export type ClinicAssets = ReadonlyMap<string, ClinicAsset>;
const mime: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf' };
export function assetContentType(path: string): string | undefined { return mime[path.split('.').at(-1) ?? '']; }

/** Serve only enumerated build artifacts; the runtime never maps arbitrary request paths to disk. */
export function loadClinicAssets(directory: string): ClinicAssets {
  const root = realpathSync(directory), manifest = JSON.parse(readFileSync(resolve(root, '../asset-manifest.json'), 'utf8')) as { files?: unknown };
  if (!Array.isArray(manifest.files) || manifest.files.length > 200) throw new Error('clinic-asset-manifest-invalid');
  const assets = new Map<string, ClinicAsset>(); let bytes = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object') throw new Error('clinic-asset-manifest-invalid');
    const { path, digest } = entry as { path: string; digest: string };
    if (typeof path !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) || path.split('/').some(part => !part || part.startsWith('.')) || !assetContentType(path) || !/^[a-f0-9]{64}$/.test(digest) || assets.has(`/${path}`)) throw new Error('clinic-asset-manifest-invalid');
    const file = realpathSync(resolve(root, path));
    if (!file.startsWith(`${root}${sep}`)) throw new Error('clinic-asset-outside-public-directory');
    const body = readFileSync(file); bytes += body.byteLength;
    if (bytes > 10_000_000 || createHash('sha256').update(body).digest('hex') !== digest) throw new Error('clinic-asset-integrity-failed');
    assets.set(`/${path}`, { body, contentType: assetContentType(path)!, digest, immutable: /^assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path) });
  }
  if (!assets.has('/index.html')) throw new Error('clinic-index-missing');
  return assets;
}

const headers = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'microphone=(self), camera=(), display-capture=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
export function serveClinicAsset(request: Request, assets: ClinicAssets, canonicalOrigin?: string): Response {
  const path = new URL(request.url).pathname;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  const asset = assets.get(path === '/' || path === '/staff' || path === '/staff/' ? '/index.html' : path);
  if (!asset) return new Response('Not found', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  const etag = `"${asset.digest}"`, cache = asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
  const socketOrigin = canonicalOrigin ? canonicalOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') : undefined;
  const responseHeaders = { ...headers, ...(socketOrigin ? { 'Content-Security-Policy': headers['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${socketOrigin}`) } : {}), 'Content-Type': asset.contentType, 'Cache-Control': cache, ETag: etag };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: responseHeaders });
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.body), { headers: { ...responseHeaders, 'Content-Length': String(asset.body.byteLength) } });
}
