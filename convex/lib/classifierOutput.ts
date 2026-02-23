type JsonObject = Record<string, unknown>;

export function extractFirstJsonObject(raw: string): JsonObject | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as JsonObject;
  } catch {
    // Continue to object slicing fallback.
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate) as JsonObject;
  } catch {
    return null;
  }
}

export function normalizeConfidence(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.max(0, Math.min(1, input));
  }
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "high") return 0.85;
    if (normalized === "medium") return 0.6;
    if (normalized === "low") return 0.35;
    const asNumber = Number(normalized);
    if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
      return Math.max(0, Math.min(1, asNumber));
    }
  }
  return 0;
}
