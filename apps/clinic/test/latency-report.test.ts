import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runner = fileURLToPath(new URL('../../../node_modules/vite-node/vite-node.mjs', import.meta.url));
const script = fileURLToPath(new URL('../../../scripts/dev/latency-report.mts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/turn-timings.json', import.meta.url));
function run(...args: string[]) {
  return spawnSync(process.execPath, [runner, script, '--', ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });
}

describe('latency report CLI', () => {
  it('reports request phases and submit-to-render totals from the exported fixture schema', () => {
    const result = run(fixture);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Request latency (ms): 5 entries');
    expect(result.stdout).toContain('skipped 4 malformed');
    expect(result.stdout).toMatch(/^request to parsed response\s+5\s+200\.0\s+400\.0\s+400\.0$/m);
    expect(result.stdout).toMatch(/^server total\s+4\s+80\.0\s+380\.0\s+380\.0$/m);
    expect(result.stdout).toContain('POST /api/clinic/adaptive-turns/:id/interpret');
    expect(result.stdout).toMatch(/^safety\s+3\s+40\.0\s+60\.0\s+60\.0$/m);
    expect(result.stdout).toMatch(/^session\s+2\s+2\.0\s+4\.0\s+4\.0$/m);
    expect(result.stdout).toContain('Submit to rendered turn (ms): 3 entries, skipped 3 malformed');
    expect(result.stdout).toMatch(/^submit to render\s+3\s+240\.0\s+500\.0\s+500\.0$/m);
    expect(result.stdout).toMatch(/^  guided\s+2\s+120\.0\s+240\.0\s+240\.0$/m);
    expect(result.stdout).toMatch(/^  adaptive\s+1\s+500\.0\s+500\.0\s+500\.0$/m);
    expect(result.stdout).not.toMatch(/NaN|Infinity|bad name|unusable/);
  });

  it('fails with a useful error for a missing argument or unreadable file', () => {
    const missing = run();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('usage: latency-report.mts');
    const unreadable = run('/nonexistent-synthetic-timing-log.json');
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toContain('Could not read timing log as JSON.');
  });
});
