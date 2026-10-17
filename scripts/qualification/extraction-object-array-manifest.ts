import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { canonicalJson } from '../../packages/clinical-core/src/domain.js';
import type { InferenceMessage } from '../../packages/clinical-core/src/digitalocean.js';
import { getNativeQuestionnaireDefinition } from '../../packages/clinic-content/src/native-questionnaire.js';
import { AdaptiveError, type AdaptiveContext } from '../../packages/clinic-api/src/adaptive-validation.js';
import { createGroupedExtractionManifest, compileGroupedExtraction, type GroupedExtractionManifest, type GroupedWire } from '../../packages/clinic-api/src/adaptive-extraction-grouped-v2.js';
import { encodeObjectArrayWire, decodeObjectArrayWire, objectArraySchema, assertClosedObjectArraySchema } from './extraction-object-array-codec.mjs';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const objectArrayProtocol = 'adaptive-extraction-object-array-v1';
export const objectArraySchemaName = 'adaptive_extraction_object_array_v1';
export interface ObjectArrayManifest {
  readonly id: string;
  readonly protocol: typeof objectArrayProtocol;
  readonly sha256: string;
  readonly nativeDefinition: Awaited<ReturnType<typeof getNativeQuestionnaireDefinition>>['binding'];
  readonly contextSha256: string;
  readonly messages: readonly InferenceMessage[];
  readonly jsonSchema: Record<string, unknown>;
  readonly measurement: GroupedExtractionManifest['measurement'];
}
const issued = new WeakMap<ObjectArrayManifest, { context: AdaptiveContext; contextHash: string; signature: string; grouped: GroupedExtractionManifest; schema: z.ZodType }>();
const syntax = `Output ONE closed object with required m,t,e,r,d. m is the issued manifest; t is an array of topics {t:topicID,o:owner,g:groups,l:lists}. owner is patient, unclear, or {s:other,e:entity}. A group is {k:stateCode,s:provenance,f:fieldNames,v:values} for known(k)/narrow(r), or {k:stateCode,s:provenance,f:fieldNames} for negative(n)/unknown(u)/uncertain(q)/declined(d)/not-applicable(a). Parallel f/v arrays have equal length, pair at the SAME index, unique readable issued field names and native values. Never reorder one array alone. All original state meanings and distinct provenance requirements remain unchanged. A list is {c:collection,g:groups,i:items,e:closureProvenanceOrNull}. An item is {n:newIdentityOrNull,x:existingAliasOrNull,g:groups}; exactly one of n/x is non-null. New identity is {s:subject,e:entity,r:provenance}. Source alias is unchanged; a source span is {s:alias,a:start,b:end}; explicit provenance is {e:evidenceRefs,p:predicateRef,v:valueRefOrNull,t:periodOrNull,c:correctionAliases}. Events e use {k:kind,t:topic,s:sourceRef,o:careOwner}; residual r uses {s:sourceRefs,r:reason}. d preserves represented/partially-represented. Empty arrays and nullable identity/closure express structural absence only, never clinical states. All object fields required, no extras. No examples or expected values.`;
export async function createObjectArrayManifest(context: AdaptiveContext, grouped = createGroupedExtractionManifest(context)): Promise<ObjectArrayManifest> {
  if (!context.nativeRouting) throw new AdaptiveError('object-array-native-routing-required');
  const definition = await getNativeQuestionnaireDefinition();
  const schema = objectArraySchema(grouped), jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', reused: 'ref' });
  assertClosedObjectArraySchema(jsonSchema);
  const system = String(grouped.messages[0].content)
    .replace(/Output topics keyed.*?All source meaning/s, 'All source meaning');
  // Replacement changes only obsolete wire syntax; all clinical instruction text
  // before/after that span remains. The explicit syntax restores every removed
  // placement/provenance rule without suggesting any authored patient values.
  const messages: InferenceMessage[] = [
    { role: 'system', content: `${system}\n${syntax}\nScalar fields belong to their issued topic. Declare each item's new identity or existing issued alias ONCE. A source alias means its exact issued quote; spans select exact nonempty offsets relative to that quote. Share provenance only when evidence/value/predicate/period/correction semantics are identical. Never omit distinct provenance to reduce size. Fields are readable issued names, native values/offered choices; absent optional/negative/notApplicable flags mean false; local relation validation rejects illegal type/state/placement/source/identity. Never recreate an existing corrected medicine or merge relatives/medicines/eating occasions.` },
    { role: 'user', content: String(grouped.messages[1].content) },
  ];
  const nativeDefinition = definition.binding;
  const contextSha256 = hash(context);
  const manifest: ObjectArrayManifest = Object.freeze({ id: grouped.id, protocol: objectArrayProtocol, sha256: hash({ messages, jsonSchema, nativeDefinition, contextSha256 }), nativeDefinition, contextSha256, messages, jsonSchema,
    measurement: { ...grouped.measurement, schemaBytes: Buffer.byteLength(canonicalJson(jsonSchema)), instructionBytes: Buffer.byteLength(String(messages[0].content)), requestBodyBytes: Buffer.byteLength(canonicalJson({ messages, jsonSchema })) } });
  if (manifest.measurement.schemaBytes > 32000 || manifest.measurement.requestBodyBytes > 131072) throw new AdaptiveError('object-array-request-capacity');
  issued.set(manifest, { context, contextHash: contextSha256, signature: hash(manifest), grouped, schema });
  return manifest;
}
function trusted(manifest: ObjectArrayManifest) {
  const record = issued.get(manifest);
  if (!record || record.signature !== hash(manifest) || record.contextHash !== hash(record.context)) throw new AdaptiveError('unissued-or-stale-object-array-manifest');
  return record;
}
export function encodeObjectArrayExtraction(wire: GroupedWire, manifest: ObjectArrayManifest) {
  const record = trusted(manifest);
  compileGroupedExtraction(wire, record.grouped);
  const result = encodeObjectArrayWire(wire);
  decodeObjectArrayWire(result, record.schema);
  return result;
}
export function decodeObjectArrayExtraction(raw: unknown, manifest: ObjectArrayManifest) {
  const record = trusted(manifest);
  const groupedWire = decodeObjectArrayWire(raw, record.schema);
  const compiled = compileGroupedExtraction(groupedWire, record.grouped);
  return { groupedWire, ...compiled };
}
