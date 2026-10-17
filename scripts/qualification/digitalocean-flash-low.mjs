/** Isolated qualification shim. Stable adapter, SSE parser and clinical source remain unchanged. */
import assert from 'node:assert/strict';
import { digitalOceanStream as stableStream, prepareDigitalOceanStreamRequest as stablePrepare, DigitalOceanStreamFailure, fullStreamLimits } from '../../.extraction-sparse-v2-build/packages/clinical-core/src/digitalocean-stream.js';
import { StreamTransportError } from '../../.extraction-sparse-v2-build/packages/clinical-core/src/streaming-transport.js';
export { fullStreamLimits };
export async function prepareDigitalOceanStreamRequest(config, messages) {
 assert.equal(config.model, 'glm-5.3-flash', 'Flash-low qualification only');
 const stable = await stablePrepare(config, messages);
 const body = JSON.stringify({ ...JSON.parse(stable.body), reasoning_effort: 'low' });
 const requestBytes = Buffer.byteLength(body);
 if (requestBytes > (config.maxRequestBytes ?? 1000000)) throw new StreamTransportError('inference-input-too-large');
 return { ...stable, body, requestBytes };
}
export function digitalOceanStream(config, fetcher = fetch, now = () => performance.now(), limits) {
 return { async generate(messages, options) {
  const stable = await stablePrepare(config, messages), issued = await prepareDigitalOceanStreamRequest(config, messages);
  const exactFetch = (url, init) => {
   assert.equal(String(url), 'https://inference.do-ai.run/v1/chat/completions');
   assert.equal(init?.method, 'POST'); assert.equal(init.body, stable.body, 'stable serializer drift');
   return fetcher(url, { ...init, body: issued.body });
  };
  // All parser/timeout/cancellation/usage/model checks are the accepted stable stream implementation.
  // Only transmitted request bytes differ; reflect those exact bytes on success and failure receipts.
  try {
   const result = await stableStream(config, exactFetch, now, limits).generate(messages, options);
   return { ...result, receipt: { ...result.receipt, requestBytes: issued.requestBytes } };
  } catch (error) {
   if (error instanceof DigitalOceanStreamFailure) throw new DigitalOceanStreamFailure(error.code, { ...error.receipt, requestBytes: issued.requestBytes });
   throw error;
  }
 } };
}
