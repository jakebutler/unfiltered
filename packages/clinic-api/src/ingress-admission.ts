import { z } from 'zod';
import { canonicalJson, digest } from '../../clinical-core/src/domain.js';
import { base64Json, type FhirResource } from '../../clinical-core/src/fhir.js';
import { fhirResource, type MedplumClient } from '../../clinical-core/src/medplum.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import { decodeDocument, findDocument, object } from './store.js';
import { ApiFailure } from './types.js';

const system = 'urn:corvo:clinic:ingress';
const ledgerId = 'corvo-clinic-public-ingress';
const kinds = ['session-create', 'staff-login', 'speech-upgrade'] as const;
const validVersion = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(value);
const limit = z.object({ minute: z.number().int().min(1).max(1000), day: z.number().int().min(1).max(1600), lifetime: z.number().int().min(1).max(1600) }).strict();
const policySchema = z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/), limits: z.object({ 'session-create': limit, 'staff-login': limit, 'speech-upgrade': limit }).strict(), socketConcurrency: z.number().int().min(1).max(10), socketLeaseMs: z.number().int().min(90000).max(120000) }).strict();
export type IngressPolicy = z.infer<typeof policySchema>;
/** Stable across origin changes, instances and deployments; policy edits do not reset this ledger. */
export const hostedIngressPolicy: IngressPolicy = {
  id: 'corvo-clinic-public-ingress-v1',
  limits: { 'session-create': { minute: 6, day: 50, lifetime: 200 }, 'staff-login': { minute: 10, day: 100, lifetime: 400 }, 'speech-upgrade': { minute: 12, day: 300, lifetime: 1000 } },
  socketConcurrency: 2, socketLeaseMs: 90000,
};
const claimSchema = z.object({ id: z.string().uuid(), kind: z.enum(kinds), at: z.number().int().nonnegative(), sessionHash: z.string().regex(/^(?:[a-f0-9]{64})?$/), expiresAt: z.number().int().nonnegative(), closed: z.boolean() }).strict();
const ledgerSchema = z.object({ schema: z.literal(1), policyDigest: z.string().regex(/^[a-f0-9]{64}$/), lastAt: z.number().int().nonnegative(), claims: z.array(claimSchema).max(1600) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;
export interface IngressRequest { kind: typeof kinds[number]; attemptId: string; sessionId?: string; }
/** close() is only for an observed native socket close, never a timeout assumption or browser message. */
export interface IngressLease { expiresAt: number; close(): Promise<void>; }
export interface IngressAdmission { reserve(input: IngressRequest): Promise<IngressLease>; }
const unavailable = (code = 'ingress-unavailable') => new ApiFailure(code, 503, false);

/** One bounded append-only attempt ledger; this protects downstream admission, not network DDoS. */
export function createIngressAdmission(client: () => Promise<MedplumClient>, policyInput: IngressPolicy = hostedIngressPolicy, now = Date.now): IngressAdmission {
  const parsed = policySchema.safeParse(policyInput);
  if (!parsed.success) throw new Error('invalid-ingress-policy');
  const policy = parsed.data;
  if (kinds.some(kind => policy.limits[kind].minute > policy.limits[kind].day || policy.limits[kind].day > policy.limits[kind].lifetime) || kinds.reduce((sum, kind) => sum + policy.limits[kind].lifetime, 0) > 1600) throw new Error('invalid-ingress-policy');
  const fingerprint = digest(policy), identifier = [{ system, value: ledgerId }];
  function resource(data: Ledger, previous?: FhirResource): FhirResource {
    if (new TextEncoder().encode(canonicalJson(data)).byteLength > 450000) throw unavailable('ingress-ledger-full');
    return { resourceType: 'DocumentReference', ...(previous ? { id: previous.id } : {}), status: 'current', identifier, content: [{ attachment: { contentType: 'application/json', data: base64Json(data) } }] };
  }
  async function read(c: MedplumClient) {
    const native = await findDocument(c, system, ledgerId);
    if (!native) return undefined;
    const data = ledgerSchema.safeParse(decodeDocument(native)), version = object(native.meta).versionId;
    if (!data.success || data.data.policyDigest !== await fingerprint || native.resourceType !== 'DocumentReference' || !native.id || !validVersion(version) || native.subject !== undefined || canonicalJson(native.identifier) !== canonicalJson(identifier) || native.status !== 'current') throw unavailable('ingress-ledger-invalid');
    const ledger = data.data;
    if (new Set(ledger.claims.map(claim => claim.id)).size !== ledger.claims.length || ledger.claims.some(claim => claim.at > ledger.lastAt || (claim.kind === 'speech-upgrade' ? !claim.sessionHash || claim.expiresAt !== claim.at + policy.socketLeaseMs : claim.sessionHash !== '' || claim.expiresAt !== 0 || claim.closed))) throw unavailable('ingress-ledger-invalid');
    return { native, ledger, version };
  }
  async function load(c: MedplumClient) {
    let stored = await read(c); if (stored) return stored;
    const empty: Ledger = { schema: 1, policyDigest: await fingerprint, lastAt: 0, claims: [] };
    try { await c.request('DocumentReference', 'POST', resource(empty), { 'If-None-Exist': new URLSearchParams({ identifier: `${system}|${ledgerId}` }).toString() }); }
    catch { /* Only empty-ledger initialization is reconciled; no attempt has been admitted. */ }
    stored = await read(c); if (!stored) throw unavailable(); return stored;
  }
  async function update(c: MedplumClient, previous: Awaited<ReturnType<typeof load>>, ledger: Ledger): Promise<boolean> {
    try {
      const native = fhirResource((await c.request(`DocumentReference/${previous.native.id}`, 'PUT', resource(ledger, previous.native), { 'If-Match': `W/"${previous.version}"` })).body);
      const version = object(native.meta).versionId;
      if (native.resourceType !== 'DocumentReference' || native.id !== previous.native.id || native.status !== 'current' || native.subject !== undefined || canonicalJson(native.identifier) !== canonicalJson(identifier) || canonicalJson(decodeDocument(native)) !== canonicalJson(ledger) || !validVersion(version) || version === previous.version) throw unavailable('ingress-write-unverified');
      return true;
    } catch (error) {
      if (error instanceof TransportError && error.status === 412) return false;
      // Lost/malformed acknowledgement never yields a downstream dispatch lease.
      throw unavailable('ingress-outcome-unknown');
    }
  }
  async function reserve(input: IngressRequest): Promise<IngressLease> {
    const valid = z.object({ kind: z.enum(kinds), attemptId: z.string().uuid(), sessionId: z.string().uuid().optional() }).strict().safeParse(input);
    if (!valid.success || (valid.data.kind === 'speech-upgrade') !== !!valid.data.sessionId) throw new ApiFailure('invalid-ingress-request');
    const request = valid.data, sessionHash = request.sessionId ? await digest(['clinic-ingress-session', request.sessionId]) : '';
    const c = await client();
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await load(c), at = now();
      if (!Number.isSafeInteger(at) || at < previous.ledger.lastAt) throw unavailable('ingress-clock-regression');
      if (previous.ledger.claims.some(claim => claim.id === request.attemptId)) throw new ApiFailure('ingress-attempt-already-reserved', 409, false);
      const claims = previous.ledger.claims.filter(claim => claim.kind === request.kind), bounds = policy.limits[request.kind];
      if (claims.length >= bounds.lifetime || previous.ledger.claims.length >= 1600) throw new ApiFailure('ingress-allocation-exhausted', 429, false);
      if (claims.filter(claim => claim.at > at - 60000).length >= bounds.minute || claims.filter(claim => claim.at > at - 86400000).length >= bounds.day) throw new ApiFailure('ingress-rate-limited', 429, true);
      if (request.kind === 'speech-upgrade') {
        const active = claims.filter(claim => !claim.closed && claim.expiresAt > at);
        if (active.length >= policy.socketConcurrency || active.some(claim => claim.sessionHash === sessionHash)) throw new ApiFailure('ingress-socket-busy', 429, true);
      }
      const claim: Ledger['claims'][number] = { id: request.attemptId, kind: request.kind, at, sessionHash, expiresAt: request.kind === 'speech-upgrade' ? at + policy.socketLeaseMs : 0, closed: false };
      if (!await update(c, previous, { ...previous.ledger, lastAt: at, claims: [...previous.ledger.claims, claim] })) continue;
      if (now() < at) throw unavailable('ingress-clock-regression');
      if (claim.expiresAt && now() >= claim.expiresAt - 1000) throw unavailable('ingress-lease-expired');
      return { expiresAt: claim.expiresAt, async close() {
        if (request.kind !== 'speech-upgrade') return;
        try {
          for (let attempt = 0; attempt < 4; attempt++) {
            const c = await client(), current = await load(c), found = current.ledger.claims.find(row => row.id === claim.id);
            if (!found || canonicalJson({ ...found, closed: false }) !== canonicalJson(claim)) throw unavailable('ingress-claim-mismatch');
            if (found.closed) return;
            if (await update(c, current, { ...current.ledger, claims: current.ledger.claims.map(row => row.id === claim.id ? { ...row, closed: true } : row) })) return;
          }
          throw unavailable('ingress-contention');
        } catch (error) { throw error instanceof ApiFailure ? error : unavailable(); }
      } };
    }
    throw unavailable('ingress-contention');
  }
  return { async reserve(input) { try { return await reserve(input); } catch (error) { throw error instanceof ApiFailure ? error : unavailable(); } } };
}
