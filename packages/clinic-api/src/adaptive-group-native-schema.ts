import { AdaptiveError } from './adaptive-validation.js';

export const historicalAdaptiveGroupNativeSchemaRevision = 'v6-native-v1' as const;
export const draft7AdaptiveGroupNativeSchemaRevision = 'v6-native-draft7-v2' as const;
export type AdaptiveGroupNativeSchemaRevision = typeof historicalAdaptiveGroupNativeSchemaRevision | typeof draft7AdaptiveGroupNativeSchemaRevision;
export function adaptiveGroupNativeSchemaRevision(value: AdaptiveGroupNativeSchemaRevision = historicalAdaptiveGroupNativeSchemaRevision): AdaptiveGroupNativeSchemaRevision {
  if (value !== historicalAdaptiveGroupNativeSchemaRevision && value !== draft7AdaptiveGroupNativeSchemaRevision) throw new AdaptiveError('invalid-native-schema-revision');
  return value;
}

/** Dialect representation only. Never visit enum/const data or rewrite additionalProperties:false. */
export function normalizeAdaptiveGroupNativeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalize = (value: unknown): unknown => {
    if (value === false) return { not: {} };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(value);
    const node = value as Record<string, unknown>;
    if (Object.keys(node).length === 1 && Array.isArray(node.anyOf) && node.anyOf.length === 1) return normalize(node.anyOf[0]);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === '$ref' && typeof child === 'string') result[key] = child.startsWith('#/$defs/') ? `#/definitions/${child.slice('#/$defs/'.length)}` : child;
      else if (['$defs', 'definitions', 'properties', 'patternProperties'].includes(key) && child && typeof child === 'object' && !Array.isArray(child)) {
        result[key === '$defs' ? 'definitions' : key] = Object.fromEntries(Object.entries(child).map(([name, definition]) => [name, normalize(definition)]));
      } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(child)) result[key] = child.map(normalize);
      else if (key === 'items' && Array.isArray(child)) result[key] = child.map(normalize);
      else if (['items', 'not', 'contains', 'if', 'then', 'else', 'propertyNames'].includes(key)) result[key] = normalize(child);
      else if (key === 'additionalProperties' && child !== false && typeof child === 'object') result[key] = normalize(child);
      else result[key] = structuredClone(child);
    }
    return result;
  };
  return { $schema: 'http://json-schema.org/draft-07/schema#', ...normalize(schema) as Record<string, unknown> };
}
