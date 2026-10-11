import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { parsePackageManifest, hostedResearchConfig } from '../config';
import { createHostedResearchServer } from '../application';
import { createResearchSpeechTransport } from '../../../../../apps/research-server/src/research-speech';
import { HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE, type HostedResearchConfig } from '../../../../../apps/research-server/src/hosted-runtime';
import { fakeHostedAuthority } from '../../../../../apps/research-server/test/hosted-test-authority';
import type { InterviewContext } from '../../../../../packages/research-core/src/interview';
import type { InterviewAuthority } from '../../../../../apps/research-server/src/interview';
import type { PrivateObjectStore } from '../../../../../packages/research-capture/src/contracts';
const origin = 'https://research.example.test';
const manifest = { schema: 1, mode: 'offline-fixture', canonicalOrigin: origin, deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, r2: { accountId: '728ae4b71b42dfcef062336c06bd8595', bucket: 'unfiltered-recordings', namespace: 'synthetic-fixture', deadlineMs: 1000 }, maxSegmentBytes: 4000000, maxResponseBytes: 4000000, ffmpeg: { sha256: '1'.repeat(64), bytes: 64, architecture: 'linux-x64', version: 'offline-header-fixture', source: 'https://example.test/fixture', license: 'LGPL-2.1-or-later', licenseSha256: '2'.repeat(64) } };
const config: HostedResearchConfig = { mode: 'hosted', deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, publicOrigin: origin, gatewaySecret: 'a'.repeat(64), maxSegmentBytes: 4000000, maxResponseBytes: 4000000, cleanupMode: 'durable' };
const scope = { sessionId: 'synthetic-session', promptId: 'q1', expectedRevision: 2, answerSourceId: 'source-one', requestId: 'interview-request-1' };
function fixture(interviewRuntime?: import('../../../../../apps/research-server/src/interview').InterviewRuntime, reportFactory?: import('../../../../../apps/research-server/src/hosted-runtime').HostedResearchInjection['reportFactory'], analysisRuntime?: import('../../../../../apps/research-server/src/analysis').AnalysisRuntime) {
  const context: InterviewContext = { sessionId: scope.sessionId, revision: 2, consentEpoch: 1, retainUntil: Date.now() + 60000, goals: ['Understand delivery'], script: [{ id: 'q1', question: 'What happened?' }, { id: 'q2', question: 'What would you change?' }], scriptIndex: 0, currentPrompt: { id: 'q1', scriptQuestionId: 'q1', kind: 'script', question: 'What happened?', followUpNumber: 0 }, followUps: [], answer: { sourceId: scope.answerSourceId, promptId: 'q1', text: 'Delivery cost was unclear.', channel: 'text', intent: 'answer' } };
  const interview = { inspect: vi.fn(async () => context), advance: vi.fn(async () => {}), admit: vi.fn(), begin: vi.fn(), finish: vi.fn() } as InterviewAuthority;
  const store = { head: vi.fn(), read: vi.fn(), putIfAbsent: vi.fn(), retire: vi.fn() } as PrivateObjectStore;
  const native = fakeHostedAuthority();
  const speech = createResearchSpeechTransport({ origin, enabled: false, authority: {} as any, ingress: { reserve: vi.fn(async () => { throw new Error('Unallocated synthetic fixture'); }) } });
  const assets = new Map([['/index.html', { body: new TextEncoder().encode('<main>synthetic</main>'), contentType: 'text/html', digest: 'a'.repeat(64), immutable: false }]]);
  const app = createHostedResearchServer({ config, assets, injection: { store, hostedAuthority: native, reportFactory, analysisRuntime }, speech, interviewRuntime, interviewFactory: () => interview });
  return { app, native, store, interview };
}
const request = (headers: Record<string, string> = {}) => { const body = JSON.stringify(scope); return new Request(`${origin}/api/research/interview`, { method: 'POST', headers: { Host: new URL(origin).host, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'X-Research-Participant': 'a'.repeat(64), ...headers }, body }); };
test('public manifest excludes secrets, fake deployment and accidental offline activation', () => {
  expect(parsePackageManifest(manifest).mode).toBe('offline-fixture');
  for (const changed of [{ apiKey: 'secret' }, { deployment: 'https://other.convex.cloud' }, { mode: 'deployable-candidate' }]) expect(() => parsePackageManifest({ ...manifest, ...changed })).toThrow();
  expect(() => hostedResearchConfig({ RESEARCH_RUNTIME_JSON: '{}' }, manifest, '/bin/ffmpeg')).toThrow('Offline package');
  const real = { ...manifest, mode: 'deployable-candidate', canonicalOrigin: 'https://research.example.com' };
  const env = { RESEARCH_RUNTIME_JSON: JSON.stringify({ gatewaySecret: 'a'.repeat(64), allocationId: 'synthetic-allocation' }), RESEARCH_R2_ACCESS_KEY_ID: 'synthetic', RESEARCH_R2_SECRET_ACCESS_KEY: 'synthetic', DIGITALOCEAN_MODEL_ACCESS_KEY: 'keys-alone-do-not-activate' };
  const parsed = hostedResearchConfig(env, real, '/bin/ffmpeg'); expect(parsed.speechEnabled).toBe(false); expect(parsed.analysis.enabled).toBe(false); expect(parsed.interview.enabled).toBe(false); expect(parsed.modelKey).toBeUndefined();
});
test('mounted disabled interview uses the analysis lease and advances script without provider admission', async () => {
  const f = fixture(); try { const response = await f.app.handle(request()); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'advanced', decision: { reason: 'disabled' } }); expect(f.native.acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: 'analysis' })); expect(f.interview.advance).toHaveBeenCalledOnce(); expect(f.interview.admit).not.toHaveBeenCalled(); expect(f.store.head).not.toHaveBeenCalled(); expect(f.native.leases.size).toBe(0); } finally { f.app.close(); }
});
test('host and origin denial still happen before lease, body, interview or storage dispatch', async () => {
  const f = fixture(); try { for (const headers of [{ Host: 'other.test' }, { Origin: 'https://other.test' }]) expect((await f.app.handle(request(headers))).status).toBe(403); expect(f.native.acquire).not.toHaveBeenCalled(); expect(f.interview.inspect).not.toHaveBeenCalled(); expect(f.store.head).not.toHaveBeenCalled(); } finally { f.app.close(); }
});
test('no native capacity means no interview authority; headers allow capture and fixed Convex only', async () => {
  const f = fixture(); try { vi.mocked(f.native.acquire).mockResolvedValue(null); expect((await f.app.handle(request())).status).toBe(429); expect(f.interview.inspect).not.toHaveBeenCalled(); const page = await f.app.handle(new Request(`${origin}/participate`, { headers: { Host: new URL(origin).host } })); expect(page.status).toBe(200); expect(page.headers.get('Cache-Control')).toBe('private, no-store'); expect(page.headers.get('Permissions-Policy')).toContain('camera=(self)'); expect(page.headers.get('Content-Security-Policy')).toContain(HOSTED_DEPLOYMENT); expect((await f.app.handle(new Request(`${origin}/.env.local`, { headers: { Host: new URL(origin).host } }))).status).toBe(404); } finally { f.app.close(); }
});

