import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
/** Bounded, private, no-symlink runtime configuration read. */
export async function privateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077 || info.size > 65_536) throw new Error('Private configuration must be a bounded mode-0600 file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
