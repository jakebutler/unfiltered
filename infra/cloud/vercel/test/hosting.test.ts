import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { hostedClinicConfig } from '../hosted-config.js';
import { createHostedClinicServer } from '../application.js';
import { loadClinicAssets, serveClinicAsset, type ClinicAssets } from '../static-assets.js';
import { hostedInterpreterProviders } from '../../../../apps/clinic-server/src/providers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const origin = 'https://clinic.example';
const fixture = () => ({
  origin, medplumBaseUrl: 'https://api.medplum.com/', projectId: '13eaac67-a2c3-4aa1-aa9e-590a083e5fef', clientId: '50db76bd-d099-4305-8ec3-7439ffc38ca1', clientSecret: 'synthetic-client-secret', cookieSecret: 'synthetic-cookie-secret-at-least-32-characters', mentalHealth: 'phq4',
  patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(scenario => [scenario, { reference: 'Patient/primary', displayName: 'Alex (synthetic)', description: 'Synthetic clinic fixture.', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/administrative' } }])),
  staff: ['physician', 'registered-dietitian', 'administrative', 'physician'].map((role, index) => ({ membershipId: `member-${index}`, profile: `Practitioner/staff-${index}`, policy: `AccessPolicy/policy-${index}`, name: `Synthetic staff ${index}`, role, patients: [index === 3 ? 'Patient/unrelated' : 'Patient/primary'], careTeams: [] })),
  storageQualification: { signature: 'a'.repeat(64), payload: { schema: 2, purpose: 'synthetic-clinic-conditional-resumable', deliveryContract: 'conditional-resumable-v1', mode: 'live', origin, expiresAt: new Date(Date.now() + 3600000).toISOString(), identity: { endpoint: 'https://api.medplum.com/fhir/R4/', projectId: '13eaac67-a2c3-4aa1-aa9e-590a083e5fef', clientId: '50db76bd-d099-4305-8ec3-7439ffc38ca1', membershipId: '6e565de2-837d-4618-9578-f6428fbb0be1' } } },
});
const assets = (): ClinicAssets => new Map([
  ['/index.html', { body: new TextEncoder().encode('<main>Corvo Clinic</main>'), contentType: 'text/html; charset=utf-8', digest: hash('<main>Corvo Clinic</main>'), immutable: false }],
  ['/assets/app-12345678.js', { body: new TextEncoder().encode('/* public code */'), contentType: 'text/javascript; charset=utf-8', digest: hash('/* public code */'), immutable: true }],
]);

describe('hosted configuration boundary', () => {
  it('accepts only the pinned cloud fixture and leaves cryptographic/native verification to runtime', () => {
    expect(hostedClinicConfig({ CLINIC_CONFIG_JSON: JSON.stringify(fixture()) }).origin).toBe(origin);
  });
  it.each(['project', 'client', 'member', 'origin', 'local', 'expiry', 'scenario', 'oversize'])('rejects %s drift before runtime access', change => {
    const config = fixture();
    if (change === 'project') config.projectId = 'another-project';
    if (change === 'client') config.clientId = 'another-client';
    if (change === 'member') config.storageQualification.payload.identity.membershipId = 'another-member';
    if (change === 'origin') config.storageQualification.payload.origin = 'https://another.example';
    if (change === 'local') config.medplumBaseUrl = 'http://localhost:8103/';
    if (change === 'expiry') config.storageQualification.payload.expiresAt = new Date(0).toISOString();
    if (change === 'scenario') delete config.patients.refill;
    const raw = change === 'oversize' ? 'x'.repeat(48001) : JSON.stringify(config);
    expect(() => hostedClinicConfig({ CLINIC_CONFIG_JSON: raw })).toThrow('hosted-clinic-configuration-invalid');
  });
  it('does not load a local credential path or expose malformed input in an error', () => {
    expect(() => hostedClinicConfig({ CLINIC_CONFIG_PATH: '/private/env' })).toThrow('hosted-clinic-configuration-invalid');
    expect(() => hostedClinicConfig({ CLINIC_CONFIG_JSON: 'synthetic-secret-not-json' })).toThrow(/^hosted-clinic-configuration-invalid$/);
  });
});

describe('hosted static boundary', () => {
  it('serves known page/asset routes, supports HEAD/ETag, and keeps pages revalidated', async () => {
    for (const path of ['/', '/staff', '/staff/']) {
      const response = serveClinicAsset(new Request(origin + path), assets());
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(await response.text()).toContain('Corvo Clinic');
    }
    const asset = serveClinicAsset(new Request(origin + '/assets/app-12345678.js'), assets());
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(serveClinicAsset(new Request(origin + '/assets/app-12345678.js', { headers: { 'if-none-match': asset.headers.get('etag')! } }), assets()).status).toBe(304);
    expect(await serveClinicAsset(new Request(origin + '/', { method: 'HEAD' }), assets()).text()).toBe('');
  });
  it.each(['/.env.local', '/server.cjs', '/asset-manifest.json', '/package-receipt.json', '/assets/app.js.map', '/missing', '/%2e%2e/private/clinic-config.json'])('does not turn %s into an SPA or disk read', path => {
    expect(serveClinicAsset(new Request(origin + path), assets()).status).toBe(404);
  });
  it('refuses tampered artifacts and symlinks outside the public directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvo-host-assets-')), publicPath = join(directory, 'public'); mkdirSync(publicPath);
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(publicPath, 'index.html'), 'expected');
    writeFileSync(join(directory, 'asset-manifest.json'), JSON.stringify({ files: [{ path: 'index.html', digest: hash('expected') }] }));
    expect(loadClinicAssets(publicPath).size).toBe(1);
    writeFileSync(join(publicPath, 'index.html'), 'changed');
    expect(() => loadClinicAssets(publicPath)).toThrow('clinic-asset-integrity-failed');
    rmSync(join(publicPath, 'index.html')); writeFileSync(join(directory, 'private.txt'), 'private'); symlinkSync(join(directory, 'private.txt'), join(publicPath, 'index.html'));
    expect(() => loadClinicAssets(publicPath)).toThrow('clinic-asset-outside-public-directory');
  });
});

