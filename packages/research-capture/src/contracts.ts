export const CAPTURE_LIMITS = Object.freeze({ sessionBytes: 750_000_000, segmentBytes: 8_000_000, retainedSessions: 6, sessionMs: 45 * 60_000, reservationMs: 120_000, uploadLeaseMs: 60_000, uploadAttempts: 3, uploadRecoveryMs: 600_000, segments: 2_000, domEvents: 1_800, domBatch: 25 });
export function captureLimits(overrides?: string): Record<keyof typeof CAPTURE_LIMITS, number> {
  if (!overrides) return { ...CAPTURE_LIMITS };
  const input: unknown = JSON.parse(overrides);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid capture limits');
  const limits = { ...CAPTURE_LIMITS } as Record<keyof typeof CAPTURE_LIMITS, number>;
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > limits[key as keyof typeof limits]) throw new Error('Capture limits can only reduce the approved envelope');
    limits[key as keyof typeof limits] = Number(value);
  }
  return limits;
}
export type Modality = 'microphone' | 'camera' | 'screen';
export type MediaDescriptor = { modality: Modality; sequence: number; startMs: number; endMs: number; bytes: number; sha256: string; mime: string; questionId: string; sourceId: string | null };
export function validateDescriptor(d: MediaDescriptor): void {
  if (!Number.isSafeInteger(d.sequence) || d.sequence < 0 || !Number.isSafeInteger(d.bytes) || d.bytes < 1 || d.bytes > CAPTURE_LIMITS.segmentBytes || !/^[a-f0-9]{64}$/.test(d.sha256)) throw new Error('Invalid segment');
  if (![d.startMs, d.endMs].every(Number.isSafeInteger) || d.startMs < 0 || d.endMs <= d.startMs || d.endMs > CAPTURE_LIMITS.sessionMs || d.endMs - d.startMs > 90_000) throw new Error('Invalid segment interval');
  const types = d.modality === 'microphone' ? ['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4'] : ['video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4'];
  if (!types.includes(d.mime)) throw new Error('Unsupported media type');
}
export type DomEvent = { sequence: number; atMs: number; kind: 'connected' | 'click' | 'focus' | 'change' | 'scroll'; target: string; tag: 'none' | 'button' | 'link' | 'input' | 'select' | 'other'; x: number | null; y: number | null };
export function validateDomEvent(event: DomEvent): void {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || !Number.isSafeInteger(event.atMs) || event.atMs < 0 || event.atMs > CAPTURE_LIMITS.sessionMs || !/^(?:none|c[0-9]{1,3})$/.test(event.target)) throw new Error('Invalid DOM event');
  if (![event.x, event.y].every(n => n === null || Number.isInteger(n) && n >= 0 && n <= 100)) throw new Error('Invalid DOM position');
  if (event.kind === 'connected' && (event.target !== 'none' || event.tag !== 'none')) throw new Error('Invalid DOM handshake');
}
export type StoredObject = { bytes: number; sha256: string; mime: string };
/** Implementations never expose bucket URLs. Keys are server-chosen, immutable and scoped. */
export interface PrivateObjectStore {
  putIfAbsent(key: string, body: Uint8Array, metadata: StoredObject): Promise<StoredObject>;
  head(key: string): Promise<StoredObject | null>;
  read(key: string, range: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
  /** Atomically replace bytes with a non-content tombstone, fencing late conditional writes. */
  retire(key: string): Promise<void>;
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), n => n.toString(16).padStart(2, '0')).join('');
}
export function validObjectKey(key: string): void {
  if (!/^research\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Invalid private object key');
}
export function byteRange(header: string | null, size: number): { start: number; end: number; partial: boolean } {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) throw new Error('Invalid range');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('Unsatisfiable range');
  return { start, end, partial: true };
}
