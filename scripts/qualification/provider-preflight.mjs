// Read-only account/model preflight. No inference, speech generation, keys, or account mutations.
import { loadEnvFile } from 'node:process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const file = process.argv[process.argv.indexOf('--env') + 1];
if (!process.argv.includes('--env') || !file || !isAbsolute(file)) throw new Error('An absolute --env file path is required.');
if (statSync(file).mode & 0o077) throw new Error('Credential file must not be group/world accessible.');
loadEnvFile(file);
const keys = {
  digitalocean: process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY,
  deepgram: process.env.DEEPGRAM_API_KEY,
  elevenlabs: process.env.ELEVENLABS_API_KEY,
};
async function read(url, headers) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1_000_000) throw new Error('response-too-large');
  let body = {};
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Metadata failure remains explicit. */ }
  return { status: response.status, body };
}
async function digitalocean() {
  if (!keys.digitalocean) return { configured: false };
  const r = await read('https://inference.do-ai.run/v1/models', { Authorization: `Bearer ${keys.digitalocean}` });
  const models = Array.isArray(r.body.data) ? r.body.data : [];
  return { configured: true, status: r.status, modelCount: models.length, candidates: ['glm-5.3-flash', 'qwen3.8-max'].map(id => ({ id, available: models.some(model => model.id === id) })), accountCreditBalance: 'not-provided-by-model-list' };
}
async function deepgram() {
  if (!keys.deepgram) return { configured: false };
  const headers = { Authorization: `Token ${keys.deepgram}` };
  const r = await read('https://api.deepgram.com/v1/projects', headers);
  const projects = Array.isArray(r.body.projects) ? r.body.projects : [];
  const balances = [];
  for (const project of projects.slice(0, 5)) {
    if (!/^[a-f0-9-]{36}$/.test(project.project_id)) continue;
    const balance = await read(`https://api.deepgram.com/v1/projects/${project.project_id}/balances`, headers);
    balances.push({ projectId: project.project_id, status: balance.status, balances: (balance.body.balances ?? []).map(b => ({ amount: b.amount, units: b.units })) });
  }
  return { configured: true, status: r.status, projectCount: projects.length, balances };
}
async function elevenlabs() {
  if (!keys.elevenlabs) return { configured: false };
  const r = await read('https://api.elevenlabs.io/v1/user/subscription', { 'xi-api-key': keys.elevenlabs });
  const b = r.body;
  return { configured: true, status: r.status, subscriptionStatus: b.status, tier: b.tier, characterCount: b.character_count, characterLimit: b.character_limit, remainingCharacters: typeof b.character_count === 'number' && typeof b.character_limit === 'number' ? Math.max(0, b.character_limit - b.character_count) : null, creditExtensionLimit: b.max_credit_limit_extension, canExtend: b.can_extend_character_limit };
}
const results = await Promise.allSettled([digitalocean(), deepgram(), elevenlabs()]);
const report = { generatedAt: new Date().toISOString(), operation: 'read-only-preflight', inferenceCalls: 0, speechGenerationCalls: 0, providers: Object.fromEntries(['digitalocean', 'deepgram', 'elevenlabs'].map((name, i) => [name, results[i].status === 'fulfilled' ? results[i].value : { status: 'request-failed' }])) };
const directory = resolve('docs/implementation/evidence');
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'provider-preflight.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
