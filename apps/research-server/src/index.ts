import { readFile } from 'node:fs/promises';
import { createSyntheticResearchSpeech } from './synthetic-speech-fixture';
import { resolve } from 'node:path';
import { loadConfig } from './config';
import { startResearchServer } from './server';
import { loadAnalysisRuntime } from './analysis-config';

async function main() {
  const i = process.argv.indexOf('--config');
  if (i < 0 || !process.argv[i + 1]) throw new Error('An explicit private configuration path is required');
  const config = await loadConfig(resolve(process.argv[i + 1]));
  const analysisIndex = process.argv.indexOf('--analysis-config');
  if (analysisIndex >= 0 && !process.argv[analysisIndex + 1]) throw new Error('Explicit private analysis configuration path required');
  const analysis = await loadAnalysisRuntime(analysisIndex >= 0 ? resolve(process.argv[analysisIndex + 1]) : undefined);
  const syntheticIndex = process.argv.indexOf('--synthetic-speech-allocation');
  if (syntheticIndex >= 0 && !process.argv[syntheticIndex + 1]) throw new Error('Explicit local synthetic speech allocation required');
  const speech = syntheticIndex >= 0 ? createSyntheticResearchSpeech(config, process.argv[syntheticIndex + 1], await readFile(new URL('../fixtures/synthetic-tone.mp3', import.meta.url))) : undefined;
  const runtime = await startResearchServer(config, analysis, speech);
  if (speech) console.log('Synthetic voice fixture enabled: fixed transcript and tone; no speech provider calls.');
  console.log('Research capture gateway ready on http://127.0.0.1:8789; private storage and serial cleanup enabled.');
  const stop = () => { void runtime.close().then(() => { process.exitCode = 0; }, () => { console.error('Research gateway shutdown did not finish cleanly.'); process.exitCode = 1; }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
void main().catch(() => { console.error('Research gateway startup failed; inspect local configuration and listener availability.'); process.exitCode = 1; });
