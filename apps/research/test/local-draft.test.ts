import { expect, test } from 'vitest';
import { clearLocalDraft, readLocalDraft, saveLocalDraft } from '../src/local-draft';
const scope = { sessionId: 'session-one', promptId: 'q1', revision: 2, expiresAt: Date.now() + 60_000 };
function storage() { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } }; }
test('local draft resumes only exact session prompt and revision; changed scope retains explicit recovery wording', () => {
  const saved = storage(); expect(saveLocalDraft(scope, 'My unsent words', saved)).toBe(true);
  expect(readLocalDraft(scope, saved)).toMatchObject({ current: true, draft: { text: 'My unsent words' } });
  expect(readLocalDraft({ ...scope, revision: 3 }, saved)).toMatchObject({ current: false });
  expect(readLocalDraft({ ...scope, promptId: 'q2' }, saved)).toMatchObject({ current: false });
  expect(readLocalDraft({ ...scope, sessionId: 'different-session' }, saved)).toBeNull();
});
test('expiry and clearing tab access remove retained wording; storage failure never claims retention', () => {
  const saved = storage(); saveLocalDraft(scope, 'private words', saved);
  expect(readLocalDraft(scope, saved, scope.expiresAt + 1)).toBeNull();
  saveLocalDraft(scope, 'second draft', saved); clearLocalDraft(undefined, saved);
  expect(saved.data.size).toBe(0);
  expect(saveLocalDraft(scope, 'words', { ...saved, setItem: () => { throw Error('blocked'); } })).toBe(false);
});
