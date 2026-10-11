import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';
import { hostedResearchConfig } from '../config';

const entry = readFileSync(new URL('../startup-diagnostics.cjs', import.meta.url), 'utf8');
const sensitive = 'private-credential-/private/runtime/file.json';
function run(load: () => unknown) {
  const logs: string[] = [], levels: string[] = [], module = { exports: {} as unknown, require: (path: string) => {
    expect(path).toBe('./research-bootstrap.cjs');
    expect(logs.map(line => JSON.parse(line).phase)).toEqual(['entry', 'import']);
    return load();
  } };
  let caught: any;
  try {
    runInNewContext(entry, { module, console: { info: (line: string) => { levels.push('info'); logs.push(line); }, error: (line: string) => { levels.push('error'); logs.push(line); } } }, { displayErrors: false });
  } catch (error) { caught = error; }
  expect(logs.join('\n')).not.toContain(sensitive);
  return { logs: logs.map(line => JSON.parse(line)), levels, module, caught };
}

test('thin entry logs before import, calls startup synchronously and exports the same server', () => {
  const server = { listen: vi.fn() };
  const result = run(() => ({ startResearchApplication(mark: (phase: string) => void) {
    for (const phase of ['manifest', 'config', 'binary', 'adapters', 'assets', 'application', 'listen']) mark(phase);
    server.listen();
    return server;
  } }));
  expect(server.listen).toHaveBeenCalledOnce();
  expect(result.module.exports).toBe(server);
  expect(result.caught).toBeUndefined();
  expect(result.levels.every(level => level === 'info')).toBe(true);
  expect(result.logs.at(-1)).toEqual({ component: 'research-startup', version: 1, event: 'success', phase: 'listen' });
});

test('configuration failure is categorized without exposing thrown content or a stack', () => {
  const result = run(() => ({ startResearchApplication(mark: (phase: string) => void) {
    mark('manifest'); mark('config');
    try { hostedResearchConfig({ RESEARCH_RUNTIME_JSON: sensitive }, {}, sensitive); }
    catch { throw new Error(sensitive); }
  } }));
  expect(result.logs.at(-1)).toMatchObject({ event: 'failure', phase: 'config', category: 'configuration-failure' });
  expect(result.caught.message).toBe('Research startup failed');
  expect(result.caught.stack).toBe('');
  expect(result.levels).toEqual(['info', 'info', 'info', 'info', 'error']);
});

test('pre-import failure never reads sensitive exception fields and preserves the entry marker', () => {
  const inspect = vi.fn(() => { throw new Error(sensitive); });
  const result = run(() => { throw Object.defineProperties({}, { message: { get: inspect }, stack: { get: inspect }, code: { get: inspect } }); });
  expect(inspect).not.toHaveBeenCalled();
  expect(result.logs).toEqual([
    { component: 'research-startup', version: 1, event: 'phase', phase: 'entry' },
    { component: 'research-startup', version: 1, event: 'phase', phase: 'import' },
    { component: 'research-startup', version: 1, event: 'failure', phase: 'import', category: 'dependency-load-failure' },
  ]);
  expect(result.caught.stack).toBe('');
  expect(result.levels).toEqual(['info', 'info', 'error']);
});
