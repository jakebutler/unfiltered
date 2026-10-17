import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { prepareSealingBundle, verifySealingBundle, sealingBundleFile, sealingModules } from './sealing-bundle.mjs';

const require = createRequire(import.meta.url);
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-sealing-'));
  const built = join(directory, 'build'), artifact = join(directory, 'artifact');
  const files = {
    [sealingModules[0]]: `const domain = require('../../clinical-core/src/domain.js'); const qualification = require('../../clinical-core/src/qualification.js'); exports.observeRuntimeProjection = () => domain.value; exports.sealDeploymentQualification = () => qualification.value;`,
    [sealingModules[1]]: `const medplum = require('../../clinical-core/src/medplum.js'); exports.runtimeProvider = () => medplum.value;`,
    'packages/clinical-core/src/domain.js': `exports.value = require('./transport.js').value;`,
    'packages/clinical-core/src/qualification.js': `exports.value = 'qualified';`,
    'packages/clinical-core/src/transport.js': `require('node:crypto'); exports.value = 'transport';`,
    'packages/clinical-core/src/medplum.js': `exports.value = require('test-dependency').value;`,
    'node_modules/test-dependency/package.json': JSON.stringify({ name: 'test-dependency', main: 'index.js' }),
    'node_modules/test-dependency/index.js': `exports.value = 'dependency';`,
  };
  try {
    await mkdir(artifact, { recursive: true });
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(built, path, '..'), { recursive: true });
      await writeFile(join(built, path), contents);
    }
    await run({ built, artifact });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('reviewed bundle includes transitive application and package dependencies and loads without its source tree', async () => {
  await fixture(async ({ built, artifact }) => {
    const receipt = await prepareSealingBundle(built, artifact);
    for (const path of ['domain.js', 'qualification.js', 'transport.js', 'medplum.js', 'test-dependency/index.js']) {
      assert(Object.keys(receipt.inputs).some(input => input.endsWith(path)), `missing dependency ${path}`);
    }
    const path = await verifySealingBundle(receipt, artifact);
    await rm(built, { recursive: true });
    const reviewed = require(path);
    assert.equal(reviewed.observeRuntimeProjection(), 'transport');
    assert.equal(reviewed.sealDeploymentQualification(), 'qualified');
    assert.equal(reviewed.runtimeProvider(), 'dependency');
  });
});

for (const path of ['packages/clinical-core/src/domain.js', 'packages/clinical-core/src/qualification.js', 'packages/clinical-core/src/transport.js', 'packages/clinical-core/src/medplum.js', 'node_modules/test-dependency/index.js']) {
  test(`rejects post-review dependency changes: ${path}`, async () => {
    await fixture(async ({ built, artifact }) => {
      const receipt = await prepareSealingBundle(built, artifact);
      await writeFile(join(built, path), `throw new Error('changed dependency must never execute');`);
      await assert.rejects(verifySealingBundle(receipt, artifact), /reviewed-sealing-dependency-diff/);
    });
  });
}

test('rejects a changed bundle and old two-entrypoint receipts', async () => {
  await fixture(async ({ built, artifact }) => {
    const receipt = await prepareSealingBundle(built, artifact);
    const path = join(artifact, sealingBundleFile);
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n// changed\n')]));
    await assert.rejects(verifySealingBundle(receipt, artifact), /reviewed-sealing-dependency-diff/);
    await assert.rejects(verifySealingBundle({ sealingModuleSha256: {} }, artifact), /reviewed-sealing-dependency-diff/);
  });
});
