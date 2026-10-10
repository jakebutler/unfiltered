import { ClinicalError, digest, type ConfirmedSubmission } from './domain.js';
import { type Component, type FhirResource, type HandoffPlan, identifierQuery, planHandoff, transactionBundle, verifyComponent } from './fhir.js';
import { requestJson, TransportError, type Fetch } from './transport.js';

export interface MedplumConfig { baseUrl: string; accessToken: string; timeoutMs: number; mode: 'local' | 'live'; }
export type Receipt =
  | { state: 'received'; digest: string; resources: Record<string, string>; receivedAt?: string; review: 'not-established' }
  | { state: 'absent' | 'incomplete' | 'unknown' | 'conflict'; digest: string; present: number };
export interface DeliveryAttempt { receipt: Receipt; write: 'not-attempted' | 'acknowledged' | 'outcome-unknown' | 'rejected'; response?: unknown; }
export interface AtomicQualification { baseUrl: string; mode: 'local' | 'live'; credentialFingerprint: string; atomicRollback: true; conditionalCreate: true; versionConflict: true; qualifiedAt: string; }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export function fhirResource(value: unknown): FhirResource {
  if (!object(value) || typeof value.resourceType !== 'string') throw new ClinicalError('invalid-fhir-resource');
  return value as FhirResource;
}
export function validatedMedplumConfig(config: MedplumConfig): MedplumConfig {
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new ClinicalError('invalid-medplum-configuration'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/fhir/R4/') || !config.accessToken.trim() || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 60000 || (config.mode === 'local' ? !local || !['http:', 'https:'].includes(url.protocol) : config.mode !== 'live' || url.protocol !== 'https:' || local)) throw new ClinicalError('invalid-medplum-configuration');
  return { ...config, baseUrl: url.href };
}
export class MedplumClient {
  readonly config: MedplumConfig;
  constructor(config: MedplumConfig, private readonly fetcher: Fetch = fetch) { this.config = validatedMedplumConfig(config); }
  async request(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    if (path.startsWith('/') || path.includes('..') || /^[a-z]+:/i.test(path)) throw new ClinicalError('invalid-fhir-path');
    return requestJson(this.fetcher, `${this.config.baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${this.config.accessToken}`, Accept: 'application/fhir+json', 'Content-Type': 'application/fhir+json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }, this.config.timeoutMs);
  }
  async findByIdentifier(resourceType: string, key: string): Promise<FhirResource | undefined> {
    if (!/^[A-Z][A-Za-z]+$/.test(resourceType)) throw new ClinicalError('invalid-resource-type');
    const { body } = await this.request(`${resourceType}?${identifierQuery(key)}&_count=2`);
    if (!object(body) || body.resourceType !== 'Bundle' || body.type !== 'searchset') throw new ClinicalError('invalid-fhir-search');
    if (body.entry !== undefined && !Array.isArray(body.entry)) throw new ClinicalError('invalid-fhir-search');
    const entries = (body.entry ?? []) as unknown[];
    if (entries.length > 1 || (typeof body.total === 'number' && body.total > 1) || (Array.isArray(body.link) && body.link.some(l => object(l) && l.relation === 'next'))) throw new ClinicalError('duplicate-conditional-identifier');
    if (!entries.length) {
      if (body.total !== undefined && body.total !== 0) throw new ClinicalError('invalid-fhir-search');
      return undefined;
    }
    const entry = entries[0];
    if (!object(entry)) throw new ClinicalError('invalid-fhir-search');
    const resource = fhirResource(entry.resource);
    if (resource.resourceType !== resourceType || typeof resource.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(resource.id)) throw new ClinicalError('invalid-fhir-search');
    return resource;
  }
  async reconcile(plan: HandoffPlan): Promise<Receipt> {
    const digest = plan.confirmation.digest;
    const found = new Map<string, FhirResource>();
    try {
      // Small bounded set; sequential requests avoid accidentally multiplying a service's rate limit.
      for (const component of plan.components) {
        const resource = await this.findByIdentifier(component.resource.resourceType, component.key);
        if (resource) found.set(component.key, resource);
      }
      const refs = new Map(plan.components.filter(c => found.has(c.key)).map(c => [c.fullUrl, `${c.resource.resourceType}/${found.get(c.key)!.id}`]));
      for (const c of plan.components) if (found.has(c.key) && !verifyComponent(c.resource, found.get(c.key)!, refs)) return { state: 'conflict', digest, present: found.size };
      if (!found.size) return { state: 'absent', digest, present: 0 };
      if (found.size !== plan.components.length) return { state: 'incomplete', digest, present: found.size };
      const responseComponent = plan.components.find(c => c.resource.resourceType === 'QuestionnaireResponse');
      const meta = responseComponent ? found.get(responseComponent.key)?.meta : undefined;
      // The immutable response was created with the native handoff. Task updates,
      // preview creation and later status reads must not move its receipt time.
      const receivedAt = object(meta) && typeof meta.lastUpdated === 'string' && Number.isFinite(Date.parse(meta.lastUpdated)) ? meta.lastUpdated : undefined;
      return { state: 'received', digest, resources: Object.fromEntries(plan.components.map(c => [c.key, `${c.resource.resourceType}/${found.get(c.key)!.id}`])), ...(receivedAt ? { receivedAt } : {}), review: 'not-established' };
    } catch (error) {
      return { state: error instanceof ClinicalError && error.code === 'duplicate-conditional-identifier' ? 'conflict' : 'unknown', digest, present: found.size };
    }
  }
  /** Native transaction submission is available only after qualification of this exact endpoint/mode. */
  async deliver(confirmation: ConfirmedSubmission, qualification: AtomicQualification): Promise<DeliveryAttempt> {
    if (qualification.baseUrl !== this.config.baseUrl || qualification.mode !== this.config.mode || qualification.credentialFingerprint !== await digest(this.config.accessToken) || qualification.atomicRollback !== true || qualification.conditionalCreate !== true || qualification.versionConflict !== true || Number.isNaN(Date.parse(qualification.qualifiedAt))) throw new ClinicalError('native-transaction-not-qualified');
    const plan = await planHandoff(confirmation);
    const before = await this.reconcile(plan);
    if (before.state !== 'absent') return { receipt: before, write: 'not-attempted' };
    let response: unknown;
    let write: DeliveryAttempt['write'];
    try {
      const result = await this.request('', 'POST', transactionBundle(plan));
      response = result.body;
      const valid = object(response) && response.resourceType === 'Bundle' && response.type === 'transaction-response' && Array.isArray(response.entry) && response.entry.length === plan.components.length && response.entry.every(e => object(e) && object(e.response) && typeof e.response.status === 'string' && /^20[01]\b/.test(e.response.status));
      write = valid ? 'acknowledged' : 'outcome-unknown';
    } catch (error) {
      write = error instanceof TransportError && error.code === 'http' && [400, 401, 403, 409, 412, 422].includes(error.status ?? 0) ? 'rejected' : 'outcome-unknown';
    }
    // Even a complete-looking response is not sufficient: verify readable persisted components.
    return { receipt: await this.reconcile(plan), write, ...(response ? { response } : {}) };
  }
  async check(confirmation: ConfirmedSubmission): Promise<Receipt> { return this.reconcile(await planHandoff(confirmation)); }
}
export type { Component };
