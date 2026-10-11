import { loadRuntime, argumentsFor, updateMarker, command } from './runtime.mjs';
import { validateData } from './render.mjs';

export async function start(runtime) {
  if (runtime.rendered.phase === 'restore' || !['empty', 'initialized'].includes(runtime.marker.state)) throw new Error('sealed-authority-start-denied');
  validateData(runtime.profile, runtime.data, runtime.rendered.phase);
  // Pull is explicit host provisioning; no image/auth discovery or implicit retry.
  await runtime.run(['pull']);
  for (const service of Object.values(runtime.compose.services)) {
    const architecture = await command('docker', ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', service.image], { env: runtime.env });
    if (architecture.trim() !== 'linux/arm64') throw new Error('actual-image-platform-mismatch');
  }
  await runtime.run(['up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '180']);
  if (runtime.marker.state === 'empty') updateMarker(runtime, 'initialized');
  return { state: 'private-authority-started-unqualified', nativeQualified: false };
}
if (process.argv.includes('--start') || process.argv.includes('--stop')) {
  try {
    const args = argumentsFor(['config', 'project', 'docker-host']), runtime = loadRuntime(args.config, args.project, args['docker-host']);
    const result = process.argv.includes('--stop') ? (await runtime.run(['stop', '--timeout', '30']), { state: 'authority-stopped' }) : await start(runtime);
    console.log(JSON.stringify(result));
  } catch { console.error('medplum-service-operation-failed-or-unknown'); process.exitCode = 1; }
}
