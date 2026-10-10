import { constants } from 'node:fs';
import { open, mkdir, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CAPTURE_LIMITS } from '../../../packages/research-capture/src/contracts';

export type ResearchServerConfig = {
  deployment: 'http://127.0.0.1:3210'; publicOrigin: 'http://127.0.0.1:5174';
  gatewaySecret: string; objectDirectory: string; maxSegmentBytes: number;
  cleanupIntervalMs: number; bindOrigin: 'http://127.0.0.1:8789';
};
export async function privateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077 || info.size > 65_536) throw new Error('Private configuration must be a bounded mode-0600 file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
export async function loadConfig(path: string): Promise<ResearchServerConfig> {
  const raw = await privateJson(resolve(path));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid research gateway configuration');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['deployment', 'publicOrigin', 'gatewaySecret', 'maxSegmentBytes', 'cleanupIntervalMs'].includes(key)) || input.deployment !== 'http://127.0.0.1:3210' || input.publicOrigin !== 'http://127.0.0.1:5174' || typeof input.gatewaySecret !== 'string' || !/^[a-f0-9]{64,128}$/.test(input.gatewaySecret)) throw new Error('Only the isolated local research deployment is supported');
  const maxSegmentBytes = input.maxSegmentBytes ?? CAPTURE_LIMITS.segmentBytes, cleanupIntervalMs = input.cleanupIntervalMs ?? 2000;
  if (!Number.isSafeInteger(maxSegmentBytes) || Number(maxSegmentBytes) < 1 || Number(maxSegmentBytes) > CAPTURE_LIMITS.segmentBytes || !Number.isSafeInteger(cleanupIntervalMs) || Number(cleanupIntervalMs) < 1000 || Number(cleanupIntervalMs) > 10_000) throw new Error('Invalid research gateway bounds');
  const directory = dirname(resolve(path)), objectDirectory = resolve(directory, 'media-private');
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Error('Private runtime directory must be mode 0700');
  await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
  const info = await lstat(objectDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Private media directory must be mode 0700');
  return { deployment: input.deployment, publicOrigin: input.publicOrigin, gatewaySecret: input.gatewaySecret, objectDirectory, maxSegmentBytes: Number(maxSegmentBytes), cleanupIntervalMs: Number(cleanupIntervalMs), bindOrigin: 'http://127.0.0.1:8789' };
}
