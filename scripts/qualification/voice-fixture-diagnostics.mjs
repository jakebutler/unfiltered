import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

/** Fixture-only timing. No queries, request/response bodies, headers or credentials. */
export function fixtureFetchDiagnostics(origin, report, save, fetcher = fetch) {
  const target = new URL(origin);
  assert(['localhost', '127.0.0.1'].includes(target.hostname), 'diagnostics require loopback');
  report.dependencies ??= [];
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, target.origin, 'only configured loopback Medplum may receive requests');
    assert(report.dependencies.length < 2500, 'fixture diagnostic request bound');
    const start = performance.now();
    const item = { method: init?.method ?? 'GET', path: url.pathname, at: new Date().toISOString() };
    report.dependencies.push(item); save();
    const elapsed = () => Math.round((performance.now() - start) * 10) / 10;
    try {
      const response = await fetcher(input, { ...init, redirect: 'error' });
      item.status = response.status; item.headersMs = elapsed(); save();
      if (!response.body) { item.completeMs = elapsed(); save(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { item.completeMs = elapsed(); save(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { item.completeMs = elapsed(); item.error = init?.signal?.aborted ? 'aborted-body' : 'body-error'; save(); controller.error(error); }
        },
        async cancel(reason) { item.canceledMs = elapsed(); save(); await reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { item.completeMs = elapsed(); item.error = init?.signal?.aborted ? 'aborted-fetch' : 'fetch-error'; save(); throw error; }
  };
}

export function fixtureAdmissionDiagnostics(admission, report, save) {
  report.admissions ??= [];
  return { async reserve(input) {
    assert(report.admissions.length < 100, 'fixture diagnostic admission bound');
    const started = performance.now();
    const item = { provider: input.provider, requestId: input.requestId, startedAt: new Date().toISOString() };
    report.admissions.push(item); save();
    const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
    try {
      const lease = await admission.reserve(input);
      item.reservedMs = elapsed(); save();
      return { async settle(outcome) {
        item.settlementStartedMs = elapsed(); item.outcome = outcome; save();
        try { await lease.settle(outcome); item.settledMs = elapsed(); save(); }
        catch (error) { item.settlementFailedMs = elapsed(); item.settlementError = safeCode(error); save(); throw error; }
      } };
    } catch (error) { item.failedMs = elapsed(); item.error = safeCode(error); save(); throw error; }
  } };
}
function safeCode(error) {
  return typeof error?.code === 'string' && /^[a-z-]{1,70}$/.test(error.code) ? error.code : 'fixture-operation-failed';
}
