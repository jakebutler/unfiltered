import type { DigitalOceanConfig } from '../../clinical-core/src/digitalocean.js';
import type { digitalOceanStream } from '../../clinical-core/src/digitalocean-stream.js';
import { GroupedExtractionOutputFailure, type GroupedExtractionProposer } from './adaptive-extraction-grouped-session-v2.js';
import { createSparseManifest, decodeSparseExtraction, sparseSchemaName } from './adaptive-extraction-sparse.js';

/** Explicit transport injection only; no provider/factory/default activation.
 * The caller supplies the reviewed stable transport (including any isolated model effort control).
 * Request schema is native response_format, not merely instructions in the prompt. */
export function sparseExtractionProposer(
  config: Omit<DigitalOceanConfig, 'responseFormat'>,
  streamFactory: (config: DigitalOceanConfig) => ReturnType<typeof digitalOceanStream>,
): GroupedExtractionProposer {
  return { async extract(context, grouped, options) {
    const manifest = await createSparseManifest(context, grouped);
    const result = await streamFactory({ ...config, responseFormat: {
      type: 'json-schema', name: sparseSchemaName, schema: manifest.jsonSchema,
    } }).generate([...manifest.messages], { signal: options.signal, onContent: () => {} });
    try {
      const raw = JSON.parse(result.text);
      return { raw: decodeSparseExtraction(raw, manifest).groupedWire, receipt: result.receipt };
    } catch {
      throw new GroupedExtractionOutputFailure('invalid-sparse-extraction', result.receipt, result.text);
    }
  } };
}
