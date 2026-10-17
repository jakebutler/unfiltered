import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateJson } from '../src/config';
const directories: string[] = []; afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'research-private-json-')); directories.push(directory); return directory; }
test('shared private reader remains read-only and accepts bounded mode0600 JSON', async () => {
  const path = join(await fixture(), 'config.private.json'), text = '{"fixture":"synthetic"}\n'; await writeFile(path, text, { mode: 0o600 });
  expect(await privateJson(path)).toEqual({ fixture: 'synthetic' }); expect(await readFile(path, 'utf8')).toBe(text);
});
test('shared private reader rejects public, oversized and symlink files', async () => {
  const directory = await fixture(), path = join(directory, 'public.json'); await writeFile(path, '{}', { mode: 0o644 }); await expect(privateJson(path)).rejects.toThrow('Private');
  const large = join(directory, 'large.json'); await writeFile(large, ' '.repeat(65_537), { mode: 0o600 }); await expect(privateJson(large)).rejects.toThrow('bounded');
  const link = join(directory, 'link.json'); await symlink(path, link); await expect(privateJson(link)).rejects.toThrow();
});
