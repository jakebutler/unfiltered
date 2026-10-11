import { canonicalJson, digest, type ReviewAction } from '../../clinical-core/src/domain.js';
import { ACTION_HISTORY_EXTENSION, resourceVersion, type FhirResource } from '../../clinical-core/src/fhir.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { ApiFailure } from './types.js';
import { object } from './store.js';

export interface ActionScope { project: string; task: string; patient: string; submissionId: string; version: number; digest: string; workId: string; owner: string; }
export interface SignedAction extends ReviewAction {
  schema: 1; actionId: string; fingerprint: string; scope: ActionScope; priorTaskVersion: string;
  previousHistoryDigest: string; name: string; membership: string; note: string; signature: string;
}
const fail = () => new ApiFailure('work-history-integrity-unavailable', 503, true);
const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
const unsigned = (action: SignedAction) => { const { signature: _, ...payload } = action; return payload; };
async function key(secret: string) {
  if (!secret || secret.length < 32) throw fail();
  return crypto.subtle.importKey('raw', encoder.encode(`corvo-task-action:v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export function taskStatus(outcome: ReviewAction['outcome']) { return outcome === 'resolved' ? 'completed' : outcome === 'declined' ? 'rejected' : outcome === 'needs-information' ? 'on-hold' : 'in-progress'; }
export function actionHistory(task: FhirResource): SignedAction[] {
  const extensions = task.extension;
  if (extensions !== undefined && !Array.isArray(extensions)) throw fail();
  const history = (extensions as Array<Record<string, unknown>> | undefined)?.filter(extension => extension.url === ACTION_HISTORY_EXTENSION) ?? [];
  if (history.length > 1) throw fail();
  try {
    const entries = history.length ? JSON.parse(String(history[0].valueString)) : [];
    if (!Array.isArray(entries) || entries.length > 32) throw fail();
    return entries;
  } catch { throw fail(); }
}
export async function signAction(secret: string, payload: Omit<SignedAction, 'signature'>): Promise<SignedAction> {
  return { ...payload, signature: hex(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(canonicalJson(payload)))) };
}
async function verifyEntries(entries: SignedAction[], scope: ActionScope, secret: string) {
  const ids = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || entry.schema !== 1 || !/^[a-f0-9-]{36}$/.test(entry.actionId) || ids.has(entry.actionId) || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !/^[a-f0-9]{64}$/.test(entry.signature) || canonicalJson(entry.scope) !== canonicalJson(scope) || entry.submissionId !== scope.submissionId || entry.version !== scope.version || entry.digest !== scope.digest || entry.workId !== scope.workId || !entry.member?.startsWith('Practitioner/') || !entry.membership || !entry.name || !entry.note || entry.note.length > 4000 || !Number.isFinite(Date.parse(entry.at)) || !['reviewed', 'needs-information', 'declined', 'resolved'].includes(entry.outcome) || !/^[A-Za-z0-9.-]{1,64}$/.test(entry.priorTaskVersion) || entry.previousHistoryDigest !== await digest(entries.slice(0, index))) throw fail();
    ids.add(entry.actionId);
    const bytes = Uint8Array.from(entry.signature.match(/../g)!, value => Number.parseInt(value, 16));
    if (!await crypto.subtle.verify('HMAC', await key(secret), bytes, encoder.encode(canonicalJson(unsigned(entry))))) throw fail();
  }
}
/** Verify signatures AND native version lineage, detecting removal or replay of an old signed prefix. */
export async function verifiedTaskHistory(client: MedplumClient, task: FhirResource, scope: ActionScope, secret: string) {
  const versions = await client.history(scope.task), currentVersion = resourceVersion(task);
  if (!currentVersion || resourceVersion(versions[0]) !== currentVersion || canonicalJson(versions[0]) !== canonicalJson(task)) throw fail();
  const entries = actionHistory(task);
  await verifyEntries(entries, scope, secret);
  let previous: SignedAction[] = [];
  const introduced = new Map<string, string>();
  for (const native of [...versions].reverse()) {
    // Independently version-read every bounded resource. History list alone is not an attribution proof.
    const read = await client.versionRead(scope.task, resourceVersion(native)!);
    if (canonicalJson(read) !== canonicalJson(native)) throw fail();
    const next = actionHistory(read);
    await verifyEntries(next, scope, secret);
    if (next.length < previous.length || canonicalJson(next.slice(0, previous.length)) !== canonicalJson(previous) || next.length > previous.length + 1) throw fail();
    if (next.length > previous.length) {
      const entry = next.at(-1)!;
      const preceding = versions.find(row => resourceVersion(row) === entry.priorTaskVersion);
      if (!preceding || canonicalJson(actionHistory(preceding)) !== canonicalJson(previous) || read.status !== taskStatus(entry.outcome) || canonicalJson(read.businessStatus) !== canonicalJson({ text: entry.outcome })) throw fail();
      const chronological = [...versions].reverse(), at = chronological.findIndex(row => resourceVersion(row) === resourceVersion(native));
      if (at < 1 || resourceVersion(chronological[at - 1]) !== entry.priorTaskVersion) throw fail();
      introduced.set(entry.actionId, resourceVersion(read)!);
    }
    previous = next;
  }
  if (canonicalJson(previous) !== canonicalJson(entries)) throw fail();
  const latest = entries.at(-1);
  const attributed = !!latest && introduced.get(latest.actionId) === currentVersion && task.status === taskStatus(latest.outcome) && canonicalJson(task.businessStatus) === canonicalJson({ text: latest.outcome });
  const external = latest ? !attributed : task.status !== 'requested' || task.businessStatus !== undefined || !!(task.extension as Array<Record<string, unknown>> | undefined)?.some(extension => extension.url === 'https://corvo.example/fhir/StructureDefinition/clinic-review');
  return { entries, latest: attributed ? latest : undefined, external };
}
export function appendAction(task: FhirResource, action: SignedAction): FhirResource {
  const entries = actionHistory(task);
  if (entries.length >= 32) throw new ApiFailure('work-history-limit', 409);
  return { ...task, status: taskStatus(action.outcome), businessStatus: { text: action.outcome }, extension: [...((task.extension as Array<Record<string, unknown>> | undefined) ?? []).filter(extension => extension.url !== ACTION_HISTORY_EXTENSION), { url: ACTION_HISTORY_EXTENSION, valueString: canonicalJson([...entries, action]) }] };
}
