import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredProviders } from '../../../apps/clinic-server/src/providers.js';

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function settings(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-speech-test-')); directories.push(directory);
  const path = join(directory, 'providers.json'); writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  vi.stubEnv('CLINIC_PROVIDER_SETTINGS', path); vi.stubEnv('CLINIC_PROVIDER_ENV_FILE', '');
  vi.stubEnv('DEEPGRAM_API_KEY', 'test-deepgram'); vi.stubEnv('ELEVENLABS_API_KEY', 'test-eleven');
}
const units = { requests: 2, inputBytes: 100000, outputTokens: 9000, characters: 2000, audioSeconds: 120 };
const policy = { id: 'test-speech-config', limits: Object.fromEntries(['digitalocean', 'deepgram', 'elevenlabs'].map(provider => [provider, { account: units, session: units, concurrency: 1, leaseMs: provider === 'digitalocean' ? 20000 : provider === 'deepgram' ? 70000 : 35000 }])) };
describe('speech deployment opt-in', () => {
  it('stays disabled by default even when keys exist', () => { settings({ adaptiveEnabled: false, policy }); const runtime = vi.fn(); expect(configuredProviders(runtime)).toEqual({}); expect(runtime).not.toHaveBeenCalled(); });
  it('requires the explicit speech qualification marker and both server keys', () => {
    settings({ speechEnabled: true, policy }); expect(() => configuredProviders(vi.fn())).toThrow('speech-qualification-required');
    settings({ speechEnabled: true, speechQualification: 'root-reviewed-synthetic-speech', policy }); vi.stubEnv('DEEPGRAM_API_KEY', '');
    expect(() => configuredProviders(vi.fn())).toThrow('speech-credentials-required');
  });
  it('wires only an explicitly enabled speech route without making provider/runtime calls', () => {
    settings({ speechEnabled: true, speechQualification: 'root-reviewed-synthetic-speech', policy });
    const runtime = vi.fn(); const result = configuredProviders(runtime); expect(result.speech?.admission.reserve).toBeTypeOf('function'); expect(result.adaptiveProposer).toBeUndefined(); expect(runtime).not.toHaveBeenCalled();
  });
});
