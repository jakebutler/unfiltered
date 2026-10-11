/** Stage only the stream import closure, with immutable AF52 dependencies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const sha = value => createHash('sha256').update(value).digest('hex');
const archive = 'docs/implementation/evidence/SCOPED-EXTRACTION-CANDIDATE-31a116f0d09ebb4a4061b7c803d59c4b179ac36ca8656522f7aeb7ab5927f2b0';
const snapshotText = readFileSync(resolve(archive, 'SNAPSHOT.json'));
assert(sha(snapshotText) === 'd51534ef3bf922019e334d8a246d7a620b9f0d62f2b53439f754ac2763b611f1');
const snapshot = JSON.parse(snapshotText);
const changed = ['digitalocean-stream.ts', 'stream-chunk-diagnostics.ts', 'synthetic-diagnostic-prefix.ts'];
const historical = ['digitalocean.ts', 'domain.ts', 'transport.ts', 'streaming-transport.ts'];
const pins = [];
for (const name of [...changed, ...historical]) {
  const path = 'packages/clinical-core/src/' + name;
  const origin = changed.includes(name) ? path : resolve(archive, 'files', path);
  const bytes = readFileSync(origin), sha256 = sha(bytes);
  if (historical.includes(name)) assert(snapshot.files.some(file => file.path === path && file.sha256 === sha256), 'historical dependency changed');
  const stagedPath = '.stream-chunk-diagnostic-stage/' + path;
  mkdirSync(dirname(stagedPath), { recursive: true });
  // Re-staging is allowed only while this prospective candidate is unfrozen.
  assert(!existsSync('docs/implementation/evidence/DO-AF63-PREFLIGHT.json'), 'candidate already frozen');
  writeFileSync(stagedPath, bytes);
  pins.push({ path, origin, stagedPath, sha256, historical: historical.includes(name) });
}
writeFileSync('.stream-chunk-diagnostic-stage/DEPENDENCIES.json', JSON.stringify({
  historicalSnapshotSha256: sha(snapshotText), pins, providerCalls: 0,
}, null, 2) + '\n');
console.log(JSON.stringify({ state: 'isolated-source-staged', files: pins.length, providerCalls: 0 }));
