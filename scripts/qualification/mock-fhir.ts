/** Deliberately small FHIR test double. Never a clinical store or production fallback. */
import { type Fetch } from '../../packages/clinical-core/src/transport.js';
import { IDENTIFIER_SYSTEM, type FhirResource } from '../../packages/clinical-core/src/fhir.js';

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
export function mockFhir(options: { atomic: boolean } = { atomic: true }) {
  const resources = new Map<string, FhirResource>();
  const histories = new Map<string, FhirResource[]>();
  const counters = { requests: 0, writes: 0, transactionPosts: 0 };
  const matches = (type: string, token: string) => [...resources.values()].filter(r => {
    const identifiers = Array.isArray(r.identifier) ? r.identifier : [r.identifier];
    return r.resourceType === type && identifiers.some(i => (token.endsWith('|') ? `${obj(i).system}|${obj(i).value}`.startsWith(token) : `${obj(i).system}|${obj(i).value}` === token));
  });
  const valid = (r: FhirResource) => r.resourceType !== 'Task' || (r.intent === 'order' && r.status === 'requested');
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/fhir+json' } });
  const outcome = () => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid' }] });
  const rewrite = (value: unknown, refs: Map<string, string>): unknown => {
    if (typeof value === 'string') return refs.get(value) ?? value;
    if (Array.isArray(value)) return value.map(v => rewrite(v, refs));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, refs)]));
    return value;
  };
  const create = (r: FhirResource, conditional: string | null | undefined, refs = new Map<string, string>(), assignedId?: string) => {
    const token = conditional ? new URLSearchParams(conditional).get('identifier') : undefined;
    const found = token ? matches(r.resourceType, token) : [];
    if (found.length > 1) return { status: 412, body: outcome() };
    if (found[0]) return { status: 200, body: structuredClone(found[0]) };
    if (!valid(r)) return { status: 400, body: outcome() };
    const saved = rewrite({ ...structuredClone(r), id: assignedId ?? crypto.randomUUID(), meta: { ...obj(r.meta), versionId: '1', lastUpdated: new Date().toISOString() } }, refs) as FhirResource;
    resources.set(`${saved.resourceType}/${saved.id}`, saved); histories.set(`${saved.resourceType}/${saved.id}`, [structuredClone(saved)]); counters.writes++;
    return { status: 201, body: structuredClone(saved) };
  };
  const update = (path: string, body: FhirResource, ifMatch: string | null | undefined) => {
    const previous = resources.get(path);
    if (!previous) return { status: 404, body: outcome() };
    if (ifMatch !== `W/"${obj(previous.meta).versionId}"`) return { status: 412, body: outcome() };
    const updated = { ...structuredClone(body), meta: { ...obj(body.meta), versionId: String(Number(obj(previous.meta).versionId) + 1), lastUpdated: new Date(Math.max(Date.now(), Date.parse(String(obj(previous.meta).lastUpdated)) + 1)).toISOString() } };
    resources.set(path, updated); histories.get(path)?.push(structuredClone(updated)); counters.writes++;
    return { status: 200, body: updated };
  };
  const fetcher: Fetch = async (input, init) => {
    counters.requests++;
    const url = new URL(String(input));
    const path = url.pathname.split('/fhir/R4/')[1];
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) as FhirResource : undefined;
    if (method === 'GET') {
      const history = path.match(/^([A-Za-z]+\/[A-Za-z0-9.-]+)\/_history(?:\/([A-Za-z0-9.-]+))?$/);
      if (history) {
        const versions = histories.get(history[1]) ?? [];
        if (history[2]) { const resource = versions.find(resource => obj(resource.meta).versionId === history[2]); return resource ? json(resource) : json(outcome(), 404); }
        const count = Number(url.searchParams.get('_count') ?? 64), rows = [...versions].reverse().slice(0, count);
        return json({ resourceType: 'Bundle', type: 'history', total: versions.length, entry: rows.map(resource => ({ resource })), ...(versions.length > count ? { link: [{ relation: 'next', url: url.href }] } : {}) });
      }
      if (path.includes('/')) return resources.has(path) ? json(resources.get(path)) : json(outcome(), 404);
      let found = matches(path, url.searchParams.get('identifier') ?? '');
      const subjects = url.searchParams.get('subject')?.split(',');
      if (subjects) found = found.filter(resource => subjects.includes(String(obj(resource.subject).reference)));
      if (url.searchParams.get('_sort') === '-_lastUpdated') found.sort((left, right) => Date.parse(String(obj(right.meta).lastUpdated)) - Date.parse(String(obj(left.meta).lastUpdated)));
      const total = found.length, offset = Number(url.searchParams.get('_offset') ?? 0), count = Number(url.searchParams.get('_count') ?? total);
      found = found.slice(offset, offset + count);
      const next = new URL(url); next.searchParams.set('_offset', String(offset + count));
      return json({ resourceType: 'Bundle', type: 'searchset', total, entry: found.map(resource => ({ resource })), ...(offset + count < total ? { link: [{ relation: 'next', url: next.href }] } : {}) });
    }
    if (method === 'PUT' && body) {
      const result = update(path, body, headers.get('if-match'));
      return json(result.body, result.status);
    }
    if (method === 'POST' && path === '' && body?.resourceType === 'Bundle') {
      if (body.type === 'transaction') counters.transactionPosts++;
      const entries = body.entry as Array<{ fullUrl?: string; resource: FhirResource; request: { method: string; url: string; ifNoneExist?: string; ifMatch?: string } }>;
      if (body.type === 'transaction' && options.atomic) {
        if (entries.some(e => !valid(e.resource))) return json(outcome(), 400);
        if (entries.some(e => e.request.method === 'PUT' && e.request.ifMatch !== `W/"${obj(resources.get(e.request.url)?.meta).versionId}"`)) return json(outcome(), 412);
      }
      const refs = new Map<string, string>();
      const ids = entries.map(e => {
        const token = new URLSearchParams(e.request.ifNoneExist ?? '').get('identifier');
        const id = (token ? matches(e.resource.resourceType, token)[0]?.id : undefined) ?? crypto.randomUUID();
        if (e.fullUrl) refs.set(e.fullUrl, `${e.resource.resourceType}/${id}`);
        return id;
      });
      const results = entries.map((e, i) => {
        const result = e.request.method === 'PUT' ? update(e.request.url, e.resource, e.request.ifMatch) : create(e.resource, e.request.ifNoneExist, refs, ids[i]);
        const r = result.body as FhirResource;
        return { response: { status: `${result.status} ${result.status < 300 ? 'OK' : 'Bad Request'}`, ...(r.id ? { location: `${r.resourceType}/${r.id}/_history/1` } : {}) } };
      });
      return json({ resourceType: 'Bundle', type: body.type === 'transaction' && options.atomic ? 'transaction-response' : 'batch-response', entry: results });
    }
    if (method === 'POST' && body) { const result = create(body, headers.get('if-none-exist')); return json(result.body, result.status); }
    return json(outcome(), 400);
  };
  return { fetcher, resources, histories, counters, identifierSystem: IDENTIFIER_SYSTEM };
}