async function runningFixture(speech = false) {
  const runtime = vi.fn(async () => { throw new Error('must-not-contact-medplum'); });
  const reserve = vi.fn(async () => { throw new Error('must-not-dispatch-provider'); });
  const connect = vi.fn(() => { throw new Error('must-not-dispatch-provider'); });
  const application = createHostedClinicServer({ config: hostedClinicConfig({ CLINIC_CONFIG_JSON: JSON.stringify(fixture()) }), assets: assets(), runtime, ...(speech ? { providers: { speech: { admission: { reserve }, deepgramApiKey: 'synthetic-deepgram-key', elevenlabsApiKey: 'synthetic-elevenlabs-key', connect } } } : {}) });
  application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
  const url = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`;
  cleanups.push(async () => { application.server.closeAllConnections(); application.close(); if (application.server.listening) await once(application.server, 'close'); });
  return { ...application, url, runtime, reserve, connect };
}

describe('single hosted server composition', () => {
  it('serves the app and existing API on one origin with providers off and no native calls', async () => {
    const app = await runningFixture();
    expect(await (await fetch(app.url + '/staff')).text()).toContain('Corvo Clinic');
    const config = await (await fetch(app.url + '/api/clinic/config')).json();
    expect(config.conversation.mode).toBe('guided'); expect(config.voice.available).toBe(false);
    const unknown = await fetch(app.url + '/api/not-found'); expect(unknown.status).toBe(404); expect(unknown.headers.get('content-type')).toContain('json');
    expect(app.runtime).not.toHaveBeenCalled();
  });
  it.each([false, true])('keeps denied upgrades away from provider adapters (injected=%s)', async speech => {
    const app = await runningFixture(speech);
    const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/api/clinic/speech/input', { headers: { origin } });
    socket.on('error', () => undefined); cleanups.push(() => socket.terminate());
    await expect(once(socket, 'open')).rejects.toThrow();
    expect(app.reserve).not.toHaveBeenCalled(); expect(app.connect).not.toHaveBeenCalled(); expect(app.runtime).not.toHaveBeenCalled();
  });
});

describe('hosted push-to-talk upload composition', () => {
  it('advertises browser-read upload voice and refuses unauthenticated transcription before admission', async () => {
    const runtime = vi.fn(async () => { throw new Error('must-not-contact-medplum'); });
    const reserve = vi.fn(async () => { throw new Error('must-not-dispatch-provider'); });
    const application = createHostedClinicServer({ config: hostedClinicConfig({ CLINIC_CONFIG_JSON: JSON.stringify(fixture()) }), assets: assets(), runtime, providers: { speechUpload: { deepgramApiKey: 'synthetic-deepgram-key', admission: { reserve } } } });
    application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
    const url = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`;
    cleanups.push(async () => { application.server.closeAllConnections(); application.close(); if (application.server.listening) await once(application.server, 'close'); });
    const config = await (await fetch(url + '/api/clinic/config')).json();
    expect(config.voice).toMatchObject({ available: true, input: 'upload', output: 'browser' });
    const denied = await fetch(url + '/api/clinic/speech/transcriptions?sessionId=6f1f3d3e-2d4b-4c1e-9a53-3c1b2a4d5e6f&promptId=p&expectedRevision=0&requestId=0b8f6a4e-7c2d-4e91-8f3a-1d2c3b4a5e6f', { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2]) });
    expect(denied.status).toBeGreaterThanOrEqual(400); expect(denied.headers.get('content-type')).toContain('json');
    expect(reserve).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled();
  });
});

