/** Qualification-only boundaries; no credential loading, service startup or dispatch at import. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hashValue, validatePublication, validateCitationCoverage, findingSchema, type Evidence, type Finding } from '../../../packages/research-core/src/analysis';
import { TransportError, type Fetch } from '../../../packages/clinical-core/src/transport';
import { DO_ENDPOINT } from '../../../packages/clinical-core/src/digitalocean';

export const workspace = fileURLToPath(new URL('../../../', import.meta.url));
export const evidenceDirectory = resolve(workspace, 'docs/implementation/evidence');
export const ledgerPath = '/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md';
export const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export const transcript = 'I could not find the delivery cost.';
export const limits = Object.freeze({ model: 'qwen3.8-max', maxInputBytes: 64_000, maxOutputTokens: 1024, timeoutMs: 15_000, frames: 1 });
const paths = ['apps/research-server/scripts/qualify-live-reports.ts', 'apps/research-server/scripts/report-trace-boundary.ts', 'apps/research-server/src/analysis-config.ts', 'apps/research-server/src/analysis.ts', 'apps/research-server/src/frames.ts', 'apps/research-server/src/reports.ts', 'apps/research-server/src/server.ts', 'packages/research-core/src/analysis.ts', 'packages/research-capture/src/report-gateway.ts', 'packages/research-capture/src/gateway.ts', 'convex/researchAnalysis.ts', 'convex/researchReports.ts', 'convex/researchPortal.ts', 'convex/reportAccess.ts', 'packages/clinical-core/src/digitalocean.ts', 'packages/clinical-core/src/transport.ts'];
export async function bounded(path: string, maximum: number) { assert(isAbsolute(path), 'Absolute path required'); const info = await stat(path); assert(info.isFile() && info.size > 0 && info.size <= maximum, 'Artifact bound exceeded'); return readFile(path); }
export async function fingerprints() { return Promise.all(paths.map(async path => ({ path, sha256: sha(await bounded(resolve(workspace, path), 1_000_000)) }))); }
export function canonicalPath(id: string, phase: string) { assert(/^DO-R[1-9][0-9]*$/.test(id), 'Root trace ID required'); assert(/^[A-Z-]+$/.test(phase), 'Invalid receipt phase'); return resolve(evidenceDirectory, `${id}-${phase}.json`); }
export async function exclusive(id: string, phase: string, value: unknown) { await writeFile(canonicalPath(id, phase), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
export function validateLedgerRow(row: string, id: string, expiresAt: number) {
  assert(row.startsWith(`| ${id} /`), 'Ledger identity differs');
  const cells = row.split('|').slice(1, -1).map(s => s.trim()), cap = (cells[3] ?? '').replace(/[\s,]/g, '').toLowerCase();
  assert(cells.length === 8 && cells[1].includes(limits.model) && /^(reserved|prospective)/i.test(cells[7]) && /(?:one|1)(?:inference)?call/.test(cap) && cap.includes('64000') && cap.includes('1024') && /15s|15000ms/.test(cap), 'Prospective one-call limits required');
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(cells[5]) && Number.isSafeInteger(expiresAt) && Date.parse(cells[5]) === expiresAt, 'Explicit ledger expiry must equal finalized preflight expiry');
  return { path: ledgerPath, rowHash: sha(row), expiresAt };
}
export async function ledger(id: string, expiresAt: number) {
  canonicalPath(id, 'PREFLIGHT');
  const rows = (await bounded(ledgerPath, 1_000_000)).toString('utf8').split('\n').filter(row => row.startsWith(`| ${id} /`));
  assert(rows.length === 1, 'Unique primary ledger reservation required'); return validateLedgerRow(rows[0], id, expiresAt);
}
export async function confirmsInvalidation(read: () => Promise<any>): Promise<boolean> {
  try { const row = await read(); return row?.state === 'invalidated' && Array.isArray(row.evidence) && row.evidence.length === 0; }
  catch { return false; } // Network/auth/timeout failures do not prove source invalidation.
}
export async function fixture() {
  const qualifiedBytes = await bounded(resolve(evidenceDirectory, 'DO-V1.json'), 256_000), qualified = JSON.parse(qualifiedBytes.toString());
  assert(qualified.id === 'DO-V1' && qualified.state === 'single-fixture-qualified' && qualified.calls === 1 && qualified.model === limits.model, 'Accepted DO-V1 evidence required');
  const source = qualified.source, bytes = await bounded(resolve(evidenceDirectory, 'DO-V1-CANDIDATE/DO-V1-SYNTHETIC.webm'), 8_000_000), frame = await bounded(resolve(evidenceDirectory, 'DO-V1-CANDIDATE/DO-V1-FRAME.jpg'), 120_000);
  assert(sha(bytes) === source.mediaHash && bytes.length === source.bytes && sha(frame) === source.imageHash && frame.length === source.imageBytes && source.atMs === 1250 && source.offsetMs === 250 && source.segmentStartMs === 1000 && source.segmentEndMs === 2000, 'Frozen DO-V1 source/frame provenance differs');
  return { bytes, source, qualificationHash: sha(qualifiedBytes) };
}
export function assertResume(id: string, result: any, state: any, now = Date.now()) {
  assert(result.id === id && result.state === 'awaiting-root-review' && result.providerCalls === 1 && state.id === id && state.phase === 'awaiting-root-review', 'Only the same completed analysis phase can publish');
  assert(state.analysisId === result.analysisId && state.analysisHash === result.analysisHash && state.revision === result.revision && state.reviewUntil === result.reviewUntil && state.reviewUntil > now, 'Review identity/expiry differs');
}
export function assertReviewWindow(state: { reviewUntil?: number }, now = Date.now()) {
  assert(Number.isSafeInteger(state.reviewUntil) && state.reviewUntil! > now, 'Root review window expired; explicit cleanup required');
}
export const reviewSchema = z.object({ id: z.string(), analysisId: z.string(), analysisRevision: z.number().int(), analysisHash: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().min(1).max(200), findings: z.array(findingSchema).min(1).max(12), excerpts: z.array(z.object({ evidenceId: z.string(), text: z.string() }).strict()).max(24), grants: z.array(z.object({ evidenceId: z.string(), view: z.boolean(), download: z.boolean() }).strict()).max(24) }).strict();
export async function reviewedDocument(raw: unknown, id: string, row: any, expectedHash: string, expectedRevision: number) {
  const doc = reviewSchema.parse(raw);
  assert(doc.id === id && doc.analysisId === row.analysisId && doc.analysisRevision === expectedRevision && row.revision === expectedRevision && row.state === 'ready' && doc.analysisHash === expectedHash && await hashValue(row) === expectedHash, 'Exact analyzed result/revision must be reviewed');
  validatePublication(doc.findings, row.evidence as Evidence[], doc.excerpts, doc.grants); validateCitationCoverage(doc.findings, doc.excerpts, doc.grants); return doc;
}
/** Same bounded response semantics as DO-V1, isolated here from its frozen harness. */
export function oneShot(fetcher: Fetch, key: string, before: (wire: string) => Promise<void>, after: (receipt: unknown) => Promise<void>): Fetch {
  let used = false;
  return async (url, init) => {
    assert(!used && String(url) === `${DO_ENDPOINT}/v1/chat/completions` && init?.method === 'POST' && typeof init.body === 'string', 'One exact DO dispatch only');
    const wire = init.body; assert(Buffer.byteLength(wire) <= limits.maxInputBytes && JSON.parse(wire).max_tokens === limits.maxOutputTokens && JSON.parse(wire).model === limits.model, 'Reserved wire limits differ');
    used = true; await before(wire); // Exclusive intent persisted before the sole external request.
    const response = await fetcher(url, init), chunks: Buffer[] = []; let bytes = 0, complete = false, overflow = false, interrupted = false;
    const reader = response.body?.getReader();
    try { if (reader) for (;;) { const next = await reader.read(); if (next.done) { complete = true; break; } chunks.push(Buffer.from(next.value.slice(0, Math.max(0, 256_000 - bytes)))); bytes += next.value.length; if (bytes > 256_000) { overflow = true; break; } } } catch { interrupted = true; }
    finally { void reader?.cancel().catch(() => undefined); }
    const raw = Buffer.concat(chunks), text = raw.toString('utf8').split(key).join('[REDACTED]'); let usage: unknown = null;
    try { const u = JSON.parse(text).usage; if (u) usage = { prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, total_tokens: u.total_tokens ?? null }; } catch { /* bounded raw evidence remains authoritative */ }
    await after({ status: response.status, complete, capturedBytes: raw.length, sha256: sha(raw), rawText: text, usage });
    if (overflow) throw new TransportError('response-too-large'); if (interrupted) throw new TransportError(init.signal?.aborted ? 'timeout' : 'network');
    return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  };
}
export function inspectGenerated(findings: Finding[], evidence: Evidence[]) {
  // Mechanical provenance checks are preparation for root review, never a semantic approval.
  const text = evidence.find(e => e.kind === 'self-report'), screen = evidence.find(e => e.kind === 'screen-observation'); assert(text?.text === transcript && screen && evidence.length === 2);
  assert(findings.some(f => f.type === 'self-report' && f.supports.includes(`self-report:${text.id}:${text.start}:${text.end}`)) && findings.some(f => f.type === 'tentative-screen' && f.supports.includes(`screen-observation:${screen.id}:${screen.start}:${screen.end}`)), 'Separate source-bound transcript and frame findings required');
  assert(findings.every(f => f.limitations.trim().length > 0), 'Each generated finding needs limitations');
}
