/**
 * Prints the turn latency summary for an exported timings file. Reads one local file; no network calls.
 *
 * Export from the clinic app console: copy JSON.stringify(window.__corvoTurnTimings) into a file.
 *
 *   node_modules/.bin/vite-node scripts/dev/latency-report.mts -- /path/to/turn-timings.json
 *
 * Accepts a bare array of entries or an object with an `entries` array.
 */
import { readFileSync } from 'node:fs';
import { statOf, summarizeTurnTimings, type Stat, type TurnTiming } from '../../apps/clinic/src/turn-timing.ts';

const args = process.argv.slice(2).filter(arg => arg !== '--');
const file = args[0];
if (!file || args.length !== 1) {
  console.error('usage: latency-report.mts -- <turn-timings.json>');
  process.exit(2);
}

const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
const raw: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { entries?: unknown })?.entries) ? (parsed as { entries: unknown[] }).entries : [];
const entries = raw.filter((item): item is TurnTiming => {
  const e = item as Partial<TurnTiming> | null;
  return !!e && typeof e.clientMs === 'number' && Number.isFinite(e.clientMs) && typeof e.route === 'string' && typeof e.serverTiming === 'object' && e.serverTiming !== null;
});

const fmt = (value: number | null) => value === null ? '-' : value.toFixed(1);
const row = (label: string, stat: Stat, indent = '') => `${(indent + label).padEnd(34)}${String(stat.count).padStart(6)}${fmt(stat.p50).padStart(10)}${fmt(stat.p95).padStart(10)}${fmt(stat.max).padStart(10)}`;
const header = `${''.padEnd(34)}${'count'.padStart(6)}${'p50'.padStart(10)}${'p95'.padStart(10)}${'max'.padStart(10)}`;

const summary = summarizeTurnTimings(entries);
console.log(`Turn latency (ms): ${summary.count} entries from ${file}, skipped ${raw.length - entries.length} malformed`);
console.log(header);
console.log(row('client', summary.client));
console.log(row('server total', summary.server));

const routes = [...new Set(entries.map(entry => entry.route))].sort();
if (routes.length) {
  console.log('\nBy route');
  console.log(header);
  for (const route of routes) {
    const stats = summarizeTurnTimings(entries.filter(entry => entry.route === route));
    console.log(route);
    console.log(row('client', stats.client, '  '));
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
if (entries.length === 0) console.log('no turn entries');