const policy = { id: 'synthetic-hosted', limits: Object.fromEntries(['digitalocean', 'deepgram', 'elevenlabs'].map(provider => [provider, { account: { requests: 3, inputBytes: 180000, outputTokens: 12288, characters: 3000, audioSeconds: 180 }, session: { requests: 2, inputBytes: 120000, outputTokens: 8192, characters: 2000, audioSeconds: 120 }, concurrency: 1, leaseMs: provider === 'digitalocean' ? 20000 : provider === 'deepgram' ? 70000 : 35000 }])) };
const hostedEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ CLINIC_ADAPTIVE_INTERPRETER: 'intake-v1', DIGITALOCEAN_MODEL_ACCESS_KEY: 'synthetic-do-key', CLINIC_PROVIDER_POLICY_JSON: JSON.stringify(policy), ...extra });
describe('hosted provider wiring for speech upload', () => {
  it('builds a lazy Deepgram upload admission only when explicitly configured', () => {
    const runtime = vi.fn(async () => { throw new Error('must-not-contact-medplum'); });
    const providers = hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_INPUT: 'deepgram-rest', DEEPGRAM_API_KEY: 'synthetic-deepgram-key' }));
    expect(providers.speechUpload?.deepgramApiKey).toBe('synthetic-deepgram-key');
    expect(typeof providers.speechUpload?.admission.reserve).toBe('function');
    expect(runtime).not.toHaveBeenCalled();
    expect(hostedInterpreterProviders(runtime, hostedEnv()).speechUpload).toBeUndefined();
  });
  it('fails closed on missing credentials, unknown speech modes, and speech without the interpreter', () => {
    const runtime = async () => { throw new Error('must-not-contact-medplum'); };
    expect(() => hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_INPUT: 'deepgram-rest' }))).toThrow('speech-credentials-required');
    expect(() => hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_INPUT: 'other', DEEPGRAM_API_KEY: 'synthetic-deepgram-key' }))).toThrow('unknown-speech-input');
    expect(() => hostedInterpreterProviders(runtime, { CLINIC_SPEECH_INPUT: 'deepgram-rest', DEEPGRAM_API_KEY: 'synthetic-deepgram-key' })).toThrow('speech-input-requires-interpreter');
  });
});

