import { getNativeQuestionnaireDefinition, type NativeBinding } from '../../clinic-content/src/native-questionnaire.js';
import { ClinicalError, digest, type ConfirmedSubmission } from './domain.js';
import { type Component, type FhirResource, type HandoffPlan, identifierQuery, planHandoff, transactionBundle, verifyComponent, resolvedComponent, resourceVersion, hasUnresolvedReferences, DELIVERY_CONTRACT, type AnchorDescriptor } from './fhir.js';
import { requestJson, TransportError, type Fetch } from './transport.js';

export interface MedplumConfig { baseUrl: string; accessToken: string; timeoutMs: number; mode: 'local' | 'live'; nativeQuestionnaire?: NativeBinding & { reference: string }; }
export type Receipt =
  | ({ state: 'received'; receivedAt?: string; review: 'not-established' } & DeliveryProgress)
  | ({ state: 'absent' | 'incomplete' | 'unknown' | 'conflict' } & DeliveryProgress);
export interface DeliveryProgress { digest: string; present: number; resources: Record<string, string>; anchors: Record<string, AnchorDescriptor>; verifiedWork: string[]; }
export interface DeliveryQualification { deliveryContract: typeof DELIVERY_CONTRACT; baseUrl: string; mode: 'local' | 'live'; credentialFingerprint: string; conditionalCreate: true; conditionalConcurrency: true; versionConflict: true; versionHistory: true; qualifiedAt: string; }
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
  async request(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>, options?: { timeoutMs?: number }) {
    if (path.startsWith('/') || path.includes('..') || /^[a-z]+:/i.test(path)) throw new ClinicalError('invalid-fhir-path');
    if (options?.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60000)) throw new ClinicalError('invalid-medplum-timeout');
    return requestJson(this.fetcher, `${this.config.baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${this.config.accessToken}`, Accept: 'application/fhir+json', 'Content-Type': 'application/fhir+json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }, Math.min(this.config.timeoutMs, options?.timeoutMs ?? this.config.timeoutMs));
  }
  /** Read only: bind the authored business identity to the configured immutable native version. */
  async verifyNativeQuestionnaire(): Promise<string> {
    const configured = this.config.nativeQuestionnaire, definition = await getNativeQuestionnaireDefinition();
    if (!configured || !/^Questionnaire\/[A-Za-z0-9.-]{1,64}\/_history\/[A-Za-z0-9.-]{1,64}$/.test(configured.reference) || configured.canonical !== definition.binding.canonical || configured.version !== definition.binding.version || configured.digest !== definition.binding.digest) throw new ClinicalError('native-questionnaire-binding-required');
    const actual = fhirResource((await this.request(configured.reference)).body);
    if (!verifyComponent(definition.questionnaire, actual) || resourceVersion(actual) !== configured.reference.split('/').at(-1) || `Questionnaire/${actual.id}` !== configured.reference.split('/_history/')[0]) throw new ClinicalError('native-questionnaire-resource-mismatch');
    return configured.reference;
  }
  private async deliveryPlan(confirmation: ConfirmedSubmission): Promise<HandoffPlan> {
    return planHandoff(confirmation, confirmation.submission.questionnaireCapture ? await this.verifyNativeQuestionnaire() : undefined);
  }
  async findByIdentifier(resourceType: string, key: string): Promise<FhirResource | undefined> {
    if (!/^[A-Z][A-Za-z]+$/.test(resourceType)) throw new ClinicalError('invalid-resource-type');
    const { body } = await this.request(`${resourceType}?${identifierQuery(key)}&_count=2`);
    if (!object(body) || body.resourceType !== 'Bundle' || body.type !== 'searchset') throw new ClinicalError('invalid-fhir-search');
    if (body.total !== undefined && (!Number.isSafeInteger(body.total) || Number(body.total) < 0) || body.link !== undefined && !Array.isArray(body.link) || body.entry !== undefined && !Array.isArray(body.entry)) throw new ClinicalError('invalid-fhir-search');
    const entries = (body.entry ?? []) as unknown[];
    if (entries.length > 1 || (typeof body.total === 'number' && body.total > 1) || (Array.isArray(body.link) && body.link.some(l => object(l) && l.relation === 'next'))) throw new ClinicalError('duplicate-conditional-identifier');
    if (!entries.length) {
      if (body.total !== undefined && body.total !== 0) throw new ClinicalError('invalid-fhir-search');
      return undefined;
    }
    if (body.total !== undefined && body.total !== entries.length) throw new ClinicalError('invalid-fhir-search');
    const entry = entries[0];
    if (!object(entry)) throw new ClinicalError('invalid-fhir-search');
    const resource = fhirResource(entry.resource);
    if (resource.resourceType !== resourceType || typeof resource.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(resource.id)) throw new ClinicalError('invalid-fhir-search');
    return resource;
  }
  private async reconcileAtomic(plan: HandoffPlan): Promise<AtomicReceipt> {
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
  async deliverAtomic(confirmation: ConfirmedSubmission, qualification: AtomicQualification): Promise<{ receipt: AtomicReceipt; write: DeliveryAttempt['write']; response?: unknown }> {
    if (qualification.baseUrl !== this.config.baseUrl || qualification.mode !== this.config.mode || qualification.credentialFingerprint !== await digest(this.config.accessToken) || qualification.atomicRollback !== true || qualification.conditionalCreate !== true || qualification.versionConflict !== true || Number.isNaN(Date.parse(qualification.qualifiedAt))) throw new ClinicalError('native-transaction-not-qualified');
    const plan = await this.deliveryPlan(confirmation);
    const before = await this.reconcileAtomic(plan);
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
    return { receipt: await this.reconcileAtomic(plan), write, ...(response ? { response } : {}) };
  }
  /** Native history is bounded. An unavailable or incomplete history is never trustworthy absence. */
  async history(reference: string, maximum = 64): Promise<FhirResource[]> {
    if (!/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/.test(reference)) throw new ClinicalError('invalid-fhir-reference');
    const body = (await this.request(`${reference}/_history?_count=${maximum}`)).body;
    if (!object(body) || body.resourceType !== 'Bundle' || body.type !== 'history' || !Array.isArray(body.entry) || body.entry.length > maximum || Array.isArray(body.link) && body.link.some(link => object(link) && link.relation === 'next') || typeof body.total === 'number' && body.total > body.entry.length) throw new ClinicalError('native-history-unavailable');
    const rows = body.entry.map(entry => {
      if (!object(entry)) throw new ClinicalError('native-history-unavailable');
      const resource = fhirResource(entry.resource);
      if (`${resource.resourceType}/${resource.id}` !== reference || !resourceVersion(resource)) throw new ClinicalError('native-history-unavailable');
      return resource;
    });
    if (!rows.length || new Set(rows.map(resourceVersion)).size !== rows.length) throw new ClinicalError('native-history-unavailable');
    return rows;
  }
  async versionRead(reference: string, version: string): Promise<FhirResource> {
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(version)) throw new ClinicalError('invalid-fhir-version');
    const resource = fhirResource((await this.request(`${reference}/_history/${version}`)).body);
    if (`${resource.resourceType}/${resource.id}` !== reference || resourceVersion(resource) !== version) throw new ClinicalError('native-version-mismatch');
    return resource;
  }
  private async inspect(plan: HandoffPlan): Promise<{ receipt: Receipt; found: Map<string, FhirResource>; references: Map<string, string> }> {
    const found = new Map<string, FhirResource>(), references = new Map<string, string>();
    const progress: DeliveryProgress = { digest: plan.confirmation.digest, present: 0, resources: {}, anchors: {}, verifiedWork: [] };
    const result = (state: Receipt['state']) => ({ receipt: { ...progress, state, ...(state === 'received' ? { review: 'not-established' as const } : {}) } as Receipt, found, references });
    try {
      for (const component of plan.components) {
        const resource = await this.findByIdentifier(component.resource.resourceType, component.key);
        if (!resource) continue;
        const expected = resolvedComponent(plan, component, references, progress.anchors);
        if (hasUnresolvedReferences(expected) || !verifyComponent(expected, resource)) return result('conflict');
        const nativeReference = `${resource.resourceType}/${resource.id}`, version = resourceVersion(resource);
        if (!version) return result('unknown');
        found.set(component.key, resource); progress.present++; progress.resources[component.key] = nativeReference;
        if (component.key.endsWith('.sources') || component.key.endsWith('.response')) {
          const pinned = await this.versionRead(nativeReference, version);
          if (!verifyComponent(expected, pinned)) return result('conflict');
          progress.anchors[component.key.endsWith('.sources') ? 'source' : 'response'] = { reference: nativeReference, version, hash: await digest(expected) };
          references.set(component.fullUrl, `${nativeReference}/_history/${version}`);
        } else references.set(component.fullUrl, nativeReference);
        if (resource.resourceType === 'Task') progress.verifiedWork.push(component.key.slice(component.key.indexOf('.work.') + 6));
      }
      if (!progress.present) return result('absent');
      if (found.size !== plan.components.length) return result('incomplete');
      const manifest = plan.components.at(-1)!, manifestResource = found.get(manifest.key)!;
      const versions = await this.history(`${manifestResource.resourceType}/${manifestResource.id}`);
      // FHIR history is newest first. The original version establishes creation, even after same-content rewrites.
      const original = versions.at(-1)!;
      const originalRead = await this.versionRead(`${original.resourceType}/${original.id}`, resourceVersion(original)!);
      if (!verifyComponent(resolvedComponent(plan, manifest, references, progress.anchors), originalRead)) return result('conflict');
      const meta = object(originalRead.meta) ? originalRead.meta : {};
      const receivedAt = typeof meta.lastUpdated === 'string' && Number.isFinite(Date.parse(meta.lastUpdated)) ? meta.lastUpdated : undefined;
      const complete = result('received');
      if (receivedAt && complete.receipt.state === 'received') complete.receipt.receivedAt = receivedAt;
      return complete;
    } catch (error) {
      return result(error instanceof ClinicalError && error.code === 'duplicate-conditional-identifier' ? 'conflict' : 'unknown');
    }
  }
  async reconcile(plan: HandoffPlan): Promise<Receipt> { return (await this.inspect(plan)).receipt; }
  /** One bounded anchor-first pass. Stable conditional keys converge after interruption or races. */
  async deliver(confirmation: ConfirmedSubmission, qualification: DeliveryQualification): Promise<DeliveryAttempt> {
    if (qualification.deliveryContract !== DELIVERY_CONTRACT || qualification.baseUrl !== this.config.baseUrl || qualification.mode !== this.config.mode || qualification.credentialFingerprint !== await digest(this.config.accessToken) || qualification.conditionalCreate !== true || qualification.conditionalConcurrency !== true || qualification.versionConflict !== true || qualification.versionHistory !== true || !Number.isFinite(Date.parse(qualification.qualifiedAt))) throw new ClinicalError('conditional-delivery-not-qualified');
    const plan = await this.deliveryPlan(confirmation);
    let inspection = await this.inspect(plan);
    if (!['absent', 'incomplete'].includes(inspection.receipt.state)) return { receipt: inspection.receipt, write: 'not-attempted' };
    let write: DeliveryAttempt['write'] = 'not-attempted';
    for (const component of plan.components) {
      if (inspection.found.has(component.key)) continue;
      // Before sealing, inspect every required component again, including mutable Task routing.
      if (component.key.endsWith('.manifest')) {
        inspection = await this.inspect(plan);
        if (inspection.receipt.state !== 'incomplete' || inspection.found.size !== plan.components.length - 1) return { receipt: inspection.receipt, write };
      }
      const expected = resolvedComponent(plan, component, inspection.references, inspection.receipt.anchors);
      if (hasUnresolvedReferences(expected)) return { receipt: { ...inspection.receipt, state: 'conflict' }, write };
      try {
        const winner = fhirResource((await this.request(component.resource.resourceType, 'POST', expected, { 'If-None-Exist': identifierQuery(component.key) })).body);
        if (!winner.id || !verifyComponent(expected, winner)) { write = 'outcome-unknown'; break; }
        write = 'acknowledged';
      } catch (error) {
        write = error instanceof TransportError && error.code === 'http' && [400, 401, 403, 409, 412, 422].includes(error.status ?? 0) ? 'rejected' : 'outcome-unknown';
        break;
      }
      inspection = await this.inspect(plan);
      if (!inspection.found.has(component.key) || !['incomplete', 'received'].includes(inspection.receipt.state)) return { receipt: inspection.receipt, write: 'outcome-unknown' };
    }
    return { receipt: await this.reconcile(plan), write };
  }
  async check(confirmation: ConfirmedSubmission): Promise<Receipt> { return this.reconcile(await this.deliveryPlan(confirmation)); }
  async checkAtomic(confirmation: ConfirmedSubmission): Promise<AtomicReceipt> { return this.reconcileAtomic(await this.deliveryPlan(confirmation)); }
}
export type AtomicReceipt = { state: 'received'; digest: string; resources: Record<string, string>; receivedAt?: string; review: 'not-established' } | { state: 'absent' | 'incomplete' | 'unknown' | 'conflict'; digest: string; present: number };
export type { Component };
