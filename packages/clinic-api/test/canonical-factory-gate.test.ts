import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { configuredProviders } from '../../../apps/clinic-server/src/providers.js';
let folder: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (folder) rmSync(folder, { recursive: true, force: true }); folder = undefined; });
it.each([false, true])('refuses unqualified canonical settings without legacy fallback (legacy enabled=%s)', adaptiveEnabled => {
  folder = mkdtempSync(join(tmpdir(), 'unfiltered-canonical-gate-'));
  const path = join(folder, 'settings.json');
  writeFileSync(path, JSON.stringify({ canonicalEnabled: true, adaptiveEnabled, qualification: 'root-reviewed-synthetic-adaptive' }), { mode: 0o600 });
  vi.stubEnv('CLINIC_PROVIDER_SETTINGS', path);
  const runtime = vi.fn();
  expect(() => configuredProviders(runtime)).toThrow('canonical-qualification-required');
  expect(runtime).not.toHaveBeenCalled();
});
