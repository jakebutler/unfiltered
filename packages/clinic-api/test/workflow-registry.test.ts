import { describe, expect, it } from 'vitest';
import { scenarioIds } from '../../clinic-content/src/workflows.js';
import { conversation } from '../src/conversation.js';
import type { ClinicApiConfig, Draft } from '../src/types.js';

const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://localhost:5173', cookieSecret: 'synthetic-workflow-registry-secret', mentalHealth: 'phq4', patients: Object.fromEntries(scenarioIds.map(id => [id, patient])) } as ClinicApiConfig;
const content = conversation(config);
function choices(scenario: Draft['scenario'], topic: string, slot: string) {
  const at = new Date().toISOString();
  const draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario, revision: 0, savedAt: at, createdAt: at, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
  return content.view(content.select(draft, topic, slot), true).currentPrompt!.choices;
}

describe('patient administrative choices from shared labels', () => {
  it('preserves scheduling intent labels as the original raw choices', () => {
    expect(choices('scheduling', 'W06', 'intent')).toEqual([
      { value: 'request', label: 'request' },
      { value: 'change', label: 'change' },
      { value: 'cancel', label: 'cancel' },
    ]);
  });

  it('preserves the patient billing labels', () => {
    expect(choices('billing', 'W05', 'issueType')).toEqual([
      { value: 'bill-question', label: 'A bill question' },
      { value: 'coverage-question', label: 'A coverage question' },
      { value: 'payment-question', label: 'A payment question' },
      { value: 'other-request', label: 'Another billing request' },
    ]);
  });
});
