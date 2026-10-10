export const RESEARCH_LIMITS = Object.freeze({
  page: 25, scriptQuestions: 30, goals: 12, contextFiles: 8, contextBytes: 48_000,
  answerCharacters: 8_000, sourceCount: 200, invitationDays: 7, retentionDays: 30,
});

export function boundedText(value: string, max: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || value.length > max || /\u0000/.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

export function requestId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new Error('Invalid request identifier');
  return value;
}

export function safeReference(value: string): string {
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('Use an HTTP(S) reference without credentials, query, or fragment');
  return parsed.href;
}

// Context is untrusted data, never instructions. This catches common accidental
// credentials; it does not certify arbitrary source files as secret-free.
export function assertContextSafe(text: string): void {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9]{20,}|gh[pousr]_[a-zA-Z0-9]{20,})|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/i.test(text)) throw new Error('Remove credential-like material from research context');
}
