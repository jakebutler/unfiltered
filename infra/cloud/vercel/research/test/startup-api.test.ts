import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';
const entry = readFileSync(new URL('../startup-api.js', import.meta.url), 'utf8');
const sensitive = 'private-credential-/private/runtime/file.json';
function run(load: () => unknown) {
  const logs: string[] = [], levels: string[] = [];
  const module = { exports: {} as unknown, require: (path: string) => {
    expect(path).toBe('../research-bootstrap.cjs');
    expect(logs.map(line => JSON.parse(line).phase)).toEqual(['entry', 'import']);
    return load();
  } };
  let caught: any;
  try { runInNewContext(entry, { module, console: {
    info(line: string) { levels.push('info'); logs.push(line); },
    error(line: string) { levels.push('error'); logs.push(line); },
  } }, { displayErrors: false }); } catch (error) { caught = error; }
  expect(logs.join('\n')).not.toContain(sensitive);
  return { logs: logs.map(line => JSON.parse(line)), levels, module, caught };
}
test('standard API exports the same guarded server without binding a listener', () => {
  const request = vi.fn(), upgrade = vi.fn(), server = { listen: vi.fn(), request, upgrade };
  const result = run(() => ({ createResearchApplication(mark: (phase: string) => void) {
    for (const phase of ['manifest', 'config', 'binary', 'adapters', 'assets', 'application']) mark(phase);
    return server;
  } }));
  expect(server.listen).not.toHaveBeenCalled();
  expect(result.module.exports).toBe(server);
  expect((result.module.exports as typeof server).request).toBe(request);
  expect((result.module.exports as typeof server).upgrade).toBe(upgrade);
  expect(result.caught).toBeUndefined();
  expect(result.levels.every(level => level === 'info')).toBe(true);
  expect(result.logs.at(-1)).toEqual({ component: 'research-startup', version: 2, mode: 'api-server', event: 'success', phase: 'export' });
});
test('API configuration failure logs a fixed category and stackless error only', () => {
  const result = run(() => ({ createResearchApplication(mark: (phase: string) => void) {
    mark('manifest'); mark('config'); throw new Error(sensitive);
  } }));
  expect(result.logs.at(-1)).toMatchObject({ event: 'failure', phase: 'config', category: 'configuration-failure' });
  expect(result.caught.message).toBe('Research startup failed');
  expect(result.caught.stack).toBe('');
  expect(result.levels).toEqual(['info', 'info', 'info', 'info', 'error']);
});
test('API pre-import failure never reads sensitive thrown fields', () => {
  const inspect = vi.fn(() => { throw new Error(sensitive); });
  const result = run(() => { throw Object.defineProperties({}, { message: { get: inspect }, stack: { get: inspect }, code: { get: inspect } }); });
  expect(inspect).not.toHaveBeenCalled();
  expect(result.logs.map(log => log.phase)).toEqual(['entry', 'import', 'import']);
  expect(result.logs.at(-1)).toMatchObject({ event: 'failure', category: 'dependency-load-failure' });
  expect(result.caught.stack).toBe('');
  expect(result.levels).toEqual(['info', 'info', 'error']);
});
