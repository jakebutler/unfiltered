import { sparseExtractionProposer } from './adaptive-extraction-sparse-provider.js';
import { AdmissionError, noUnits } from './provider-admission.js';
import type { ProviderAdmission } from './bounded-providers.js';
import type { DigitalOceanConfig } from '../../clinical-core/src/digitalocean.js';
import { digitalOceanStream, DigitalOceanStreamFailure, fullStreamLimits, prepareDigitalOceanStreamRequest } from '../../clinical-core/src/digitalocean-stream.js';
import type { Fetch } from '../../clinical-core/src/transport.js';

/** Dormant factory building block. Admission is spend authority, never clinical qualification. */
export function boundedSparseExtractionProposer(
  config: Omit<DigitalOceanConfig, 'responseFormat'>,
  admission: ProviderAdmission,
  fetcher: Fetch = fetch,
) {
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30000)
    throw new AdmissionError('invalid-adaptive-provider-timeout');
  const bounded = { ...config, maxRequestBytes: Math.min(config.maxRequestBytes ?? 128000, 128000) };
  return { async extract(...args: Parameters<ReturnType<typeof sparseExtractionProposer>['extract']>) {
    const [context, , options] = args;
    return sparseExtractionProposer(bounded, wireConfig => ({ async generate(messages, streamOptions) {
      // Include schema and stream options; message-content bytes alone undercount the wire.
      const prepared = await prepareDigitalOceanStreamRequest(wireConfig, messages);
      options.signal.throwIfAborted();
      const lease = await admission.reserve({ provider: 'digitalocean', requestId: context.binding.operationId, sessionId: context.binding.sessionId,
        units: { ...noUnits(), requests: 1, inputBytes: prepared.requestBytes, outputTokens: wireConfig.maxOutputTokens } });
      let settled = false;
      const settle = (outcome: Parameters<typeof lease.settle>[0]) => {
        if (settled) return;
        settled = true;
        try { void Promise.resolve(lease.settle(outcome)).catch(() => undefined); } catch { /* Full reservation remains charged. */ }
      };
      if (options.signal.aborted) { settle('failed'); options.signal.throwIfAborted(); }
      try {
        const result = await digitalOceanStream(wireConfig, fetcher, undefined, fullStreamLimits(wireConfig.maxOutputTokens)).generate(messages, streamOptions);
        settle('completed');
        return result;
      } catch (error) {
        settle(error instanceof DigitalOceanStreamFailure && error.receipt.providerExecution === 'completed' ? 'completed' : 'unknown');
        throw error;
      }
    } })).extract(...args);
  } };
}
