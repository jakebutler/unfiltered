import { describe, expect, it } from 'vitest';
import { validateVisionResult } from '../scripts/prepare-vision';
import { evidenceId, type Evidence } from '../../../packages/research-core/src/analysis';
const e: Evidence = { sessionId: 'synthetic', kind: 'screen-observation', id: 'source', start: 1250, end: 1251, hash: 'a'.repeat(64), consentEpoch: 0, sharingEpoch: 0, retainApprovedExcerpts: false, text: null };
const valid = { id: 'f1', type: 'tentative-screen', statement: 'At 1250 ms the screen shows "Delivery $5".', supports: [evidenceId(e)], counterevidence: [], limitations: 'One sampled frame only.' };
describe('prepared vision probe acceptance', () => {
  it('requires supplied source, sampled timestamp and exact visible quote', () => {
    expect(validateVisionResult([valid], [e])).toHaveLength(1);
    for (const patch of [{ supports: ['invented'] }, { statement: 'At 750 ms the screen shows "Delivery $5".' }, { statement: 'At 1250 ms the delivery cost is ten dollars.' }, { type: 'interpretation' }, { limitations: '' }]) expect(() => validateVisionResult([{ ...valid, ...patch }], [e])).toThrow();
  });
  it('rejects emotion, diagnosis and unseen interaction even with valid source and quote', () => {
    for (const inference of ['Participant is confused', 'Depression diagnosis', 'Participant clicked Continue', 'Participant hesitated']) expect(() => validateVisionResult([{ ...valid, statement: `${valid.statement} ${inference}.` }], [e])).toThrow('visible sampled UI');
  });
});
