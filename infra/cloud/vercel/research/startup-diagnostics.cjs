'use strict';
// Keep this entry dependency-free: the first marker precedes bootstrap imports.
// Never inspect an exception; messages, getters, paths and stacks may be secret.
const phases = new Set(['manifest', 'config', 'binary', 'adapters', 'assets', 'application', 'listen', 'listening']);
let phase = 'entry';
function write(event, category) {
  const line = JSON.stringify({ component: 'research-startup', version: 1, event, phase, ...(category ? { category } : {}) });
  if (event === 'failure') console.error(line);
  else console.info(line);
}
function mark(next) {
  if (!phases.has(next)) throw new Error('Invalid startup marker');
  phase = next;
  write('phase');
}
write('phase');
phase = 'import';
write('phase');
try {
  // module.require preserves order through the platform CJS transformer.
  const bootstrap = module.require('./research-bootstrap.cjs');
  module.exports = bootstrap.startResearchApplication(mark);
  // listen() has been called synchronously; its readiness event is separate.
  write('success');
} catch {
  const categories = { entry: 'entry-failure', import: 'dependency-load-failure', manifest: 'package-input-failure', config: 'configuration-failure', binary: 'binary-validation-failure', adapters: 'adapter-construction-failure', assets: 'asset-load-failure', application: 'application-construction-failure', listen: 'listener-start-failure', listening: 'listener-start-failure' };
  write('failure', categories[phase] || 'startup-failure');
  // Preserve invocation failure without leaking the original thrown payload.
  const failure = new Error('Research startup failed');
  failure.stack = '';
  throw failure;
}
