import type { ScenarioId as ContractScenarioId } from '../../clinic-contract/src/index.js';

/** Ordered list of clinic workflows. The order determines UI and seed order. */
export const scenarioIds = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'] as const;
export type ScenarioId = typeof scenarioIds[number];
export const isScenarioId = (value: unknown): value is ScenarioId => typeof value === 'string' && (scenarioIds as readonly string[]).includes(value);
/** Patient-facing titles, preserved verbatim from conversation.ts. */
export const scenarioTitles: Readonly<Record<ScenarioId, string>> = { 'first-intake': 'First visit intake', 'pre-visit': 'Before your visit', 'non-visit': 'Check in with your care team', 'post-visit': 'After your visit', billing: 'Billing help', scheduling: 'Scheduling help', refill: 'Prescription refill request' };

// The browser contract stays dependency-free. Keep its literal union equal in both
// directions here, where the foundation compiler (which excludes tests) checks it.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const contractMatches: Equal<ScenarioId, ContractScenarioId> = true;
