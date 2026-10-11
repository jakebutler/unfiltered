/** Private synthetic qualification evidence only; never accepted output. */
export const syntheticDiagnosticPrefixBytes = 8192;
export function syntheticDiagnosticPrefix() {
  let text = '', bytes = 0, truncated = false;
  return {
    append(delta: string): void {
      if (truncated) return;
      for (const character of delta) {
        const size = new TextEncoder().encode(character).byteLength;
        if (bytes + size > syntheticDiagnosticPrefixBytes) { truncated = true; break; }
        text += character;
        bytes += size;
      }
    },
    snapshot() {
      return { syntheticOnly: true as const, acceptedOutput: false as const,
        contentPrefix: text, bytes: new TextEncoder().encode(text).byteLength,
        truncated, maxBytes: syntheticDiagnosticPrefixBytes };
    },
  };
}
