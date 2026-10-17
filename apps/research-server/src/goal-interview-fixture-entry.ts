/** Explicit local fixture executable, separate from the production/server entry. */
import { resolve } from 'node:path';
import { loadConfig, privateJson } from './config';
import { startResearchServer } from './server';
import { syntheticGoalInterview } from './synthetic-interview-fixture';
import { z } from 'zod';

const fixtureReceipt = z.object({
  mode: z.literal('local-deterministic-goal-interview'), state: z.literal('ready'), liveSessionAuthorized: z.literal(false),
  sessions: z.array(z.object({ kind: z.literal('deterministic'), sessionId: z.string().min(1).max(160) })).length(1),
  policy: z.object({ model: z.literal('qwen3.8-max'), allocatedCalls: z.literal(2), maxSessionCalls: z.literal(1), maxInputBytes: z.literal(64_000), maxOutputTokens: z.literal(512), expiresAt: z.number().int().positive() }),
});

async function main() {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const path = arg('--config'), receipt = arg('--fixture');
  if (!process.argv.includes('--allow-local-deterministic-goal-interview') || !path || !receipt) throw new Error('Explicit local synthetic interview configuration required');
  const config = await loadConfig(resolve(path)), checkpoint = fixtureReceipt.parse(await privateJson(resolve(receipt)));
  if (checkpoint.policy.expiresAt <= Date.now()) throw new Error('Synthetic fixture checkpoint unavailable');
  const runtime = await startResearchServer(config, undefined, undefined, { enabled: true, provider: syntheticGoalInterview(checkpoint.sessions[0].sessionId) });
  console.log('Local deterministic goal interview ready on 127.0.0.1:8789. Synthetic provider only; no live model or speech calls.');
  const stop = () => { void runtime.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
void main().catch(() => { console.error('Deterministic goal fixture startup failed; inspect its private configuration.'); process.exitCode = 1; });
