/** Tab-local unsent wording, never a server answer or voice confirmation. */
export type LocalDraftScope = { sessionId: string; promptId: string; revision: number; expiresAt: number };
export type LocalResearchDraft = LocalDraftScope & { text: string };
const prefix = 'corvo.research.draft.';
const active = 'corvo.research.draft-active';
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function readLocalDraft(scope: LocalDraftScope, storage: DraftStorage, now = Date.now()): { draft: LocalResearchDraft; current: boolean } | null {
  try {
    const saved = JSON.parse(storage.getItem(prefix + scope.sessionId) ?? 'null');
    if (!saved || saved.sessionId !== scope.sessionId || typeof saved.promptId !== 'string' || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || typeof saved.text !== 'string' || !saved.text.trim() || saved.text.length > 8000 || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= now || scope.expiresAt <= now) { storage.removeItem(prefix + scope.sessionId); return null; }
    return { draft: saved, current: saved.promptId === scope.promptId && saved.revision === scope.revision };
  } catch { return null; }
}
export function saveLocalDraft(scope: LocalDraftScope, text: string, storage: DraftStorage): boolean {
  try {
    if (!text.trim()) { storage.removeItem(prefix + scope.sessionId); return true; }
    if (!scope.promptId || text.length > 8000 || scope.expiresAt <= Date.now()) return false;
    storage.setItem(prefix + scope.sessionId, JSON.stringify({ ...scope, text })); storage.setItem(active, scope.sessionId); return true;
  } catch { return false; }
}
export function clearLocalDraft(sessionId: string | undefined, storage: DraftStorage) {
  try { const id = sessionId ?? storage.getItem(active); if (id) storage.removeItem(prefix + id); if (!sessionId || storage.getItem(active) === sessionId) storage.removeItem(active); } catch { /* Memory wording remains available. */ }
}
