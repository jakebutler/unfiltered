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
module.exports={boundedFile};
