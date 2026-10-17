const { openSync, fstatSync, readSync, closeSync, constants } = require('node:fs');
const { join } = require('node:path');

function boundedFile(path, maximum, privateFile) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size > maximum || privateFile && info.mode & 0o077) throw new Error('container-runtime-input-invalid');
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0, read;
    while (size < bytes.length && (read = readSync(file, bytes, size, bytes.length - size, null)) > 0) size += read;
    if (size > maximum) throw new Error('container-runtime-input-invalid');
    return bytes.subarray(0, size).toString('utf8');
  } finally { closeSync(file); }
}
function runtimeEnvironment(directory = __dirname, privatePath = '/run/secrets/clinic-config.json') {
  // The immutable image profile wins over environment overrides. Only these two
  // values reach the parser; no provider or AWS credential is copied into it.
  return {
    AWS_DEPLOYMENT_MANIFEST_JSON: boundedFile(join(directory, 'deployment-manifest.json'), 16384, false),
    CLINIC_CONFIG_JSON: boundedFile(privatePath, 48000, true),
  };
}
function main() {
  try { return require('./server.cjs').startAwsClinicApplication(runtimeEnvironment()); }
  catch { console.error('AWS clinic container startup failed'); process.exitCode = 1; }
}
module.exports = { boundedFile, runtimeEnvironment, main };
if (require.main === module) main();
