export type DecisionEngineId = "deterministic-a" | "llm-b";

export interface DecisionEngineRegistryEntry {
  id: DecisionEngineId;
  label: string;
  decideMode: "A" | "B";
  posthogVariantKey: "A" | "B";
}

export const DECISION_ENGINE_REGISTRY: readonly DecisionEngineRegistryEntry[] = [
  {
    id: "deterministic-a",
    label: "Deterministic A",
    decideMode: "A",
    posthogVariantKey: "A",
  },
  {
    id: "llm-b",
    label: "LLM B",
    decideMode: "B",
    posthogVariantKey: "B",
  },
] as const;

const BY_ID = new Map<DecisionEngineId, DecisionEngineRegistryEntry>(
  DECISION_ENGINE_REGISTRY.map((entry) => [entry.id, entry]),
);

export function isDecisionEngineId(value: string): value is DecisionEngineId {
  return BY_ID.has(value as DecisionEngineId);
}

export function getDecisionEngineOrThrow(id: string): DecisionEngineRegistryEntry {
  if (!isDecisionEngineId(id)) {
    throw new Error(`Unknown decision engine id: ${id}`);
  }
  return BY_ID.get(id)!;
}

export function getDecideModeForEngine(id: string): "A" | "B" {
  return getDecisionEngineOrThrow(id).decideMode;
}

