import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, readdirSync, mkdirSync, writeFileSync, readFileSync, chownSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { medplumProfile } from './profile.schema.ts';
import { profileDigest } from './render.mjs';

/** Pure decision boundary, independently testable without a block-device mutation. */
export function selectVolume(devices, volumeId) {
  if (!/^vol-[a-f0-9]{17}$/.test(volumeId) || !Array.isArray(devices)) throw new Error('volume-identity-invalid');
  const selected = devices.filter(device => device.type === 'disk' && String(device.serial).replaceAll('-', '') === volumeId.replaceAll('-', ''));
  if (selected.length !== 1 || selected[0].children?.length || !/^\/dev\/nvme[0-9]+n[0-9]+$/.test(selected[0].path)) throw new Error('exact-whole-ebs-volume-required');
  const device = selected[0];
  if (device.mountpoints?.some(Boolean)) throw new Error('already-mounted-volume-denied');
  return device;
}
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
export function requireUnmounted(mount, run = command) {
  try {
    run('/usr/bin/findmnt', ['--json', '--mountpoint', mount, '--output', 'SOURCE,TARGET,FSTYPE,UUID']);
    throw new Error('initialization-over-mounted-filesystem-denied');
  } catch (error) {
    if (error.status !== 1 || String(error.stderr ?? '').trim()) throw error;
  }
}
export function mountedIdentity(mount, volumeId, profile, run = command) {
  if (!/^vol-[a-f0-9]{17}$/.test(volumeId)) throw new Error('volume-identity-invalid');
  if (realpathSync(mount) !== resolve(mount) || !lstatSync(mount).isDirectory()) throw new Error('volume-path-invalid');
  const rows = JSON.parse(run('/usr/bin/findmnt', ['--json', '--mountpoint', mount, '--output', 'SOURCE,TARGET,FSTYPE,UUID'])).filesystems;
  if (rows?.length !== 1 || rows[0].target !== mount || rows[0].fstype !== 'ext4' || !rows[0].uuid) throw new Error('exact-data-mount-required');
  const inventory = JSON.parse(run('/usr/bin/lsblk', ['--json', '--paths', '--output', 'PATH,SERIAL,TYPE,MOUNTPOINTS,FSTYPE,UUID'])).blockdevices;
  const device = inventory.filter(item => item.type === 'disk' && String(item.serial).replaceAll('-', '') === volumeId.replaceAll('-', ''));
  if (device.length !== 1 || device[0].path !== rows[0].source || device[0].children?.length || device[0].uuid !== rows[0].uuid) throw new Error('mounted-volume-identity-invalid');
  const markerPath = join(mount, '.authority.json'), info = lstatSync(markerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('authority-marker-invalid');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.schema !== 1 || marker.stackId !== profile.clinic.stackId || !['empty', 'initialized', 'restore-in-progress', 'restored-sealed'].includes(marker.state) || marker.volumeId !== volumeId || marker.filesystemUuid !== rows[0].uuid || marker.profileHash !== profileDigest(profile)) throw new Error('mounted-authority-identity-invalid');
  return marker;
}

export function mountExisting({ volumeId, mount, profile, run = command }) {
  let current;
  try { current = JSON.parse(run('/usr/bin/findmnt', ['--json', '--mountpoint', mount, '--output', 'SOURCE,TARGET,FSTYPE,UUID'])); }
  catch (error) { if (error.status !== 1 || String(error.stderr ?? '').trim()) throw error; }
  if (current) return mountedIdentity(mount, volumeId, profile, run);
  if (existsSync(mount) && (lstatSync(mount).isSymbolicLink() || realpathSync(mount) !== resolve(mount) || readdirSync(mount).length)) throw new Error('empty-unmounted-mountpoint-required');
  const device = selectVolume(JSON.parse(run('/usr/bin/lsblk', ['--json', '--paths', '--output', 'PATH,SERIAL,TYPE,MOUNTPOINTS,FSTYPE,UUID'])).blockdevices, volumeId);
  if (device.fstype !== 'ext4' || !device.uuid) throw new Error('preinitialized-ext4-volume-required');
  mkdirSync(mount, { recursive: true, mode: 0o700 });
  run('/usr/bin/mount', ['-t', 'ext4', '-o', 'nodev,nosuid,noexec', `UUID=${device.uuid}`, mount]);
  return mountedIdentity(mount, volumeId, profile, run);
}

/** Explicit operator action only. Never invoked by AWS bootstrap or service restart. */
export function initializeFresh({ volumeId, mount, profile, acknowledgedNewResource, run = command }) {
  if (acknowledgedNewResource !== volumeId || process.getuid?.() !== 0 || !existsSync(mount) || realpathSync(mount) !== resolve(mount) || readdirSync(mount).length) throw new Error('fresh-resource-and-empty-mountpoint-required');
  requireUnmounted(mount, run);
  const device = selectVolume(JSON.parse(run('/usr/bin/lsblk', ['--json', '--paths', '--output', 'PATH,SERIAL,TYPE,MOUNTPOINTS,FSTYPE,UUID'])).blockdevices, volumeId);
  if (device.fstype || device.uuid || JSON.parse(run('/usr/sbin/wipefs', ['--json', '--no-act', device.path])).signatures?.length) throw new Error('existing-volume-content-denied');
  // The operator must independently establish this is the new CFN-created EBS resource.
  // Signature absence cannot prove arbitrary raw media contains no data.
  const intent = `/opt/unfiltered-medplum/initialize-${volumeId}.intent`;
  writeFileSync(intent, JSON.stringify({ volumeId, profileHash: profileDigest(profile) }), { flag: 'wx', mode: 0o600 });
  run('/usr/sbin/mkfs.ext4', ['-q', device.path]);
  const updated = selectVolume(JSON.parse(run('/usr/bin/lsblk', ['--json', '--paths', '--output', 'PATH,SERIAL,TYPE,MOUNTPOINTS,FSTYPE,UUID'])).blockdevices, volumeId);
  run('/usr/bin/mount', ['-t', 'ext4', '-o', 'nodev,nosuid,noexec', `UUID=${updated.uuid}`, mount]);
  for (const [name, uid] of [['postgres', 999], ['redis', 999], ['binary', 1000]]) { const path = join(mount, name); mkdirSync(path, { mode: 0o700 }); chownSync(path, uid, uid); }
  writeFileSync(join(mount, '.authority.json'), JSON.stringify({ schema: 1, stackId: profile.clinic.stackId, profileHash: profileDigest(profile), volumeId,
    filesystemUuid: updated.uuid, state: 'empty' }), { flag: 'wx', mode: 0o600 });
  return mountedIdentity(mount, volumeId, profile, run);
}

if (process.argv.includes('--volume-id')) {
  try {
    const arg = name => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error('argument-required'); return process.argv[i + 1]; };
    const profile = medplumProfile(JSON.parse(readFileSync(arg('--clinic'), 'utf8'))), volumeId = arg('--volume-id');
    const result = process.argv.includes('--initialize-new-resource') ? initializeFresh({ volumeId, mount: profile.storage.mount, profile, acknowledgedNewResource: arg('--initialize-new-resource') }) : mountExisting({ volumeId, mount: profile.storage.mount, profile });
    console.log(JSON.stringify({ state: 'volume-mounted', authorityState: result.state }));
  } catch { console.error('medplum-volume-operation-failed'); process.exitCode = 1; }
}
