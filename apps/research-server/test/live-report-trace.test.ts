import { beforeEach, describe, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), writeFile: async (path: string, body: string, opts: { flag?: string; mode?: number }) => { if (opts.flag === 'wx' && files.has(path)) throw new Error('EEXIST'); expect(opts.mode).toBe(0o600); files.set(path, body); } }));
import { assertResume, exclusive, oneShot, reviewedDocument, sha, transcript, inspectGenerated, confirmsInvalidation, validateLedgerRow } from '../scripts/report-trace-boundary';
import { hashValue, type Evidence, type Finding } from '../../../packages/research-core/src/analysis';
import { DO_ENDPOINT } from '../../../packages/clinical-core/src/digitalocean';
beforeEach(() => files.clear());
const id = 'DO-R901', url = `${DO_ENDPOINT}/v1/chat/completions`, wire = JSON.stringify({ model: 'qwen3.8-max', max_tokens: 1024, messages: [] });
const request = { method: 'POST', body: wire, signal: new AbortController().signal };
const evidence: Evidence[] = [{ sessionId: 's', id: 'text', kind: 'self-report', start: 0, end: transcript.length, text: transcript, hash: sha(transcript), consentEpoch: 1, sharingEpoch: 1, retainApprovedExcerpts: false }, { sessionId: 's', id: 'screen', kind: 'screen-observation', start: 1250, end: 1251, text: null, hash: '1'.repeat(64), consentEpoch: 1, sharingEpoch: 1, retainApprovedExcerpts: false }];
const findings: Finding[] = [{ id: 'f1', type: 'self-report', statement: 'Participant said cost was hard to find.', supports: [`self-report:text:0:${transcript.length}`], counterevidence: [], limitations: 'Fictional transcript, not a behavior observation.' }, { id: 'f2', type: 'tentative-screen', statement: 'Visible panel in one selected frame.', supports: ['screen-observation:screen:1250:1251'], counterevidence: [], limitations: 'One fictional sampled frame; user behavior is unobserved.' }];
describe('root live report trace boundaries (offline only)', () => {
  it('does not report network/auth/timeout errors as confirmed source invalidation', async () => {
    for (const code of ['network', 'authentication', 'timeout']) expect(await confirmsInvalidation(async () => { throw new Error(code); })).toBe(false);
    expect(await confirmsInvalidation(async () => ({ state: 'ready', evidence: [] }))).toBe(false);
    expect(await confirmsInvalidation(async () => ({ state: 'invalidated', evidence: evidence }))).toBe(false);
    expect(await confirmsInvalidation(async () => ({ state: 'invalidated', evidence: [] }))).toBe(true);
  });
  it('requires the prospective ledger expiry cell to equal finalized preflight/config expiry', () => {
    const expiry = '2026-10-10T08:00:00.000Z', time = Date.parse(expiry), row = `| ${id} / date / root | DigitalOcean qwen3.8-max | synthetic trace | 1 call;64000 bytes;1024 tokens;15s | $1 credits | ${expiry} | root review | Prospective reserved |`;
    expect(validateLedgerRow(row, id, time).expiresAt).toBe(time);
    expect(() => validateLedgerRow(row, id, time + 1000)).toThrow('ledger expiry');
    expect(() => validateLedgerRow(row.replace(expiry, 'pending'), id, time)).toThrow('ledger expiry');
    expect(() => validateLedgerRow(row.replace('Prospective reserved', 'Reconciled'), id, time)).toThrow('Prospective');
  });
  it('fences a canonical phase before mutation and refuses another ID/path/replay', async () => {
    await exclusive(id, 'ANALYSIS-INTENT', { calls: 0 }); await expect(exclusive(id, 'ANALYSIS-INTENT', {})).rejects.toThrow('EEXIST');
    await expect(exclusive('../DO-R901', 'ANALYSIS-INTENT', {})).rejects.toThrow('Root trace ID'); await expect(exclusive(id, '../other', {})).rejects.toThrow('receipt phase'); expect(files.size).toBe(1);
  });
  it('never treats failed/unknown, expired or changed analysis identity as publishable', () => {
    const state = { id, phase: 'awaiting-root-review', analysisId: 'a', analysisHash: '2'.repeat(64), revision: 2, reviewUntil: 200 };
    const result = { ...state, state: 'awaiting-root-review', providerCalls: 1 }; expect(() => assertResume(id, result, state, 100)).not.toThrow();
    for (const changed of [{ state: 'unknown' }, { providerCalls: 0 }, { id: 'DO-R902' }, { analysisHash: '3'.repeat(64) }, { revision: 3 }]) expect(() => assertResume(id, { ...result, ...changed }, state, 100)).toThrow();
    expect(() => assertResume(id, result, state, 201)).toThrow('expiry');
  });
  it('requires an explicit document bound to exact current result/revision and inspectable sources', async () => {
    const row = { analysisId: 'a', state: 'ready', revision: 2, findings, evidence }, analysisHash = await hashValue(row);
    const doc = { id, analysisId: 'a', analysisRevision: 2, analysisHash, title: 'Root reviewed synthetic evidence', findings, excerpts: [{ evidenceId: findings[0].supports[0], text: transcript }], grants: [{ evidenceId: findings[1].supports[0], view: true, download: true }] };
    expect((await reviewedDocument(doc, id, row, analysisHash, 2)).title).toBe(doc.title);
    await expect(reviewedDocument(doc, id, { ...row, revision: 3 }, analysisHash, 2)).rejects.toThrow('Exact');
    await expect(reviewedDocument(doc, id, { ...row, findings: [{ ...findings[0], statement: 'Changed' }, findings[1]] }, analysisHash, 2)).rejects.toThrow('Exact');
    await expect(reviewedDocument({ ...doc, grants: [] }, id, row, analysisHash, 2)).rejects.toThrow('Every published citation');
    await expect(reviewedDocument({ ...doc, excerpts: [{ ...doc.excerpts[0], text: 'Invented quotation' }] }, id, row, analysisHash, 2)).rejects.toThrow('exact selected');
  });
  it('checks separate transcript/frame provenance without claiming generated content reviewed', () => {
    expect(() => inspectGenerated(findings, evidence)).not.toThrow(); expect(() => inspectGenerated([findings[0]], evidence)).toThrow('Separate'); expect(() => inspectGenerated(findings, [{ ...evidence[0], text: 'different' }, evidence[1]])).toThrow();
  });
  it('persists dispatch intent before exactly one transport, retains accounting and forbids retry', async () => {
    const order: string[] = [], response = vi.fn(async () => { order.push('network'); return Response.json({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }); }), observed = vi.fn();
    const fetcher = oneShot(response, 'unit-private-key', async body => { expect(sha(body)).toBe(sha(wire)); order.push('intent'); }, observed);
    await fetcher(url, request); expect(order).toEqual(['intent', 'network']); expect(observed.mock.calls[0][0]).toMatchObject({ complete: true, usage: { completion_tokens: 2 } });
    await expect(fetcher(url, request)).rejects.toThrow('One exact'); expect(response).toHaveBeenCalledOnce();
  });
  it('denies wider cap/endpoint or failed exclusive persistence before transport', async () => {
    const network = vi.fn(); const capped = oneShot(network, 'key', async () => {}, async () => {});
    await expect(capped(url, { ...request, body: wire.replace('1024', '2048') })).rejects.toThrow('limits');
    await expect(capped('https://elsewhere.invalid', request)).rejects.toThrow('DO dispatch');
    const persisted = oneShot(network, 'key', async () => { throw new Error('EEXIST'); }, async () => {}); await expect(persisted(url, request)).rejects.toThrow('EEXIST'); await expect(persisted(url, request)).rejects.toThrow('One exact'); expect(network).not.toHaveBeenCalled();
  });
  it('retains interrupted partial response without secrets, then freezes unknown with no retry', async () => {
    let sent = false; const prefix = '{"echo":"unit-private-key"', observed = vi.fn(), network = vi.fn(async () => new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(prefix)); } else c.error(new Error('interrupted')); } })));
    const fetcher = oneShot(network, 'unit-private-key', async () => {}, observed); await expect(fetcher(url, request)).rejects.toThrow('network');
    expect(observed.mock.calls[0][0]).toMatchObject({ complete: false, rawText: '{"echo":"[REDACTED]"', sha256: sha(prefix), capturedBytes: prefix.length });
    await expect(fetcher(url, request)).rejects.toThrow('One exact'); expect(network).toHaveBeenCalledOnce();
  });
  it('does not call an absent response body complete and bounds overflow', async () => {
    const saved = vi.fn(), empty = oneShot(async () => new Response(null), 'key', async () => {}, saved); await empty(url, request); expect(saved.mock.calls[0][0]).toMatchObject({ complete: false, capturedBytes: 0 });
    const overflow = oneShot(async () => new Response('x'.repeat(256_001)), 'key', async () => {}, saved); await expect(overflow(url, request)).rejects.toThrow('response-too-large'); expect(saved.mock.calls[1][0]).toMatchObject({ complete: false, capturedBytes: 256_000 });
  });
});
