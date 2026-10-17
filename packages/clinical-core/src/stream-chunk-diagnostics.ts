export const streamChunkDiagnosticBounds = { maxBytes: 2048, maxIssues: 16, maxChoices: 2 } as const;
const fields = [
  'id', 'model', 'choices', 'usage', 'error', 'index', 'delta', 'finish_reason',
  'role', 'content', 'reasoning_content', 'refusal', 'tool_calls', 'function_call',
  'prompt_tokens', 'completion_tokens', 'total_tokens', 'code', 'type', 'param',
  'message', 'request_id',
] as const;
type Field = typeof fields[number];
type Kind = 'missing' | 'null' | 'object' | 'array' | 'string' | 'number' | 'boolean' | 'other';
type PathToken = Field | 'choice-0' | 'choice-1' | 'other-index' | 'other-field';
const issueCodes = [
  'invalid_type', 'invalid_literal', 'invalid_union', 'invalid_union_discriminator',
  'invalid_enum_value', 'unrecognized_keys', 'invalid_arguments', 'invalid_return_type',
  'invalid_date', 'invalid_string', 'too_small', 'too_big', 'invalid_intersection_types',
  'not_multiple_of', 'not_finite', 'custom',
] as const;
type IssueCode = typeof issueCodes[number] | 'other';
type Shape = { kind: Kind; fields?: Partial<Record<Field, Kind>>; unknownKeys?: number };
interface ChoiceShape extends Shape {
  indexIsZero?: boolean;
  delta?: Shape;
  finish?: 'missing' | 'null' | 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call' | 'other';
}
export interface StreamChunkDiagnostic {
  schema: 'stream-chunk-shape-v1';
  consumedEvent: number;
  schemaValidChunksBefore: number;
  stopSeen: boolean;
  packet: Shape;
  choices?: { kind: Kind; count?: number; entries?: ChoiceShape[] };
  usage?: Shape;
  error?: Shape;
  issues: { code: IssueCode; path: PathToken[] }[];
  truncated: boolean;
}
export interface ChunkIssue { readonly code: string; readonly path: readonly (string | number)[] }

function boundedCount(value: number, cap: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : 0;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function kind(value: unknown, present = true): Kind {
  if (!present) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object': return 'object';
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    default: return 'other';
  }
}
function shape(value: unknown, known: readonly Field[]): Shape {
  const object = record(value);
  if (!object) return { kind: kind(value) };
  const selected: Partial<Record<Field, Kind>> = {};
  for (const field of known)
    selected[field] = kind(object[field], Object.hasOwn(object, field));
  return { kind: 'object', fields: selected,
    unknownKeys: boundedCount(Object.keys(object).filter(key => !known.includes(key as Field)).length, 65535) };
}
function choiceShape(value: unknown): ChoiceShape {
  const result: ChoiceShape = shape(value, ['index', 'delta', 'finish_reason']);
  const object = record(value);
  if (!object) return result;
  result.indexIsZero = Object.hasOwn(object, 'index') && object.index === 0;
  result.delta = Object.hasOwn(object, 'delta')
    ? shape(object.delta, ['role', 'content', 'reasoning_content', 'refusal', 'tool_calls', 'function_call'])
    : { kind: 'missing' };
  const reason = object.finish_reason;
  result.finish = !Object.hasOwn(object, 'finish_reason') ? 'missing' : reason === null ? 'null'
    : typeof reason === 'string' && ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(reason)
      ? reason as ChoiceShape['finish'] : 'other';
  return result;
}

/** Sanitized structure only. Raw values, unknown names and Zod issue messages/
 * keys never enter the returned object. Caller input must be parsed JSON. */
export function describeRejectedStreamChunk(
  json: unknown, rejected: readonly ChunkIssue[],
  state: { consumedEvent: number; schemaValidChunksBefore: number; stopSeen: boolean },
): StreamChunkDiagnostic {
  const diagnostic: StreamChunkDiagnostic = {
    schema: 'stream-chunk-shape-v1',
    consumedEvent: boundedCount(state.consumedEvent, 4104),
    schemaValidChunksBefore: boundedCount(state.schemaValidChunksBefore, 4104),
    stopSeen: state.stopSeen === true,
    packet: shape(json, ['id', 'model', 'choices', 'usage', 'error']),
    issues: rejected.slice(0, streamChunkDiagnosticBounds.maxIssues).map(issue => ({
      code: issueCodes.includes(issue.code as typeof issueCodes[number]) ? issue.code as IssueCode : 'other',
      path: issue.path.slice(0, 6).map(part => typeof part === 'number'
        ? part === 0 ? 'choice-0' : part === 1 ? 'choice-1' : 'other-index'
        : fields.includes(part as Field) ? part as Field : 'other-field'),
    })),
    truncated: rejected.length > streamChunkDiagnosticBounds.maxIssues || rejected.some(issue => issue.path.length > 6),
  };
  const root = record(json);
  if (root && Object.hasOwn(root, 'choices')) {
    const choices = root.choices;
    diagnostic.choices = { kind: kind(choices) };
    if (Array.isArray(choices)) {
      diagnostic.choices.count = boundedCount(choices.length, 65535);
      diagnostic.choices.entries = choices.slice(0, streamChunkDiagnosticBounds.maxChoices).map(choiceShape);
      diagnostic.truncated ||= choices.length > streamChunkDiagnosticBounds.maxChoices;
    }
  }
  if (root && Object.hasOwn(root, 'usage'))
    diagnostic.usage = shape(root.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']);
  if (root && Object.hasOwn(root, 'error'))
    diagnostic.error = shape(root.error, ['code', 'type', 'param', 'message', 'request_id']);
  const bytes = () => new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength;
  while (bytes() > streamChunkDiagnosticBounds.maxBytes && diagnostic.issues.length) {
    diagnostic.issues.pop(); diagnostic.truncated = true;
  }
  while (bytes() > streamChunkDiagnosticBounds.maxBytes && diagnostic.choices?.entries?.length) {
    diagnostic.choices.entries.pop(); diagnostic.truncated = true;
  }
  // Fixed enum-only shapes are small, but keep a deterministic minimal fallback.
  if (bytes() > streamChunkDiagnosticBounds.maxBytes) {
    diagnostic.packet = { kind: diagnostic.packet.kind };
    delete diagnostic.choices; delete diagnostic.usage; delete diagnostic.error;
    diagnostic.truncated = true;
  }
  return diagnostic;
}
