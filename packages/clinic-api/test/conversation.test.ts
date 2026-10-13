import { describe, it, expect } from 'vitest';
import { conversation } from '../src/conversation.js';
import { cookies } from '../src/cookies.js';
import { escalation } from '../src/safety.js';
import { digest } from '../../clinical-core/src/domain.js';
import { toNativeQuestionnaireResponse } from '../../clinical-core/src/questionnaire-response.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
const patient = { reference: 'Patient/test', displayName: 'Synthetic Patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://127.0.0.1:5173', cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
const now = '2026-10-09T00:00:00.000Z';
const fresh = (): Draft => ({ schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 0, savedAt: now, createdAt: now, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 });
const c = conversation(config);
function answer(d: Draft, text?: string, action: 'answer' | 'unknown' | 'decline' | 'move-on' = 'answer') { const p = c.view(d).currentPrompt!; const n = c.turn(d, { requestId: crypto.randomUUID(), expectedRevision: d.revision, promptId: p.id, action, text }); n.revision++; n.savedAt = new Date().toISOString(); return n; }
describe('guided patient evidence and immutable confirmation', () => {
    it('keeps completed PHQ-4 evidence stable through the review save and delayed confirmation', async () => {
        let d = fresh();
        for (const id of ['MH01', 'MH02', 'MH03', 'MH04']) {
            d = c.select(d, 'Q16', id);
            d = answer(d, '0');
        }
        const completedAt = d.turns.at(-1)!.at;
        d.preview = await c.preview(d); d.phase = 'review';
        const screening = d.preview.topics.find(t => t.id === 'Q16')!.screening!;
        expect(screening.status).toBe('complete');
        expect(screening.completedAt).toBe(completedAt);
        // The real review route persists a new savedAt and revision after preview.
        d.savedAt = new Date(Date.parse(completedAt) + 10000).toISOString(); d.revision++;
        const final = await c.finalize(d, new Date(Date.parse(completedAt) + 300000).toISOString());
        expect(final.topics.find(t => t.id === 'Q16')!.screening).toEqual(screening);
        expect(final.previewDigest).toBe(d.preview.digest);
        const corrected = answer(c.select(d, 'Q16', 'MH01'), '2');
        expect(c.view(corrected).topics.find(t => t.id === 'Q16')!.screening!.completedAt).toBe(corrected.turns.at(-1)!.at);
    });
    it('binds actual confirmation time separately from the reviewed preview and rejects changed answers', async () => {
        const d = answer(fresh(), 'I want help with everyday energy.');
        const previewAt = '2026-10-09T10:00:00.000Z', confirmedAt = '2026-10-09T10:05:00.000Z';
        d.preview = await c.preview(d, previewAt); d.phase = 'review';
        const final = await c.finalize(d, confirmedAt);
        expect(final.previewDigest).toBe(d.preview.digest);
        expect(final.digest).not.toBe(final.previewDigest);
        expect(final.confirmation.submission.confirmedAt).toBe(confirmedAt);
        expect(final.digest).toBe(await digest(final.confirmation.submission));
        expect(final.confirmation.sufficiency?.submissionDigest).toBe(final.digest);
        expect({ ...final.confirmation.submission, confirmedAt: previewAt }).toEqual(d.preview.confirmation.submission);
        expect(d.preview.confirmation.submission.confirmedAt).toBe(previewAt);
        const changed = structuredClone(d);
        changed.turns.find(t => t.role === 'patient')!.text = 'Different source after preview';
        await expect(c.finalize(changed, confirmedAt)).rejects.toThrow('confirmation-digest-mismatch');
    });
    it('guided path: an otherwise complete intake with one vague required answer stays partial in the view and the submission', async () => { let d = fresh(), count = 0, vague = 0; while (c.view(d).currentPrompt) {
        const p = c.view(d).currentPrompt!;
        expect(++count).toBeLessThan(150);
        const text = p.choices ? p.choices.find(x => x.value === '__negative')?.value ?? p.choices.find(x => x.value === '__done')?.value ?? p.choices.find(x => x.value === '__topic-not-applicable')?.value ?? p.choices[0].value
            : p.id === 'Q04:height.value' ? '170' : p.id === 'Q04:lastMeasuredWeight.value' ? '82' : p.id === 'Q04:lastMeasuredWeight.measuredWhen' ? (vague++, 'a while back') : `Synthetic detail for ${p.purpose}: typical pattern recalled for this example.`;
        d = answer(d, text);
    } expect(vague).toBe(1); expect(c.view(d).completeness).toBe('partial'); const s = (await c.preview(d)).confirmation.submission; expect(s.completeness).toBe('partial');
    // The exported native QuestionnaireResponse says the same: stopped, not completed (cubic, 2026-10-13).
    expect((await toNativeQuestionnaireResponse({ capture: s.questionnaireCapture!, validSourceIds: new Set(s.sources.map(source => source.id)), patient: s.patient, authored: s.confirmedAt, confirmed: true })).status).toBe('stopped'); }, 20000);
    it('finishes a granular first intake with real measurement targets and explicit PHQ responses', async () => { let d = fresh(), count = 0; while (c.view(d).currentPrompt) {
        const p = c.view(d).currentPrompt!;
        expect(++count).toBeLessThan(150);
        let text: string;
        if (p.choices) {
            text = p.choices.find(x => x.value === '__negative')?.value ?? p.choices.find(x => x.value === '__done')?.value ?? p.choices.find(x => x.value === '__topic-not-applicable')?.value ?? p.choices[0].value;
        }
        else if (p.id === 'Q04:height.value')
            text = '170';
        else if (p.id === 'Q04:lastMeasuredWeight.value')
            text = '82';
        else if (p.id === 'Q04:lastMeasuredWeight.measuredWhen')
            text = 'In March 2026.';
        else
            text = `Synthetic detail for ${p.purpose}: typical pattern recalled for this example.`;
        d = answer(d, text);
    } expect(c.view(d).completeness).toBe('complete'); const p = await c.preview(d); expect(p.confirmation.submission.completeness).toBe('complete'); const s = p.confirmation.submission; expect((await toNativeQuestionnaireResponse({ capture: s.questionnaireCapture!, validSourceIds: new Set(s.sources.map(source => source.id)), patient: s.patient, authored: s.confirmedAt, confirmed: true })).status).toBe('completed'); expect(p.topics.find(t => t.id === 'Q16')?.screening?.scores).toEqual({ gad2: 0, phq2: 0, phq4: 0 }); expect(count).toBeGreaterThan(40); expect(p.confirmation.submission.sources).toHaveLength(count); }, 20000);
    it('declines stop the topic, while unknown stops only that detail', () => { let d = c.select(fresh(), 'Q16'); d = answer(d, undefined, 'decline'); expect(d.topics.Q16.stopped).toBe('patient-declines'); expect(c.view(d).currentPrompt?.topicId).not.toBe('Q16'); let u = c.select(fresh(), 'Q16'); u = answer(u, undefined, 'unknown'); expect(u.topics.Q16.stopped).toBeUndefined(); expect(c.select(u, 'Q16').topics.Q16.answers.depressionHistory?.state).toBe('unknown'); expect(c.view(c.select(u, 'Q16')).currentPrompt?.id).toBe('Q16:anxietyHistory'); });
    it('a correction keeps source history, changes digest and refuses stale prompt targets', async () => { let d = answer(fresh(), 'Improve everyday energy with regular meals.'); const before = await c.preview(d), original = d.turns.find(t => t.role === 'patient')!; d = c.select(d, 'Q01', 'reason'); d = answer(d, 'Correction: improve walking endurance for family activities.'); const after = await c.preview(d); expect(after.digest).not.toBe(before.digest); expect(d.turns.some(t => t.corrects === original.id)).toBe(true); expect(after.confirmation.submission.answers.find(a => a.questionId === 'Q01')?.text).toContain('Correction'); expect(() => c.turn(d, { requestId: crypto.randomUUID(), expectedRevision: d.revision, promptId: 'Q04:height.value', action: 'answer', text: '170' })).toThrow('stale-prompt'); });
    it('refused required measurement never becomes complete', async () => { let d = c.select(fresh(), 'Q04'); d = answer(d, undefined, 'decline'); expect(c.view(d).completeness).toBe('partial'); expect((await c.preview(d)).confirmation.submission.completeness).toBe('partial'); });
    it('explicit crisis interrupts without diagnostic clearance and retains its exact source', async () => { let d = answer(fresh(), 'I may hurt myself tonight.'); expect(d.safety?.rule).toBe('E04'); expect(c.view(d).currentPrompt).toBeUndefined(); expect(c.view(d).notice?.text).toContain('988'); expect(c.view(d).notice?.text).toContain('not been sent'); const p = await c.preview(d); expect(p.confirmation.submission.completeness).toBe('partial'); expect(p.topics.some(t => t.id === 'E04')).toBe(true); expect(() => c.select(d, 'Q04')).toThrow('safety-interruption'); expect(escalation('Work has been stressful')).toBeUndefined(); });
    it('interrupts before numeric or choice parsing without fabricating the requested field', async () => { for (const path of ['height.value', 'height.unit']) {
        let d = c.select(fresh(), 'Q04', path);
        d = answer(d, 'My belly pain is severe and I fainted.');
        expect(d.safety?.rule).toBe('E01');
        expect(d.topics.Q04.answers[path]).toBeUndefined();
        expect(d.turns.at(-1)?.text).toContain('I fainted');
        expect(c.view(d).currentPrompt).toBeUndefined();
        expect((await c.preview(d)).confirmation.submission.completeness).toBe('partial');
    } });
    it('does not mark normal collection add/finish turns as corrections', () => { let d = c.select(fresh(), 'Q08', 'medicines'); d = answer(d, '__add'); d = c.select(d, 'Q08', 'medicines'); d = answer(d, '__done'); expect(d.turns.filter(t => t.role === 'patient')).toHaveLength(2); expect(d.turns.every(t => !t.corrects)).toBe(true); });
    it('protects patient capability integrity and expiry', async () => { const jar = cookies(config.cookieSecret, false), claims = { kind: 'patient' as const, sessionId: crypto.randomUUID(), patient: 'Patient/test', scenario: 'first-intake', expires: Date.now() + 10000 }; const cookie = (await jar.issue('clinic_patient', claims)).split(';')[0]; expect(await jar.read(new Request(config.origin, { headers: { cookie } }), 'clinic_patient')).toEqual(claims); await expect(jar.read(new Request(config.origin, { headers: { cookie: cookie + 'a' } }), 'clinic_patient')).rejects.toThrow('session-required'); const expired = (await jar.issue('clinic_patient', { ...claims, expires: Date.now() - 1 })).split(';')[0]; await expect(jar.read(new Request(config.origin, { headers: { cookie: expired } }), 'clinic_patient')).rejects.toThrow('session-required'); });
});
