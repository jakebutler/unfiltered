import { z } from 'zod';
import { canonicalJson, digest } from '../../clinical-core/src/domain.js';
import { base64Json, type FhirResource } from '../../clinical-core/src/fhir.js';
import { fhirResource, type MedplumClient } from '../../clinical-core/src/medplum.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import { decodeDocument, findDocument, object } from './store.js';

const SYSTEM = 'urn:corvo:clinic:provider-budget';
const providers = ['digitalocean', 'deepgram', 'elevenlabs'] as const;
const integer = z.number().int().nonnegative().max(1_000_000_000);
const unitsSchema = z.object({ requests: integer, inputBytes: integer, outputTokens: integer, characters: integer, audioSeconds: integer }).strict();
export type ProviderUnits = z.infer<typeof unitsSchema>;
const boundSchema = z.object({ account: unitsSchema, session: unitsSchema, concurrency: z.number().int().min(1).max(10), leaseMs: z.number().int().min(1000).max(120000) }).strict();
const policySchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/), limits: z.object({ digitalocean: boundSchema, deepgram: boundSchema, elevenlabs: boundSchema }).strict() }).strict();
export type ProviderBudgetPolicy = z.infer<typeof policySchema>;
const claimSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), session: z.string().regex(/^[a-f0-9]{64}$/), nonce: z.string().uuid(), provider: z.enum(providers), units: unitsSchema, startedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(), outcome: z.enum(['active', 'completed', 'failed', 'interrupted', 'unknown']) }).strict();
const ledgerSchema = z.object({ schema: z.literal(1), policyDigest: z.string().regex(/^[a-f0-9]{64}$/), claims: z.array(claimSchema).max(1500) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;
export type ProviderOutcome = 'completed' | 'failed' | 'interrupted' | 'unknown';
export class AdmissionError extends Error { constructor(readonly code: string) { super(code); } }
export const noUnits = (): ProviderUnits => ({ requests: 0, inputBytes: 0, outputTokens: 0, characters: 0, audioSeconds: 0 });
export interface ProviderReservation { provider: typeof providers[number]; sessionId: string; requestId: string; units: ProviderUnits; }
export interface ProviderLease { settle(outcome: ProviderOutcome): Promise<void>; }
function validUnits(provider: ProviderReservation['provider'], units: ProviderUnits): boolean {
  if (units.requests !== 1) return false;
  return provider === 'digitalocean' ? units.characters === 0 && units.audioSeconds === 0 && units.inputBytes > 0 && units.outputTokens > 0
    : provider === 'deepgram' ? units.inputBytes === 0 && units.outputTokens === 0 && units.characters === 0 && units.audioSeconds > 0
    : units.inputBytes === 0 && units.outputTokens === 0 && units.audioSeconds === 0 && units.characters > 0;
}

/** One ledger per deployment/account budget. No patient content or credentials are stored here.
 * Full reservations remain charged after failure, cancellation, expiry and restart. A configuration
 * change cannot replenish this ledger: changed limits require an explicit new policy and budget.
 */
export function createProviderAdmission(client: () => Promise<MedplumClient>, policyInput: ProviderBudgetPolicy, now = Date.now) {
  const parsed = policySchema.safeParse(policyInput);
  if (!parsed.success) throw new AdmissionError('invalid-budget-policy');
  const policy = parsed.data;
  const minimumLease = { digitalocean: 20000, deepgram: 70000, elevenlabs: 35000 };
  if (providers.some(provider => policy.limits[provider].leaseMs < minimumLease[provider])) throw new AdmissionError('provider-lease-too-short');
  const fingerprint = digest(policy);
  const id = `budget-${policy.id}`;
  function resource(data: Ledger, previous?: FhirResource): FhirResource {
    const text = canonicalJson(data);
    if (new TextEncoder().encode(text).byteLength > 490000) throw new AdmissionError('budget-ledger-full');
    return { resourceType: 'DocumentReference', ...(previous ? { id: previous.id } : {}), status: 'current', identifier: [{ system: SYSTEM, value: id }], content: [{ attachment: { contentType: 'application/json', data: base64Json(data) } }] };
  }
  async function read(c: MedplumClient): Promise<{ resource: FhirResource; ledger: Ledger; version: string } | undefined> {
    const r = await findDocument(c, SYSTEM, id);
    if (!r) return undefined;
    const data = ledgerSchema.safeParse(decodeDocument(r)), version = object(r.meta).versionId;
    if (!data.success || data.data.policyDigest !== await fingerprint || typeof version !== 'string' || !r.id || r.resourceType !== 'DocumentReference' || r.subject !== undefined)
      throw new AdmissionError('budget-ledger-invalid');
    if (new Set(data.data.claims.map(x => x.key)).size !== data.data.claims.length || new Set(data.data.claims.map(x => x.nonce)).size !== data.data.claims.length || data.data.claims.some(x => !validUnits(x.provider, x.units) || x.expiresAt - x.startedAt !== policy.limits[x.provider].leaseMs)) throw new AdmissionError('budget-ledger-invalid');
    return { resource: r, ledger: data.data, version };
  }
  async function load(c: MedplumClient) {
    let stored = await read(c);
    if (stored) return stored;
    const empty: Ledger = { schema: 1, policyDigest: await fingerprint, claims: [] };
    try { await c.request('DocumentReference', 'POST', resource(empty), { 'If-None-Exist': new URLSearchParams({ identifier: `${SYSTEM}|${id}` }).toString() }); }
    catch { /* Conditional creation may already be committed. Read, never replace. */ }
    stored = await read(c);
    if (!stored) throw new AdmissionError('budget-unavailable');
    return stored;
  }
  async function update(c: MedplumClient, previous: Awaited<ReturnType<typeof load>>, ledger: Ledger): Promise<boolean> {
    try {
      const r = fhirResource((await c.request(`DocumentReference/${previous.resource.id}`, 'PUT', resource(ledger, previous.resource), { 'If-Match': `W/"${previous.version}"` })).body);
      if (r.resourceType !== 'DocumentReference' || r.id !== previous.resource.id || r.subject !== undefined || canonicalJson(r.identifier) !== canonicalJson(previous.resource.identifier) || canonicalJson(decodeDocument(r)) !== canonicalJson(ledger) || typeof object(r.meta).versionId !== 'string' || object(r.meta).versionId === previous.version) throw new AdmissionError('budget-write-unverified');
      return true;
    } catch (error) {
      // Only explicit CAS rejection can be retried. Ambiguous writes never permit provider dispatch.
      if (error instanceof TransportError && error.status === 412) return false;
      throw new AdmissionError('budget-outcome-unknown');
    }
  }
  return {
    async reserve(input: ProviderReservation): Promise<ProviderLease> {
      const valid = z.object({ provider: z.enum(providers), sessionId: z.string().min(1).max(100), requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), units: unitsSchema }).strict().safeParse(input);
      if (!valid.success || valid.data.units.requests !== 1) throw new AdmissionError('invalid-reservation');
      const request = valid.data;
      // Independent dimensions prevent one provider's remaining credit from authorizing another.
      if (!validUnits(request.provider, request.units)) throw new AdmissionError('invalid-reservation');
      const key = await digest([request.provider, request.requestId]);
      const session = await digest(request.sessionId);
      const nonce = crypto.randomUUID();
      const c = await client();
      const limit = policy.limits[request.provider];
      for (let attempt = 0; attempt < 4; attempt++) {
        const previous = await load(c);
        if (previous.ledger.claims.some(x => x.key === key)) throw new AdmissionError('provider-attempt-already-reserved');
        if (previous.ledger.claims.length >= 1500) throw new AdmissionError('budget-ledger-full');
        const providerClaims = previous.ledger.claims.filter(x => x.provider === request.provider);
        const at = now();
        if (providerClaims.filter(x => ['active', 'unknown', 'interrupted'].includes(x.outcome) && x.expiresAt > at).length >= limit.concurrency) throw new AdmissionError('provider-busy');
        if (providerClaims.some(x => x.session === session && ['active', 'unknown', 'interrupted'].includes(x.outcome) && x.expiresAt > at)) throw new AdmissionError('provider-session-busy');
        for (const [scope, claims] of [['account', providerClaims], ['session', providerClaims.filter(x => x.session === session)]] as const) {
          for (const dimension of Object.keys(request.units) as (keyof ProviderUnits)[]) {
            const total = claims.reduce((sum, claim) => sum + claim.units[dimension], 0);
            if (total + request.units[dimension] > limit[scope][dimension]) throw new AdmissionError('provider-budget-exhausted');
          }
        }
        const claim: Ledger['claims'][number] = { key, session, nonce, provider: request.provider, units: request.units, startedAt: at, expiresAt: at + limit.leaseMs, outcome: 'active' };
        if (!await update(c, previous, { ...previous.ledger, claims: [...previous.ledger.claims, claim] })) continue;
        if (now() >= claim.expiresAt) throw new AdmissionError('provider-lease-expired');
        return {
          async settle(outcome) {
            if (!['completed', 'failed', 'interrupted', 'unknown'].includes(outcome)) throw new AdmissionError('invalid-provider-outcome');
            for (let i = 0; i < 4; i++) {
              const current = await load(await client());
              const entry = current.ledger.claims.find(x => x.key === key);
              if (!entry || entry.nonce !== nonce) throw new AdmissionError('budget-claim-missing');
              if (entry.outcome !== 'active') return;
              // Unknown/interrupted work stays in the concurrency count until its deadline.
              const claims = current.ledger.claims.map(x => x.key === key ? { ...x, outcome } : x);
              if (await update(await client(), current, { ...current.ledger, claims })) return;
            }
            throw new AdmissionError('budget-contention');
          },
        };
      }
      throw new AdmissionError('budget-contention');
    },
  };
}
