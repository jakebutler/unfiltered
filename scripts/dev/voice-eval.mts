/**
 * Release gate for critical-token accuracy in Deepgram live transcripts of synthetic speech. Word error rate hides
 * meaning flips ("not", "2.5" vs "25", a dropped drug name), so each case lists critical items and a case passes only
 * if every item matches exactly (whole words/phrases after normalization). Gates are per category and not compensable.
 * Synthetic text only; macOS `say` generates the audio. Nothing is written into docs/implementation/evidence.
 *
 *   npx tsx scripts/dev/voice-eval.mts --dry-run
 *   npx tsx scripts/dev/voice-eval.mts [--limit N] [--concurrency N] [--keyterms on|off] [--out path] [--voice name]
 *
 * Live mode reads DEEPGRAM_API_KEY from LOCAL_ENV_FILE (default: .env.local in the current directory) without printing it.
 * Each streamed second is billed by Deepgram; the run prints the audio total and an estimate at $0.0077/min.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import type WebSocketType from 'ws';
import { deepgramDirectListenUrl } from '../../packages/speech/src/contracts.ts';
import { directListenUrl } from '../../packages/speech/src/keyterms.ts';
import { parseDeepgramMessage, type RecognitionSegment } from '../../packages/speech/src/turn.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const execFileAsync = promisify(execFile);
const categories = ['number', 'negation', 'name'] as const;
type Category = (typeof categories)[number];
/** Non-compensable: each category must meet its own threshold, so strong names never cover a missed dose. */
const gates: Record<Category, number> = { number: 100, negation: 100, name: 95 };
const maxCases = 60;
const costPerMinuteUsd = 0.0077;
const sampleRate = 16000;
/** 100 ms of 16 kHz 16-bit mono PCM, sent in real time. */
const frameBytes = 3200;
const frameMs = 100;
const caseTimeoutMs = 20_000;

interface Case { id: string; category: Category; say: string; expect: string[][] }
interface Fixture { version: 'VE-0.1'; cases: Case[] }
interface CaseResult {
  id: string;
  category: Category;
  transcript: string;
  itemsTotal: number;
  itemsPassed: number;
  missing: string[][];
  passed: boolean;
  audioSeconds: number;
  error?: string;
}

