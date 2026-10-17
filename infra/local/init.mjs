import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(target)) {
  console.log('Local configuration already exists; preserved.');
} else {
  const secret = () => randomBytes(32).toString('hex');
  writeFileSync(target, [
    'MEDPLUM_DATABASE_PASSWORD=' + secret(),
    'MEDPLUM_REDIS_PASSWORD=' + secret(),
    'MEDPLUM_DEFAULT_SUPER_ADMIN_EMAIL=unfiltered-local@example.invalid',
    'MEDPLUM_DEFAULT_SUPER_ADMIN_PASSWORD=' + secret(),
    'MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID=' + randomUUID(),
    'MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_SECRET=' + secret(),
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('Created private local configuration. No credentials were printed.');
}
