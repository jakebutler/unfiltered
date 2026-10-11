import { digest } from '../../packages/clinical-core/src/domain.js';
import type { MedplumClient } from '../../packages/clinical-core/src/medplum.js';
import type { Fetch } from '../../packages/clinical-core/src/transport.js';

export interface FixtureIntent {
  key: string;
  resourceType: string;
  state: 'intent' | 'acknowledged' | 'confirmed' | 'outcome-unknown' | 'readback-unconfirmed';
  requestDigest: string;
  identifier?: { system: string; value: string };
  securityContext?: string;
  reference?: string;
  versionId?: string;
  reconciliation: string;
}
const system = 'urn:corvo:deployment:qualification';
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(value);

/** The evidence sink must persist synchronously. An existing intent is never dispatched twice. */
export function deploymentFixtures(client: MedplumClient, fetcher: Fetch, journal: FixtureIntent[], save: () => void) {
  const intent = async (key: string, resourceType: string, body: unknown, extra: Partial<FixtureIntent>) => {
    if (journal.some(row => row.key === key)) throw new Error('fixture-intent-already-exists-reconcile-without-replay');
    const row: FixtureIntent = { key, resourceType, state: 'intent', requestDigest: await digest(body), reconciliation: 'Read by stable identifier before any further action; never blindly repeat the POST.', ...extra };
    journal.push(row); save(); return row;
  };
  const acknowledge = (row: FixtureIntent, resource: Record<string, unknown>) => {
    if (resource.resourceType !== row.resourceType || !nativeId(resource.id)) throw new Error('fixture-native-reference-missing');
    row.reference = `${row.resourceType}/${resource.id}`;
    const meta = resource.meta as { versionId?: unknown } | undefined;
    if (nativeId(meta?.versionId)) row.versionId = meta.versionId;
    row.state = 'acknowledged'; save();
  };
  const failed = (row: FixtureIntent) => { row.state = row.reference ? 'readback-unconfirmed' : 'outcome-unknown'; save(); };
  return {
    async resource(key: string, resource: Record<string, unknown> & { resourceType: 'Task' | 'DocumentReference' }) {
      const identifier = { system, value: key };
      const body = { ...resource, identifier: [identifier] };
      const row = await intent(key, resource.resourceType, body, { identifier });
      try {
        const result = await client.request(resource.resourceType, 'POST', body, { 'If-None-Exist': `identifier=${encodeURIComponent(`${system}|${key}`)}` });
        acknowledge(row, result.body as Record<string, unknown>);
        const readback = (await client.request(row.reference!)).body as Record<string, unknown>;
        const observed = Object.fromEntries(Object.keys(body).map(key => [key, readback[key]]));
        if (readback.id !== row.reference!.split('/')[1] || await digest(observed) !== row.requestDigest) throw new Error('fixture-readback-mismatch');
        row.state = 'confirmed'; save();
        return { id: readback.id as string, reference: row.reference! };
      } catch (error) { failed(row); throw error; }
    },
    async binary(key: string, securityContext: string, text: string) {
      const row = await intent(key, 'Binary', text, { securityContext, reconciliation: 'Binary has no supported identifier search. If its acknowledgement is unknown, retain this unique content marker, digest and security context for native operator inspection; do not replay. Once known, read the native reference.' });
      try {
        const response = await fetcher(new URL('Binary', client.config.baseUrl).href, { method: 'POST', headers: { Authorization: `Bearer ${client.config.accessToken}`, 'Content-Type': 'text/plain', 'X-Security-Context': securityContext }, body: text });
        if (!response.ok) throw new Error(`binary-control-http-${response.status}`);
        acknowledge(row, await response.json() as Record<string, unknown>);
        const readback = await fetcher(new URL(row.reference!, client.config.baseUrl).href, { headers: { Authorization: `Bearer ${client.config.accessToken}`, Accept: 'text/plain' } });
        if (!readback.ok || await readback.text() !== text) throw new Error('binary-control-readback-mismatch');
        row.state = 'confirmed'; save();
        return { id: row.reference!.split('/')[1], reference: row.reference! };
      } catch (error) { failed(row); throw error; }
    },
  };
}
