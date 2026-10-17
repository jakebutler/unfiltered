'use strict';
// Standard /api HTTPServer export: the platform owns listen and upgrades.
// Fixed diagnostics never inspect thrown messages, getters, paths, or stacks.
const phases = new Set(['manifest', 'config', 'binary', 'adapters', 'assets', 'application']);
let phase = 'entry';
function write(event, category) {
  const line = JSON.stringify({ component: 'research-startup', version: 2, mode: 'api-server', event, phase, ...(category ? { category } : {}) });
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
  const bootstrap = module.require('../research-bootstrap.cjs');
  module.exports = bootstrap.createResearchApplication(mark);
  phase = 'export';
  write('phase');
  write('success');
} catch {
  const categories = { entry: 'entry-failure', import: 'dependency-load-failure', manifest: 'package-input-failure', config: 'configuration-failure', binary: 'binary-validation-failure', adapters: 'adapter-construction-failure', assets: 'asset-load-failure', application: 'application-construction-failure', export: 'server-export-failure' };
  write('failure', categories[phase] || 'startup-failure');
  const failure = new Error('Research startup failed');
  failure.stack = '';
  throw failure;
}