test('native HTTP adapter fixes canonical origin without trusting forwarded headers and denies disabled upgrades', async () => {
  const f = fixture();
  f.app.server.listen(0, '127.0.0.1'); await once(f.app.server, 'listening');
  const address = f.app.server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture listener');
  const get = (path: string, headers: Record<string,string>) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve,reject) => {
    const request = httpRequest({ host:'127.0.0.1',port:address.port,path,headers }, response => { let body=''; response.on('data', chunk => { body+=String(chunk); }); response.once('end', () => resolve({status:response.statusCode!,headers:response.headers,body})); }); request.once('error',reject); request.end();
  });
  try {
    const page = await get('/participate', {Host:new URL(origin).host}); expect(page.status).toBe(200); expect(page.body).toContain('synthetic');
    expect((await get('/participate', {Host:'other.test','X-Forwarded-Host':new URL(origin).host})).status).toBe(403);
    expect((await get('https://other.test/participate', {Host:new URL(origin).host})).status).toBe(403);
    const disabled = await get('/api/research/speech/input', {Host:new URL(origin).host,Origin:origin,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='}); expect(disabled.status).toBe(503); expect(f.native.acquire).not.toHaveBeenCalled();
  } finally { f.app.close(); if (f.app.server.listening) await once(f.app.server,'close'); }
});

