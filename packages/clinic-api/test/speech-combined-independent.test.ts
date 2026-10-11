import { describe, expect, it, vi } from 'vitest';
import { createSpeechAccess } from '../src/speech-access.js';
import { cookies, type Claims } from '../src/cookies.js';
import { document, DRAFT_SYSTEM } from '../src/store.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import { createSpeechOutput } from '../../speech/src/server.js';

async function fixture(replyText = 'Your clinician will review medication questions.') {
  const origin = 'http://127.0.0.1:5173';
  const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
  const config = { origin, cookieSecret: 'independent-test-secret'.repeat(4), mentalHealth: 'phq4', patients: { 'first-intake': patient } } as ClinicApiConfig;
  const at = new Date().toISOString();
  const draft: Draft = {
    schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 7, savedAt: at, createdAt: at,
    phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1,
    adaptive: { mode: 'adaptive', operations: {}, exchange: {
      reply: { id: 'COPY-05', text: replyText }, state: {}, status: 'question',
      prompt: { topicId: 'Q04', promptId: 'Q04', targetPaths: ['height.value'], kind: 'question', text: 'How tall are you?', labels: [], optional: false },
    } },
  };
  const runtime = async () => ({ client: { request: async () => ({ body: { resourceType: 'Bundle', type: 'searchset', total: 1,
    entry: [{ resource: { ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft), id: 'draft', meta: { versionId: '1' } } }],
  } }) } } as unknown as Runtime);
  const access = createSpeechAccess(config, { enabled: true, adaptiveAvailable: true, runtime });
  const claims: Claims = { kind: 'patient', sessionId: draft.id, patient: draft.patient, scenario: draft.scenario, identityConfirmed: true, expires: Date.now() + 60000 };
  const cookie = (await cookies(config.cookieSecret, false).issue('clinic_patient', claims)).split(';')[0];
  const request = new Request(`${origin}/api/clinic/speech/output`, { headers: { origin, cookie } });
  const input = { requestId: crypto.randomUUID(), sessionId: draft.id, expectedRevision: 7, sourceId: 'conversation-current' };
  return { draft, access, request, input };
}

describe('independent combined conversation speech boundary', () => {
  it('rechecks the authorized revision after admission before dispatching combined speech', async () => {
    const f = await fixture(), fetcher = vi.fn(), settle = vi.fn();
    await expect(f.access.output(f.request, f.input)).resolves.toMatchObject({ text: 'Your clinician will review medication questions.\n\nHow tall are you?' });
    const reserve = vi.fn(async () => { f.draft.revision++; return { settle }; });
    const output = createSpeechOutput({ elevenlabsApiKey: 'synthetic-unused-key', authorize: input => f.access.output(f.request, input), admission: { reserve }, fetcher });
    await expect(output(f.input)).rejects.toMatchObject({ code: 'stale-session' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ maxCharacters: 'Your clinician will review medication questions.\n\nHow tall are you?'.length }));
    expect(settle).toHaveBeenCalledExactlyOnceWith('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses an overlong combined source before reserving or truncating either part', async () => {
    const f = await fixture('a'.repeat(1190)), reserve = vi.fn(), fetcher = vi.fn();
    const text = (await f.access.output(f.request, f.input)).text;
    expect(text).toBe(`${'a'.repeat(1190)}\n\nHow tall are you?`);
    const output = createSpeechOutput({ elevenlabsApiKey: 'synthetic-unused-key', authorize: input => f.access.output(f.request, input), admission: { reserve }, fetcher });
    await expect(output(f.input)).rejects.toMatchObject({ code: 'limit' });
    expect(reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
