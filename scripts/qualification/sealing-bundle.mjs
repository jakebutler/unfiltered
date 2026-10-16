/** Freeze the complete schema-3 sealer/runtime import graph for reviewed continuations. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { resolve, join, isAbsolute } from 'node:path';

export const sealingModules = Object.freeze(['packages/clinic-api/src/deployment-qualification.js', 'packages/clinic-api/src/runtime.js']);
export const sealingBundleFile = 'reviewed-sealing-runtime.cjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('reviewed-sealing-dependency-diff'); };
const validPin = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function prepareSealingBundle(buildDirectory, artifactDirectory) {
  // Build tooling is preparation-only; execution loads no mutable package dependency.
  const { build } = await import('esbuild');
  const base = resolve(buildDirectory);
  const result = await build({
    absWorkingDir: base,
    stdin: { contents: `const sealer = require(${JSON.stringify('./' + sealingModules[0])});\nconst runtime = require(${JSON.stringify('./' + sealingModules[1])});\nmodule.exports = { observeRuntimeProjection: sealer.observeRuntimeProjection, sealDeploymentQualification: sealer.sealDeploymentQualification, runtimeProvider: runtime.runtimeProvider };`, resolveDir: base },
    bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    outfile: sealingBundleFile, write: false, metafile: true, logLevel: 'silent',
  });
  // The bundle must be self-contained apart from Node's own runtime modules.
  if (result.warnings.length || result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output => output.imports.some(item => !isBuiltin(item.path)))) fail();
  const inputs = {};
  for (const input of Object.keys(result.metafile.inputs).sort()) {
    if (input === '<stdin>') continue;
    const path = resolve(base, input);
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) fail();
    inputs[path] = sha(await readFile(path));
  }
  const bytes = result.outputFiles[0].contents;
  await writeFile(join(artifactDirectory, sealingBundleFile), bytes, { flag: 'wx', mode: 0o600 });
  return { schema: 1, bundleSha256: sha(bytes), inputs };
}

/** Verify before loading the bundle, reading private inputs, or dispatching any request. */
export async function verifySealingBundle(receipt, artifactDirectory) {
  try {
    if (receipt?.schema !== 1 || !validPin(receipt.bundleSha256) || !receipt.inputs || Array.isArray(receipt.inputs) || typeof receipt.inputs !== 'object' || Object.keys(receipt.inputs).length < sealingModules.length) fail();
    for (const [path, pin] of Object.entries(receipt.inputs)) {
      if (!isAbsolute(path) || !validPin(pin) || !(await lstat(path)).isFile() || await realpath(path) !== path || sha(await readFile(path)) !== pin) fail();
    }
    const path = join(artifactDirectory, sealingBundleFile);
    if (!(await lstat(path)).isFile() || await realpath(path) !== resolve(path) || sha(await readFile(path)) !== receipt.bundleSha256) fail();
    return path;
  } catch { fail(); }
}