test('unknown interview response retains native lease until the actual late provider settles', async () => {
  vi.useFakeTimers();
  let complete!: (value: any) => void;
  const provider = { model: 'qwen3.8-max' as const, prepare: vi.fn(async () => ({ inputHash: '1'.repeat(64), requestBytes: 100, maxOutputTokens: 512 })), generate: vi.fn(() => new Promise<any>(resolve => { complete=resolve; })) };
  const f=fixture({enabled:true,provider});
  vi.mocked(f.interview.admit).mockResolvedValue({attemptId:'synthetic-attempt',state:'reserved',reservation:{id:'synthetic-reservation',model:'qwen3.8-max',maxInputBytes:64000,maxOutputTokens:512,expiresAt:Date.now()+60000}});
  vi.mocked(f.interview.begin).mockResolvedValue(true); vi.mocked(f.interview.finish).mockResolvedValue(undefined);
  try {
    const response=f.app.handle(request());
    await vi.advanceTimersByTimeAsync(15001);
    const result=await response; expect(result.status).toBe(200); expect(await result.json()).toMatchObject({state:'unknown'});
    expect(provider.generate).toHaveBeenCalledOnce(); expect(f.native.leases.size).toBe(1); expect(f.native.release).not.toHaveBeenCalled();
    complete({requestId:'synthetic-provider-response',model:'qwen3.8-max',proposal:{decision:'advance'},receipt:{requestId:'synthetic-provider-response',model:'qwen3.8-max',providerExecution:'completed',usage:null,requestBytes:100,elapsedMs:15002},outputHash:'2'.repeat(64)});
    await vi.advanceTimersByTimeAsync(1); expect(f.native.leases.size).toBe(0);
    expect(f.interview.finish).toHaveBeenCalledTimes(1); expect(f.interview.finish).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.anything(),expect.objectContaining({state:'unknown'}));
  } finally { f.app.close(); vi.useRealTimers(); }
});

// Exercise the real Node facade rather than passing an already bodyless Request.
test('empty native DELETE logs out while nonempty DELETE is denied before authority', async () => {
  const logout = vi.fn(async () => {}), f = fixture(undefined, () => ({ logout }) as any);
  f.app.server.listen(0, '127.0.0.1'); await once(f.app.server, 'listening');
  const address = f.app.server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture listener');
  const call = (body?: string, extra: Record<string,string> = {}) => new Promise<number>((resolve,reject) => {
    const req = httpRequest({host:'127.0.0.1',port:address.port,path:'/api/research/portal/session',method:'DELETE',headers:{Host:new URL(origin).host,Origin:origin,Cookie:'research_viewer='+'b'.repeat(64),...(body ? {'Content-Length':String(Buffer.byteLength(body))} : {}),...extra}}, res => {res.resume();res.once('end',()=>resolve(res.statusCode!));});req.once('error',reject);req.end(body);
  });
  try {
    expect(await call()).toBe(204);expect(logout).toHaveBeenCalledExactlyOnceWith({token:'b'.repeat(64)});
    expect(await call(undefined,{'Content-Length':'0'})).toBe(204);expect(logout).toHaveBeenCalledTimes(2);
    expect(await call('x')).toBe(413);expect(logout).toHaveBeenCalledTimes(2);
    expect(await call(undefined,{Origin:'https://other.test'})).toBe(403);expect(logout).toHaveBeenCalledTimes(2);
    expect(f.native.leases.size).toBe(0);expect(f.store.read).not.toHaveBeenCalled();
  } finally {f.app.close();if(f.app.server.listening)await once(f.app.server,'close');}
});

test('hosted application requires prepared study analysis even when a static runtime reservation is valid', async () => {
  const admit = vi.fn(), operator = vi.fn(async () => ({}));
  const runtime = { preparedOnly: false, reservations: [{ id: 'valid-static-reservation', model: 'qwen3.8-max' as const, maxInputBytes: 64000, maxOutputTokens: 128, expiresAt: Date.now() + 60000, live: true }], visionQualified: true, provider: { classification: 'live' as const, model: 'qwen3.8-max' as const, prepare: vi.fn(), generate: vi.fn() } };
  const f = fixture(undefined, () => ({ operator, admit } as any), runtime);
  const body = JSON.stringify({ clientId: 'client', projectId: 'project', requestId: 'request-static', reservationId: runtime.reservations[0].id, selections: [{ sessionId: 'session', kind: 'self-report', id: 'source', start: 0, end: 4 }] });
  try {
    const response = await f.app.handle(new Request(origin + '/api/research/analysis', { method: 'POST', headers: { Host: new URL(origin).host, Origin: origin, Authorization: 'Bearer synthetic', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body }));
    expect(response.status).toBe(409); await response.text();
    expect(operator).toHaveBeenCalledOnce(); expect(admit).not.toHaveBeenCalled(); expect(runtime.provider.generate).not.toHaveBeenCalled();
    expect(runtime.preparedOnly).toBe(false); // The caller's configuration is not mutated.
  } finally { f.app.close(); }
});
