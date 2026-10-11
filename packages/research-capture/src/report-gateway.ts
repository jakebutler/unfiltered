import type { PrivateObjectStore } from './contracts';
import type { AuthorizedMedia } from './gateway';
import { protectedObjectResponse, PRIVATE_HEADERS } from './protected-read';
import type { PublishedReport } from '../../research-core/src/publication';
export type SharedSource = { type: 'text'; text: string; mime: string } | { type: 'media'; object: AuthorizedMedia };
export interface ViewerAuthority {
  published(args: { token: string; slug: string }): Promise<PublishedReport>;
  source(args: { token: string; slug: string; evidenceId: string; intent: 'view' | 'download' }): Promise<SharedSource>;
}
export function reportReadGateway(store: PrivateObjectStore, authority: ViewerAuthority) {
  return async (request: Request, token: string): Promise<Response> => {
    if (request.method !== 'GET') return new Response('Method unavailable', { status: 405, headers: PRIVATE_HEADERS });
    const url = new URL(request.url), slug = url.searchParams.get('slug') ?? '';
    if (!/^[a-f0-9]{32}$/.test(slug)) throw new Error('Access unavailable');
    if (url.pathname === '/api/research/portal/report' || url.pathname === '/api/research/portal/download') {
      const report = await authority.published({ token, slug }), download = url.pathname.endsWith('/download');
      // Recheck immediately before returning the sanitized immutable snapshot.
      await authority.published({ token, slug });
      return Response.json(report, { headers: { ...PRIVATE_HEADERS, ...(download ? { 'Content-Disposition': 'attachment; filename="approved-report.json"' } : {}) } });
    }
    const evidenceId = /^\/api\/research\/portal\/source\/(e[1-9][0-9]*)$/.exec(url.pathname)?.[1], intent = url.searchParams.get('intent');
    if (!evidenceId || !['view', 'download'].includes(intent ?? '')) return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
    const args = { token, slug, evidenceId, intent: intent as 'view' | 'download' }, result = await authority.source(args);
    const disposition: Record<string, string> = intent === 'download' ? { 'Content-Disposition': 'attachment; filename="shared-source"' } : {};
    if (result.type === 'text') { await authority.source(args); return new Response(result.text, { headers: { ...PRIVATE_HEADERS, ...disposition, 'Content-Type': result.mime } }); }
    return protectedObjectResponse(store, async () => { const latest = await authority.source(args); if (latest.type !== 'media') throw new Error('Source changed'); return latest.object; }, request.headers.get('Range'), disposition);
  };
}
