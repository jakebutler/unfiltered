import { describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import type { Runtime } from '../src/runtime.js';
import { decodeDocument } from '../src/store.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';
import type { ClinicSessionView, TurnInput } from '../../clinic-contract/src/index.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import { TransportError } from '../../clinical-core/src/transport.js';
const origin = 'http://localhost:5173';
const patient = { reference: 'Patient/fixture', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake','pre-visit','non-visit','post-visit','billing','scheduling','refill'].map(id => [id, patient])) } as ClinicApiConfig;
async function fixture(item = 'MH01') {
  let native: FhirResource | undefined, cookie = '', writes = 0;
  const client = { async request(_path: string, method = 'GET', body?: FhirResource, headers?: Record<string,string>) {
    if (method === 'GET') return { body: { resourceType: 'Bundle', type: 'searchset', total: native ? 1 : 0, entry: native ? [{ resource: structuredClone(native) }] : [] } };
    const version = Number((native?.meta as { versionId: string } | undefined)?.versionId ?? '0');
    if (method === 'PUT' && headers?.['If-Match'] !== `W/"${version}"`) throw new TransportError('http', 412);
    native = { ...structuredClone(body!), id: 'fixture-draft', meta: { versionId: String(version + 1) } }; writes++;
    return { body: structuredClone(native) };
  } };
  const propose = vi.fn(async () => { throw new Error('PHQ must never invoke a model'); });
  const handler = createClinicHandler(config, { runtime: async () => ({ client, qualification: {} } as unknown as Runtime), adaptiveStreamProposer: { propose }, adaptiveFullCapture: true });
  const request = async (path: string, data: unknown) => {
    const response = await handler(new Request(origin + path, { method: 'POST', headers: { origin, 'Content-Type':'application/json', cookie }, body: JSON.stringify(data) }));
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0];
    return { status: response.status, view: await response.json() as ClinicSessionView };
  };
  await request('/api/clinic/sessions', { scenario:'first-intake', syntheticAcknowledged:true });
  let current = (await request('/api/clinic/confirm-identity', { confirmed:true })).view;
  current = (await request('/api/clinic/topics', { expectedRevision:current.revision, topicId:'Q16', slotPath:item })).view;
  const send = async (data: TurnInput) => { const result = await request('/api/clinic/turns', data); if (result.status === 200) current = result.view; return result; };
  const choice = (value = '1'): TurnInput => ({ requestId:crypto.randomUUID(), expectedRevision:current.revision, promptId:current.currentPrompt!.id, action:'answer', text:value, channel:'confirmed-transcript', choiceConfirmation:{ optionTranscript:current.currentPrompt!.choices!.find(c => c.value === value)!.label, confirmationTranscript:'Yes', confirmationMethod:'voice' } });
  return { send, choice, current:() => current, writes:() => writes, draft:() => decodeDocument<Draft>(native!), propose };
}
describe('actual handler PHQ battery continuation', () => {
  it('continues four separately confirmed exact items and calculates only after the fourth; replay makes no write', async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index++) {
      expect(f.current().currentPrompt?.id).toBe(`Q16:MH0${index + 1}`);
      const input = f.choice(['1','0','1','3'][index]);
      expect((await f.send(input)).status).toBe(200);
      const count = f.writes(); expect((await f.send(input)).status).toBe(200); expect(f.writes()).toBe(count);
      const screen = f.current().topics.find(t => t.id === 'Q16')!.screening!;
      expect(screen.scores).toEqual(index === 3 ? { gad2:1, phq2:4, phq4:5 } : null);
    }
    expect(f.current().currentPrompt?.id).not.toMatch(/^Q16:MH0/);
    expect(f.draft().turns.filter(t => t.role === 'patient')).toHaveLength(8);
    expect(Object.values(f.draft().topics.Q16.answers).map(a => a.sourceIds.length)).toEqual([2,2,2,2]);
    expect(f.current().topics.find(t => t.id === 'Q16')!.screening).toMatchObject({ status:'complete', clinicianReviewRequired:true, clinicalClearance:false });
    expect(f.propose).not.toHaveBeenCalled();
  });
  it('continues past an explicitly unknown item while all screening totals stay absent', async () => {
    const f = await fixture(); await f.send(f.choice('0'));
    expect(f.current().currentPrompt?.id).toBe('Q16:MH02');
    await f.send({ requestId:crypto.randomUUID(), expectedRevision:f.current().revision, promptId:'Q16:MH02', action:'unknown', channel:'text' });
    expect(f.current().currentPrompt?.id).toBe('Q16:MH03'); await f.send(f.choice('0'));
    expect(f.current().currentPrompt?.id).toBe('Q16:MH04'); await f.send(f.choice('0'));
    expect(f.draft().topics.Q16.answers.MH02).toMatchObject({ state:'unknown' });
    expect(f.current().topics.find(t => t.id === 'Q16')!.screening).toMatchObject({ status:'incomplete', scores:null });
    expect(f.propose).not.toHaveBeenCalled();
  });
  it('starts at the explicitly selected item and retains decline/safety precedence and stale rejection', async () => {
    const f = await fixture('MH03'), initial = f.choice('0'); await f.send(initial);
    expect(f.current().currentPrompt?.id).toBe('Q16:MH04');
    expect((await f.send({ ...initial, requestId:crypto.randomUUID() })).status).toBe(409);
    await f.send({ requestId:crypto.randomUUID(), expectedRevision:f.current().revision, promptId:'Q16:MH04', action:'decline', channel:'text' });
    expect(f.current().currentPrompt?.id).not.toMatch(/^Q16:MH0/); expect(f.draft().topics.Q16.stopped).toBe('patient-declines');
    expect(f.current().topics.find(t => t.id === 'Q16')!.screening?.scores).toBeNull();
    const s = await fixture(); await s.send({ requestId:crypto.randomUUID(), expectedRevision:s.current().revision, promptId:'Q16:MH01', action:'answer', text:'I may hurt myself tonight.', channel:'unreviewed-transcript', choiceTranscriptOnly:true, priorChoiceTranscript:'Several days' });
    expect(s.current().currentPrompt).toBeUndefined(); expect(s.draft().topics.Q16.answers.MH01).toBeUndefined(); expect(s.draft().safety?.paused).toBe(true);
  });
});
