import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedContextSources, frozenPriorContextSchema, loadPriorContext } from '../src/prior-context.js';
import { appointment, bundle, clientFor, json, patientReference, plan, prior, productionPrior, recordedAt, sourceReference } from './fixtures/prior-context.js';
import { NATIVE_EXTENSION } from '../../clinic-content/src/native-questionnaire.js';
import { fromNativeQuestionnaireResponse, type NativeQuestionnaireResponse } from '../../clinical-core/src/questionnaire-response.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });
const empty = { context: {}, sources: [] };

describe('bounded prior record context', () => {
  it('accepts an actual production-created guided confirmed partial capture and its compiled source document', async () => {
    const p = await productionPrior();
    expect(p.confirmation.submission.completeness).toBe('partial');
    expect(p.confirmation.submission.questionnaireCapture?.reviewBinding).toBeUndefined();
    const result = await loadPriorContext(clientFor({ ...p, appointment: appointment() }).client, patientReference, 'pre-visit');
    expect(result.context.priorSubmission).toMatchObject({ item: 'My knees hurt when I walk.', topicId: 'Q02', path: 'concern' });
    expect(result.context.appointment?.priorUpdateAt).toBe(p.confirmation.submission.confirmedAt);
  });
  it('loads verified upcoming appointment and exact confirmed patient concern without creating current answers', async () => {
    const p = await prior(), f = clientFor({ ...p, appointment: appointment() });
    const result = await loadPriorContext(f.client, patientReference, 'pre-visit');
    expect(result.context.appointment).toEqual({ reference: 'Appointment/prior-appointment', version: '2', startsAt: '2026-10-20T15:00:00.000Z', timezone: 'America/New_York', recordedAt, priorUpdateAt: recordedAt });
    expect(result.context.priorSubmission).toMatchObject({ reference: 'QuestionnaireResponse/prior-response', version: '1', recordedAt, item: 'My knees hurt when I walk.', topicId: 'Q02', path: 'concern', sourceDocumentReference: sourceReference });
    expect(result.sources.map(source => source.kind)).toEqual(['prior-submission', 'appointment']);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    const urls = f.fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0].searchParams.get('subject')).toBe(patientReference);
    expect(urls[2].searchParams.get('patient')).toBe(patientReference);
    expect(urls[2].searchParams.get('date')).toBe('ge2026-10-16T12:00:00.000Z');
    expect(urls.every(url => url.hostname === 'localhost')).toBe(true);
    expect(frozenPriorContextSchema.safeParse({ ...result, loadedAt: new Date().toISOString() }).success).toBe(true);
  });
  it('uses the first exact patient-stated medicine name when no current symptom item is present', async () => {
    const p = await prior('Q08', 'Metformin'), f = clientFor(p);
    const result = await loadPriorContext(f.client, patientReference, 'pre-visit');
    expect(result.context.priorSubmission).toMatchObject({ item: 'Metformin', topicId: 'Q08', path: 'medicines[medicine-1].name' });
    expect(result.context.appointment).toBeUndefined();
  });
  it('preserves missing resources and missing timezone/date explicitly', async () => {
    expect(await loadPriorContext(clientFor().client, patientReference, 'pre-visit')).toEqual(empty);
    const a = appointment(); delete a.extension;
    const result = await loadPriorContext(clientFor({ appointment: a }).client, patientReference, 'pre-visit');
    expect(result.context.appointment).toMatchObject({ timezone: 'Not recorded' });
    expect(result.context.appointment?.priorUpdateAt).toBeUndefined();
    expect(result.context.priorSubmission).toBeUndefined();
  });
  it('does not retrieve historical clinical context for unrelated workflows', async () => {
    const f = clientFor();
    for (const scenario of ['first-intake', 'non-visit', 'billing', 'scheduling', 'refill'] as const) expect(await loadPriorContext(f.client, patientReference, scenario)).toEqual(empty);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('aborts the actual transport at 5 seconds and makes no second attempt', async () => {
    let signal: AbortSignal | null | undefined;
    const f = clientFor({}, (_path, init) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = loadPriorContext(f.client, patientReference, 'pre-visit');
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(empty);
    expect(signal?.aborted).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('discards a successfully loaded prior submission when a later appointment search fails', async () => {
    const p = await prior(), f = clientFor(p, path => path.startsWith('Appointment?') ? json({}, 403) : undefined);
    expect(await loadPriorContext(f.client, patientReference, 'pre-visit')).toEqual(empty);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    ['other patient', (resource: Record<string, unknown>) => { resource.subject = { reference: 'Patient/unrelated' }; }],
    ['unconfirmed', (resource: Record<string, unknown>) => { resource.status = 'in-progress'; }],
    ['missing version', (resource: Record<string, unknown>) => { (resource.meta as Record<string, unknown>).versionId = ''; }],
    ['invalid date', (resource: Record<string, unknown>) => { resource.authored = 'yesterday'; }],
    ['future date', (resource: Record<string, unknown>) => { resource.authored = '2027-01-01T00:00:00.000Z'; }],
    ['unsupported questionnaire', (resource: Record<string, unknown>) => { resource.questionnaire = 'https://unrelated.example/Questionnaire/other'; }],
    ['unversioned source', (resource: Record<string, unknown>) => { (resource.extension as Record<string, unknown>[]).find(extension => extension.url === `${NATIVE_EXTENSION}source-document`)!.valueReference = { reference: 'DocumentReference/prior-sources' }; }],
  ])('rejects malformed prior response: %s', async (_name, mutate) => {
    const p = await prior(); mutate(p.questionnaire);
    expect(await loadPriorContext(clientFor({ ...p, appointment: appointment() }).client, patientReference, 'pre-visit')).toEqual(empty);
  });
  it.each(['unreviewed', 'assistant', 'inferred', 'another patient'] as const)('never reads %s text back as a confirmed patient item', async mode => {
    const p = await prior();
    if (mode === 'unreviewed') p.sourceData.sources[0].channel = 'unreviewed-transcript';
    if (mode === 'assistant') p.sourceData.sources[0].kind = 'assistant-statement';
    if (mode === 'inferred') p.sourceData.sources[0].text = 'A different phrase with no exact concern value.';
    if (mode === 'another patient') p.sourceData.sources[0].patient = 'Patient/unrelated';
    p.replaceSource();
    const result = await loadPriorContext(clientFor({ ...p, appointment: appointment() }).client, patientReference, 'pre-visit');
    if (mode !== 'inferred') expect(result).toEqual(empty);
    else { expect(result.context.priorSubmission?.item).toBeUndefined(); expect(result.context.priorSubmission?.recordedAt).toBe(recordedAt); }
  });
  it('rejects mismatched source versions and ambiguous search resources', async () => {
    const p = await prior(); p.source.meta = { ...(p.source.meta as object), versionId: '2' };
    expect(await loadPriorContext(clientFor(p).client, patientReference, 'pre-visit')).toEqual(empty);
    const b = bundle(appointment()); b.entry.push(...b.entry); b.total = 2;
    expect(await loadPriorContext(clientFor({}, path => path.startsWith('Appointment?') ? json(b) : undefined).client, patientReference, 'pre-visit')).toEqual(empty);
  });
  it.each(['routing omitted', 'forged applicability', 'unsupported review binding'] as const)('rejects semantically unsupported native capture: %s', async mutation => {
    const p = await prior();
    if (mutation === 'forged applicability') (p.questionnaire.item as Record<string, unknown>[]).push({ linkId: 'FORGED.__applicability', answer: [{ valueString: 'applicable' }] });
    else {
      const encoded = (p.questionnaire.extension as Record<string, unknown>[]).find(extension => extension.url === `${NATIVE_EXTENSION}capture-header`)!;
      const header = JSON.parse(String(encoded.valueString));
      if (mutation === 'routing omitted') header.routingDecisions = [];
      else header.reviewBinding = 'a'.repeat(64);
      encoded.valueString = JSON.stringify(header);
    }
    expect(await loadPriorContext(clientFor({ ...p, appointment: appointment() }).client, patientReference, 'pre-visit')).toEqual(empty);
  });
  it.each(['digest', 'identifier', 'date'] as const)('rejects prior source %s that does not match the response confirmation', async mutation => {
    const p = await prior();
    if (mutation === 'digest') (p.source.meta as { tag: { code: string }[] }).tag[0].code = 'b'.repeat(64);
    if (mutation === 'identifier') p.source.identifier = [{ system: 'urn:corvo:clinical:handoff-component', value: 'another-submission.v1.sources' }];
    if (mutation === 'date') p.source.date = '2026-09-30T12:00:00.000Z';
    expect(await loadPriorContext(clientFor({ ...p, appointment: appointment() }).client, patientReference, 'pre-visit')).toEqual(empty);
  });
  it('never credits a Q08 child from an unreviewed parent collection even when the child source was reviewed', async () => {
    const p = await prior('Q08', 'Metformin');
    p.sourceData.sources.push({ ...p.sourceData.sources[0], id: 'raw-parent', text: 'A raw medicine-list mention.', channel: 'unreviewed-transcript' });
    p.replaceSource();
    const topic = (p.questionnaire.item as Record<string, unknown>[]).find(item => item.linkId === 'Q08')!;
    const medicines = (topic.item as Record<string, unknown>[]).find(item => item.linkId === 'Q08.medicines.__container')!;
    const state = (medicines.item as Record<string, unknown>[]).find(item => item.linkId === 'Q08.medicines.__state')!;
    (state.extension as Record<string, unknown>[]).find(extension => extension.url === `${NATIVE_EXTENSION}source-turn`)!.valueString = 'raw-parent';
    // Prove the response tree itself decodes; source-channel validation then rejects the
    // raw ancestor even though the exact name child points to a reviewed patient source.
    const decoded = await fromNativeQuestionnaireResponse(p.questionnaire as unknown as NativeQuestionnaireResponse, new Set(['prior-turn', 'raw-parent']));
    expect(decoded.topics.Q08.answers.medicines).toMatchObject({ state: 'known', sourceIds: ['raw-parent'], items: [{ answers: { name: { sourceIds: ['prior-turn'] } } }] });
    const result = await loadPriorContext(clientFor(p).client, patientReference, 'pre-visit');
    expect(result).toEqual(empty);
  });
  it('loads only exact inline final authored plans and truncates patient text without a marker', async () => {
    const authored = 'x'.repeat(8001), p = plan(authored), f = clientFor({ plan: p });
    const result = await loadPriorContext(f.client, patientReference, 'post-visit');
    expect(result.context.plan).toEqual({ reference: 'DocumentReference/prior-plan', version: '3', author: 'Synthetic clinician', recordedAt, text: authored.slice(0, 8000), truncated: true });
    expect(result.context.plan?.text).not.toContain('(truncated)');
    expect(result.sources).toEqual([{ reference: 'DocumentReference/prior-plan', version: '3', recordedAt, kind: 'plan', truncated: true }]);
    expect(await authorizedContextSources(f.client, patientReference, result.context)).toEqual(result.sources);
  });
  it('never follows external attachments or labels a missing inline body as a plan', async () => {
    const p = plan(); p.content = [{ attachment: { contentType: 'text/plain', url: 'https://records.example/private-plan' } }];
    const f = clientFor({ plan: p });
    expect(await loadPriorContext(f.client, patientReference, 'post-visit')).toEqual(empty);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls.every(([url]) => new URL(String(url)).hostname === 'localhost')).toBe(true);
  });
  it.each([
    ['patient mismatch', (resource: Record<string, unknown>) => { resource.subject = { reference: 'Patient/unrelated' }; }],
    ['not final', (resource: Record<string, unknown>) => { resource.docStatus = 'preliminary'; }],
    ['no author', (resource: Record<string, unknown>) => { resource.author = []; }],
    ['invalid encoding', (resource: Record<string, unknown>) => { resource.content = [{ attachment: { contentType: 'text/plain', data: 'not base64!' } }]; }],
  ])('fails closed on a malformed plan: %s', async (_name, mutate) => {
    const p = plan(); mutate(p);
    expect(await loadPriorContext(clientFor({ plan: p }).client, patientReference, 'post-visit')).toEqual(empty);
  });
  it('shows source audit metadata only after the named staff client can read that immutable patient version', async () => {
    const f = clientFor({ plan: plan() }), result = await loadPriorContext(f.client, patientReference, 'post-visit');
    const denied = clientFor({}, () => json({}, 403));
    expect(await authorizedContextSources(denied.client, patientReference, result.context)).toEqual([]);
    const wrong = plan(); wrong.subject = { reference: 'Patient/unrelated' };
    expect(await authorizedContextSources(clientFor({ plan: wrong }).client, patientReference, result.context)).toEqual([]);
    expect(await authorizedContextSources(f.client, patientReference, result.context)).toMatchObject([{ reference: 'DocumentReference/prior-plan', recordedAt, kind: 'plan' }]);
  });
  it('hides prior-submission audit when the QR is readable but its immutable source document is denied', async () => {
    const p = await prior(), result = await loadPriorContext(clientFor(p).client, patientReference, 'pre-visit');
    expect(result.context.priorSubmission).toBeDefined();
    const named = clientFor(p, path => path === sourceReference ? json({}, 403) : undefined);
    expect(await authorizedContextSources(named.client, patientReference, result.context)).toEqual([]);
    expect(named.fetcher).toHaveBeenCalledTimes(2);
  });
});
