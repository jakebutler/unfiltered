import type { z } from 'zod/v4';
import type { GroupedExtractionManifest, GroupedWire } from '../../packages/clinic-api/src/adaptive-extraction-grouped-v2.js';
export function encodeObjectArrayWire(wire: GroupedWire): unknown;
export function decodeObjectArrayWire(input: unknown, schema: z.ZodType): GroupedWire;
export function objectArraySchema(manifest: Pick<GroupedExtractionManifest, 'id' | 'messages'>): z.ZodType;
export function assertClosedObjectArraySchema(schema: unknown): void;
