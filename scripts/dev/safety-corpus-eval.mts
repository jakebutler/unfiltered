/**
 * Bounded live run of the safety gate over the synthetic safety corpus. One DigitalOcean call per
 * corpus item (about 300), concurrency 3, no retries. Records only levels/categories (never the key)
 * to packages/clinic-api/test/fixtures/safety-corpus-recorded.json, which the offline corpus gate replays.
 *
 * Loads DIGITALOCEAN_MODEL_ACCESS_KEY from SAFETY_EVAL_ENV_FILE (default: the main checkout's .env.local).
 * Usage: npx tsx scripts/dev/safety-corpus-eval.mts [--only id1,id2]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DO_ENDPOINT } from '../../packages/clinical-core/src/digitalocean.js';
import { buildSafetyReviewMessages, createSafetyReviewer, safetyReviewProtocol } from '../../packages/clinic-api/src/safety-review.js';
import { defaultInterpreterModel } from '../../apps/clinic-server/src/providers.js';

const root = new URL('../../', import.meta.url).pathname;
const envFile = process.env.SAFETY_EVAL_ENV_FILE ?? '/Volumes/rexy/GitHub/unfiltered/.env.local';
const apiKey = readFileSync(envFile, 'utf8').split('\n').map(line => /^\s*DIGITALOCEAN_MODEL_ACCESS_KEY\s*=\s*"?([^"\s]+)"?/.exec(line)?.[1]).find(Boolean);
if (!apiKey) throw new Error('DIGITALOCEAN_MODEL_ACCESS_KEY missing');

const corpus = JSON.parse(readFileSync(`${root}packages/clinic-api/test/fixtures/safety-corpus.json`, 'utf8')) as { version: string; items: { id: string; text: string }[] };
const outPath = `${root}packages/clinic-api/test/fixtures/safety-corpus-recorded.json`;
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : undefined;
const promptDigest = createHash('sha256').update(String(buildSafetyReviewMessages({ sessionId: '', signalId: '', text: '', screened: [] })[0].content)).digest('hex');
let previous: { promptDigest?: string; results?: Record<string, unknown> } = {};
try { previous = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* first run */ }
const results: Record<string, unknown> = only && previous.promptDigest === promptDigest ? { ...previous.results } : {};

const reviewer = createSafetyReviewer({ endpoint: DO_ENDPOINT, model: defaultInterpreterModel, apiKey, maxOutputTokens: 800, timeoutMs: 15000 });
const queue = corpus.items.filter(item => !only || only.has(item.id));
let calls = 0, failures = 0;
async function worker() {
  for (let item = queue.shift(); item; item = queue.shift()) {
    calls++;
    try { const { concern, level, categories } = await reviewer.review({ sessionId: 'eval', signalId: item.id, text: item.text, screened: [] }); results[item.id] = { concern, level, categories }; }
    catch (error) { failures++; results[item.id] = { error: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }; }
  }
}
await Promise.all([worker(), worker(), worker()]);
const sorted = Object.fromEntries(Object.entries(results).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(outPath, `${JSON.stringify({ corpus: corpus.version, protocol: safetyReviewProtocol, model: defaultInterpreterModel, promptDigest, recordedAt: new Date().toISOString(), results: sorted }, null, 1)}\n`);
console.log(`calls=${calls} failures=${failures} recorded=${Object.keys(sorted).length}`);
