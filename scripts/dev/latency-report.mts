/**
 * Prints the turn latency summary for an exported timings file. Reads one local file; no network calls.
 *
 * Export from the clinic app console into a local file:
 * copy(JSON.stringify({ entries: window.__corvoTurnTimings, renderedTurns: window.__corvoRenderedTurnTimings }))
 *
 *   node_modules/.bin/vite-node scripts/dev/latency-report.mts -- /path/to/turn-timings.json
 *
 * Accepts a legacy bare array of request entries or an object with `entries` and/or `renderedTurns` arrays.
 */
import { readFileSync } from 'node:fs';
import { statOf, summarizeTurnTimings, type Stat } from '../../apps/clinic/src/turn-timing.ts';

const args = process.argv.slice(2).filter(arg => arg !== '--');
const file = args[0];
if (!file || args.length !== 1) {
  console.error('usage: latency-report.mts -- <turn-timings.json>');
  process.exit(2);
}

let parsed: unknown;
try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
catch { console.error('Could not read timing log as JSON.'); process.exit(2); }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const envelope = record(parsed) ? parsed : {};
const raw: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(envelope.entries) ? envelope.entries : [];
interface RequestSample { route: string; clientMs: number; serverTiming: Record<string, number> }
const entries: RequestSample[] = [];
for (const item of raw) {
  if (!record(item) || !duration(item.clientMs) || typeof item.route !== 'string' || !record(item.serverTiming)) continue;
  const serverTiming = Object.fromEntries(Object.entries(item.serverTiming).filter(([name, value]) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) && duration(value))) as Record<string, number>;
  entries.push({ route: item.route, clientMs: item.clientMs, serverTiming });
}
const rawRendered: unknown[] = Array.isArray(envelope.renderedTurns) ? envelope.renderedTurns : [];
const rendered = rawRendered.filter((item): item is { mode: 'guided' | 'adaptive'; submitToRenderMs: number } =>
  record(item) && (item.mode === 'guided' || item.mode === 'adaptive') && duration(item.submitToRenderMs));

const fmt = (value: number | null) => value === null ? '-' : value.toFixed(1);
const row = (label: string, stat: Stat, indent = '') => `${(indent + label).padEnd(34)}${String(stat.count).padStart(6)}${fmt(stat.p50).padStart(10)}${fmt(stat.p95).padStart(10)}${fmt(stat.max).padStart(10)}`;
const header = `${''.padEnd(34)}${'count'.padStart(6)}${'p50'.padStart(10)}${'p95'.padStart(10)}${'max'.padStart(10)}`;

const summary = summarizeTurnTimings(entries);
console.log(`Request latency (ms): ${summary.count} entries from ${file}, skipped ${raw.length - entries.length} malformed`);
console.log(header);
console.log(row('request to parsed response', summary.client));
console.log(row('server total', summary.server));

const routes = [...new Set(entries.map(entry => entry.route))].sort();
if (routes.length) {
  console.log('\nBy route');
  console.log(header);
  for (const route of routes) {
    const stats = summarizeTurnTimings(entries.filter(entry => entry.route === route));
    console.log(route);
    console.log(row('request to parsed response', stats.client, '  '));
    console.log(row('server total', stats.server, '  '));
  }
}

const phases = [...new Set(entries.flatMap(entry => Object.keys(entry.serverTiming)))].filter(name => name !== 'total').sort();
if (phases.length) {
  console.log('\nServer phases (nested phases are included in their parent)');
  console.log(header);
  for (const phase of phases) {
    const values = entries.map(entry => entry.serverTiming[phase]).filter((ms): ms is number => typeof ms === 'number');
    console.log(row(phase, statOf(values)));
  }
}
if (entries.length === 0) console.log('no request entries');

console.log(`\nSubmit to rendered turn (ms): ${rendered.length} entries, skipped ${rawRendered.length - rendered.length} malformed`);
console.log(header);
console.log(row('submit to render', statOf(rendered.map(entry => entry.submitToRenderMs))));
for (const mode of ['guided', 'adaptive'] as const) {
  console.log(row(mode, statOf(rendered.filter(entry => entry.mode === mode).map(entry => entry.submitToRenderMs)), '  '));
}
if (rendered.length === 0) console.log('no rendered turn entries');
