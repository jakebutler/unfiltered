import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contractMatches, isScenarioId, scenarioIds, scenarioTitles } from '../src/workflows.js';
import { scenarios } from '../src/scenarios.js';
import { administrativeChoiceLabels } from '../../clinic-contract/src/index.js';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const literalIds = (text: string, expression: RegExp) => {
  const match = text.match(expression);
  expect(match, 'retained scenario list must remain recognizable').not.toBeNull();
  return JSON.parse(match![1].replaceAll("'", '"'));
};

describe('ordered workflow registry', () => {
  it('matches the dependency-free browser contract in both type directions', () => {
    // The assertion lives in src/workflows.ts because foundation tsc excludes tests.
    expect(contractMatches).toBe(true);
  });

  it('matches authored scenario identity, workflow ordering and title keys', () => {
    expect(Object.keys(scenarios)).toEqual(scenarioIds);
    expect(scenarioIds.map(id => scenarios[id].id)).toEqual(scenarioIds);
    expect(scenarioIds.map(id => scenarios[id].workflowId)).toEqual(['W01', 'W02', 'W03', 'W04', 'W05', 'W06', 'W07']);
    expect(Object.keys(scenarioTitles)).toEqual(scenarioIds);
  });

  it('accepts only registered scenario strings', () => {
    for (const id of scenarioIds) expect(isScenarioId(id)).toBe(true);
    for (const value of [undefined, null, 1, {}, [], 'unknown', 'Billing', '']) expect(isScenarioId(value)).toBe(false);
  });

  it('matches the directly executed cloud manifest list without changing it', () => {
    // Plain .mjs scripts run directly in Node; avoid adding TypeScript imports.
    expect(literalIds(source('../../../infra/cloud/clinic-manifest.mjs'), /SCENARIOS = Object.freeze\((\[.*?\])\)/)).toEqual(scenarioIds);
  });

  it('matches the directly executed seed list without importing its side effects', () => {
    expect(literalIds(source('../../../infra/local/seed-clinic.mjs'), /const scenarios\s*=\s*(\[.*?\])/)).toEqual(scenarioIds);
  });


  it('keeps the shared staff administrative labels verbatim', () => {
    expect(administrativeChoiceLabels).toEqual({
      issueType: { 'bill-question': 'A bill question', 'coverage-question': 'A coverage question', 'payment-question': 'A payment question', 'other-request': 'Another billing request' },
      requestedResolution: { explanation: 'An explanation', 'review-possible-error': 'Review a possible error', 'payment-options': 'Discuss payment options', 'contact-me': 'Contact me' },
      intent: { request: 'Request a visit', change: 'Change a visit', cancel: 'Cancel a visit' },
      visitCategory: { 'first-visit': 'First visit', 'follow-up': 'Follow-up visit', 'not-sure': 'Not sure' },
      timezone: { 'America/New_York': 'Eastern time', 'America/Chicago': 'Central time', 'America/Denver': 'Mountain time', 'America/Los_Angeles': 'Pacific time', 'America/Anchorage': 'Alaska time', 'Pacific/Honolulu': 'Hawaii time' },
    });
  });
});