/** Lowercase, drop punctuation except decimal points and hyphens inside words, split digit/letter runs, collapse spaces. */
export function normalize(text: string): string {
  return text.toLowerCase()
    .replace(/[’']/g, '\'')
    .replace(/(?<=[a-z])'(?=[a-z])/g, '')
    .replace(/(?<=\d)\.(?=\d)/g, '\u0001')
    .replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, '\u0002')
    .replace(/[^a-z0-9\u0001\u0002 ]+/g, ' ')
    .replace(/\u0001/g, '.')
    .replace(/\u0002/g, '-')
    .replace(/(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Unit spellings are the same measurement; numbers are never rewritten, so "two twelve" never passes for 212.
    .replace(/\b(?:milligrams?|mgs)\b/g, 'mg').replace(/\b(?:micrograms?|mcgs)\b/g, 'mcg')
    .replace(/\b(?:pounds?|lbs?)\b/g, 'lb').replace(/\b(?:kilograms?|kilos?|kgs)\b/g, 'kg');
}

/** Whole-word/phrase match: the padded normalized transcript must contain the padded normalized alternative. */
function containsPhrase(normalizedTranscript: string, alternative: string): boolean {
  return ` ${normalizedTranscript} `.includes(` ${normalize(alternative)} `);
}

function invalid(reason: string): never {
  throw new Error(`voice-eval fixture invalid: ${reason}`);
}

function loadFixture(): Fixture {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'voice-eval.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Fixture>;
  if (raw.version !== 'VE-0.1') invalid(`unexpected version ${String(raw.version)}`);
  if (!Array.isArray(raw.cases)) invalid('cases must be an array');
  const seen = new Set<string>();
  raw.cases.forEach((item, index) => {
    const where = `cases[${index}]`;
    if (typeof item.id !== 'string' || !/^[a-z0-9-]+$/.test(item.id)) invalid(`${where} id must be a slug`);
    if (seen.has(item.id)) invalid(`duplicate id ${item.id}`);
    seen.add(item.id);
    if (!categories.includes(item.category)) invalid(`${item.id} category must be number, negation, or name`);
    if (typeof item.say !== 'string' || item.say.trim().length === 0) invalid(`${item.id} say is empty`);
    if (!Array.isArray(item.expect) || item.expect.length === 0) invalid(`${item.id} expect must be a non-empty array`);
    item.expect.forEach((alternatives, itemIndex) => {
      if (!Array.isArray(alternatives) || alternatives.length === 0) invalid(`${item.id} expect[${itemIndex}] must be a non-empty array`);
      for (const alternative of alternatives) {
        if (typeof alternative !== 'string' || normalize(alternative).length === 0) invalid(`${item.id} expect[${itemIndex}] has an empty alternative`);
      }
    });
  });
  return raw as Fixture;
}

function intFlag(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  return value;
}

function reportPathFor(out: string | undefined): string {
  const path = resolve(out ?? `/tmp/voice-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const rel = relative(resolve(repoRoot, 'docs/implementation/evidence'), path);
  const insideEvidence = rel === '' || (!isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..');
  if (insideEvidence) throw new Error('--out must not point into docs/implementation/evidence');
  return path;
}

/** Same env-file pattern as local-mock-clinic.mts. The key is never logged. */
function readDeepgramKey(): string {
  const envFile = process.env.LOCAL_ENV_FILE ?? `${process.cwd()}/.env.local`;
  let text: string;
  try { text = readFileSync(envFile, 'utf8'); } catch { throw new Error(`env file not found: ${envFile} (set LOCAL_ENV_FILE)`); }
  const key = text.split('\n').map(line => /^\s*DEEPGRAM_API_KEY\s*=\s*"?([^"\s]+)"?/.exec(line)?.[1]).find(Boolean);
  if (!key) throw new Error(`DEEPGRAM_API_KEY missing from ${envFile}`);
  return key;
}

/** Locate the fmt and data chunks; refuse anything other than 16 kHz mono 16-bit PCM. */
function pcmFromWav(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('say produced a non-WAV file');
  let format: { channels: number; rate: number; bits: number } | undefined;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') format = { channels: wav.readUInt16LE(body + 2), rate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!format || format.channels !== 1 || format.rate !== sampleRate || format.bits !== 16) throw new Error('say output is not 16 kHz mono 16-bit PCM');
      return wav.subarray(body, Math.min(body + size, wav.length));
    }
    offset = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

function rawText(data: WebSocketType.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

interface StreamOutcome { transcript: string; audioSeconds: number; error?: string }

async function streamCase(wavPath: string, listenUrl: string, apiKey: string, WebSocketCtor: typeof WebSocketType): Promise<StreamOutcome> {
  const pcm = pcmFromWav(await readFile(wavPath));
  const audioSeconds = pcm.length / (sampleRate * 2);
  const finals = new Map<string, RecognitionSegment>();
  let error: string | undefined;
  const redact = (text: string) => text.split(apiKey).join('[redacted]');
  await new Promise<void>(finish => {
    const socket = new WebSocketCtor(listenUrl, { headers: { Authorization: `Token ${apiKey}` } });
    const timer = setTimeout(() => { error ??= 'timeout'; socket.terminate(); }, caseTimeoutMs);
    const done = () => { clearTimeout(timer); finish(); };
    socket.on('open', () => {
      void (async () => {
        const started = Date.now();
        for (let offset = 0, frame = 0; offset < pcm.length; offset += frameBytes, frame++) {
          const wait = started + frame * frameMs - Date.now();
          if (wait > 0) await sleep(wait);
          if (socket.readyState !== WebSocketCtor.OPEN) return;
          socket.send(pcm.subarray(offset, offset + frameBytes));
        }
        socket.send(JSON.stringify({ type: 'CloseStream' }));
      })();
    });
    socket.on('message', data => {
      try {
        const parsed = parseDeepgramMessage(rawText(data));
        if (parsed && parsed !== 'speech-started' && parsed.isFinal) finals.set(`${parsed.start}:${parsed.duration}`, parsed);
      } catch (err) {
        error ??= redact(err instanceof Error ? err.message : String(err));
        socket.terminate();
      }
    });
    socket.on('error', err => { error ??= redact(err.message); });
    socket.on('close', done);
  });
  const transcript = [...finals.values()].sort((a, b) => a.start - b.start).map(segment => segment.text.trim()).filter(Boolean).join(' ');
  return { transcript, audioSeconds, error };
}

async function synthesize(item: Case, dir: string, voice: string | undefined): Promise<string> {
  const out = join(dir, `${item.id}.wav`);
  const args = ['-o', out, '--data-format=LEI16@16000'];
  if (voice) args.push('-v', voice);
  args.push(`${item.say} [[slnc 1500]]`);
  await execFileAsync('say', args);
  return out;
}

function score(item: Case, transcript: string, error: string | undefined, audioSeconds: number): CaseResult {
  const normalizedTranscript = normalize(transcript);
  const missing = item.expect.filter(alternatives => !alternatives.some(alternative => containsPhrase(normalizedTranscript, alternative)));
  const itemsTotal = item.expect.length;
  return {
    id: item.id, category: item.category, transcript, itemsTotal, itemsPassed: itemsTotal - missing.length, missing,
    passed: missing.length === 0 && !error, audioSeconds, ...(error ? { error } : {}),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      concurrency: { type: 'string' },
      keyterms: { type: 'string' },
      out: { type: 'string' },
      voice: { type: 'string' },
    },
    strict: true,
  });
  const fixture = loadFixture();
  const limit = intFlag('limit', values.limit, 1, maxCases);
  const selected = fixture.cases.slice(0, limit ?? fixture.cases.length);
  if (selected.length > maxCases) throw new Error(`at most ${maxCases} cases per run (fixture has ${fixture.cases.length}; pass --limit)`);
  const concurrency = intFlag('concurrency', values.concurrency, 1, 4) ?? 3;
  if (values.keyterms !== undefined && values.keyterms !== 'on' && values.keyterms !== 'off') throw new Error('--keyterms must be on or off');
  const keyterms = values.keyterms ?? 'on';
  const reportPath = reportPathFor(values.out);

  if (values['dry-run']) {
    console.log(`voice-eval dry run: fixture ${fixture.version} valid, ${fixture.cases.length} cases total, ${selected.length} selected`);
    for (const category of categories) {
      const rows = selected.filter(item => item.category === category);
      console.log(`  ${category.padEnd(9)} ${rows.length} cases, ${rows.reduce((sum, item) => sum + item.expect.length, 0)} critical items`);
    }
    console.log('no network, no audio generated, no report written');
    return;
  }

  const apiKey = readDeepgramKey();
  const baseUrl = keyterms === 'on' ? directListenUrl([]) : deepgramDirectListenUrl;
  // Comparison only: the app always uses the pinned model in deepgramDirectListenUrl.
  const model = process.env.VOICE_EVAL_MODEL;
  if (model !== undefined && !['nova-3-medical', 'nova-3'].includes(model)) throw new Error('VOICE_EVAL_MODEL must be nova-3-medical or nova-3');
  const listenUrl = model ? baseUrl.replace('model=nova-3-medical', `model=${model}`) : baseUrl;
  const WebSocketCtor = createRequire(join(repoRoot, 'package.json'))('ws') as typeof WebSocketType;
  const dir = await mkdtemp('/tmp/voice-eval-audio-');
  const results: CaseResult[] = new Array<CaseResult>(selected.length);
  console.log(`voice-eval live: ${selected.length} cases, concurrency ${concurrency}, keyterms ${keyterms}, voice ${values.voice ?? 'default'}`);
  try {
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        const index = next++;
        const item = selected[index];
        let outcome: StreamOutcome;
        try {
          const wav = await synthesize(item, dir, values.voice);
          outcome = await streamCase(wav, listenUrl, apiKey, WebSocketCtor);
        } catch (err) {
          outcome = { transcript: '', audioSeconds: 0, error: err instanceof Error ? err.message : String(err) };
        }
        results[index] = score(item, outcome.transcript, outcome.error, outcome.audioSeconds);
        console.log(`[${index + 1}/${selected.length}] ${item.id} ${results[index].passed ? 'pass' : 'FAIL'}`);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const totalAudioSeconds = results.reduce((sum, result) => sum + result.audioSeconds, 0);
  const costUsd = (totalAudioSeconds / 60) * costPerMinuteUsd;
  const summaries = categories.map(category => {
    const rows = results.filter(result => result.category === category);
    const itemsTotal = rows.reduce((sum, row) => sum + row.itemsTotal, 0);
    const itemsPassed = rows.reduce((sum, row) => sum + row.itemsPassed, 0);
    const casesPassed = rows.filter(row => row.passed).length;
    const gate = gates[category];
    const gatePassed = rows.length > 0 && itemsPassed * 100 >= gate * itemsTotal;
    return { category, cases: rows.length, casesPassed, itemsTotal, itemsPassed, gatePercent: gate, gatePassed };
  });

  console.log('\nCategory  Items        Cases       Gate    Result');
  for (const row of summaries) {
    const pct = row.itemsTotal ? ((row.itemsPassed / row.itemsTotal) * 100).toFixed(1) : '0.0';
    console.log(`${row.category.padEnd(9)} ${`${row.itemsPassed}/${row.itemsTotal} (${pct}%)`.padEnd(12)} ${`${row.casesPassed}/${row.cases}`.padEnd(11)} ${`>=${row.gatePercent}%`.padEnd(7)} ${row.gatePassed ? 'PASS' : 'FAIL'}`);
  }
  const failures = results.filter(result => !result.passed);
  if (failures.length) {
    console.log('\nFailures:');
    for (const failure of failures) {
      console.log(`- ${failure.id} [${failure.category}]${failure.error ? ` error: ${failure.error}` : ''}`);
      console.log(`    transcript: ${JSON.stringify(failure.transcript)}`);
      for (const missing of failure.missing) console.log(`    missing: ${missing.join(' | ')}`);
    }
  }
  console.log(`\nAudio streamed: ${totalAudioSeconds.toFixed(1)} s, estimated Deepgram cost $${costUsd.toFixed(4)} at $${costPerMinuteUsd}/min`);

  const report = {
    version: fixture.version,
    generatedAt: new Date().toISOString(),
    listenUrl,
    keyterms: { enabled: keyterms === 'on', source: keyterms === 'on' ? 'directListenUrl([])' : null },
    voice: values.voice ?? null,
    gates: summaries,
    audio: { seconds: Number(totalAudioSeconds.toFixed(3)), estimatedCostUsd: Number(costUsd.toFixed(6)), costPerMinuteUsd },
    cases: results.map(result => ({
      id: result.id, category: result.category, transcript: result.transcript, passed: result.passed,
      missing: result.missing, ...(result.error ? { error: result.error } : {}),
    })),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${reportPath}`);
  const anyGateFailed = summaries.some(row => !row.gatePassed);
  process.exitCode = anyGateFailed ? 1 : 0;
  console.log(anyGateFailed ? 'RELEASE GATE: FAIL' : 'RELEASE GATE: PASS');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