describe('hosted hands-free (direct Deepgram) composition', () => {
  async function directApp(withOutput: boolean) {
    const runtime = vi.fn(async () => { throw new Error('must-not-contact-medplum'); });
    const reserve = vi.fn(async () => { throw new Error('must-not-dispatch-provider'); });
    const speech = { admission: { reserve } };
    const application = createHostedClinicServer({ config: hostedClinicConfig({ CLINIC_CONFIG_JSON: JSON.stringify(fixture()) }), assets: assets(), runtime, providers: { speechUpload: { deepgramApiKey: 'synthetic-deepgram-key', ...speech }, speechDirect: { deepgramApiKey: 'synthetic-deepgram-key', ...speech }, ...(withOutput ? { speechOutput: { elevenlabsApiKey: 'synthetic-elevenlabs-key', ...speech } } : {}) } });
    application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
    const url = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`;
    cleanups.push(async () => { application.server.closeAllConnections(); application.close(); if (application.server.listening) await once(application.server, 'close'); });
    return { url, runtime, reserve };
  }
  it('advertises direct input, lets the page reach only Deepgram, and refuses unauthenticated tokens before admission', async () => {
    const app = await directApp(false);
    const config = await (await fetch(app.url + '/api/clinic/config')).json();
    expect(config.voice).toMatchObject({ available: true, input: 'direct', output: 'browser' });
    const csp = (await fetch(app.url + '/')).headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'self' wss://clinic.example wss://api.deepgram.com;");
    const body = JSON.stringify({ requestId: '0b8f6a4e-7c2d-4e91-8f3a-1d2c3b4a5e6f', sessionId: '6f1f3d3e-2d4b-4c1e-9a53-3c1b2a4d5e6f', promptId: 'p', expectedRevision: 0 });
    const denied = await fetch(app.url + '/api/clinic/speech/tokens', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
    expect(denied.status).toBeGreaterThanOrEqual(400); expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await denied.json())).not.toContain('synthetic-deepgram-key');
    expect(app.reserve).not.toHaveBeenCalled(); expect(app.runtime).not.toHaveBeenCalled();
  });
  it('serves ElevenLabs read-aloud only when configured, behind the same patient authorization', async () => {
    const app = await directApp(true);
    expect((await (await fetch(app.url + '/api/clinic/config')).json()).voice.output).toBe('provider');
    const body = JSON.stringify({ requestId: '0b8f6a4e-7c2d-4e91-8f3a-1d2c3b4a5e6f', sessionId: '6f1f3d3e-2d4b-4c1e-9a53-3c1b2a4d5e6f', expectedRevision: 0, sourceId: 'p' });
    const denied = await fetch(app.url + '/api/clinic/speech/output', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(app.reserve).not.toHaveBeenCalled(); expect(app.runtime).not.toHaveBeenCalled();
    const browserOnly = await directApp(false);
    expect((await fetch(browserOnly.url + '/api/clinic/speech/output', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body })).status).toBe(404);
  });
  it('wires direct tokens and optional ElevenLabs only from explicit env, failing closed on gaps', () => {
    const runtime = vi.fn(async () => { throw new Error('must-not-contact-medplum'); });
    const direct = hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_INPUT: 'deepgram-direct', DEEPGRAM_API_KEY: 'synthetic-deepgram-key' }));
    expect(direct.speechDirect?.deepgramApiKey).toBe('synthetic-deepgram-key'); expect(direct.speechUpload).toBeDefined(); expect(direct.speechOutput).toBeUndefined();
    expect(hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_INPUT: 'deepgram-rest', DEEPGRAM_API_KEY: 'synthetic-deepgram-key' })).speechDirect).toBeUndefined();
    const voiced = hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_INPUT: 'deepgram-direct', CLINIC_SPEECH_OUTPUT: 'elevenlabs', DEEPGRAM_API_KEY: 'synthetic-deepgram-key', ELEVENLABS_API_KEY: 'synthetic-elevenlabs-key' }));
    expect(voiced.speechOutput?.elevenlabsApiKey).toBe('synthetic-elevenlabs-key');
    expect(() => hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_INPUT: 'deepgram-direct', CLINIC_SPEECH_OUTPUT: 'elevenlabs', DEEPGRAM_API_KEY: 'synthetic-deepgram-key' }))).toThrow('speech-credentials-required');
    expect(() => hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_OUTPUT: 'elevenlabs', ELEVENLABS_API_KEY: 'synthetic-elevenlabs-key' }))).toThrow('speech-output-requires-input');
    expect(() => hostedInterpreterProviders(runtime, hostedEnv({ CLINIC_SPEECH_INPUT: 'deepgram-direct', CLINIC_SPEECH_OUTPUT: 'loud', DEEPGRAM_API_KEY: 'synthetic-deepgram-key' }))).toThrow('unknown-speech-output');
    expect(runtime).not.toHaveBeenCalled();
  });
});
