import { describe, expect, it } from 'vitest';
import { compilePack } from '../src/pack-compile.js';
import { questionnairePackSchema } from '../src/pack.js';
import { adultIntakePack } from '../src/packs/adult-intake.js';
import { proposedBetweenVisitPack } from '../src/packs/between-visit-proposed.js';
import { createClinicContent } from '../src/register.js';
import { scenarioIds } from '../src/workflows.js';

const expectedPrompts = [
  { id: 'S08', text: 'How have things been going since your last visit?', origin: 'between-visit', wordingStatus: 'proposed-detail' },
  { id: 'W08.followup.1', text: 'Has anything changed since your last visit, such as medicines, eating, sleep or how you feel? If nothing has changed, you can say so.', origin: 'between-visit', wordingStatus: 'proposed-detail' },
  { id: 'W08.followup.2', text: "Is there anything you'd like your care team to help with before your next visit?", origin: 'between-visit', wordingStatus: 'proposed-detail' },
];

describe('standalone proposed between-visit pack', () => {
  it('validates with the exact proposed W08 wording and dependencies', () => {
    const parsed = questionnairePackSchema.parse(proposedBetweenVisitPack);
    expect(parsed).toStrictEqual(proposedBetweenVisitPack);
    expect(parsed.prompts.slice(adultIntakePack.prompts.length)).toStrictEqual(expectedPrompts);
    const workflow = parsed.workflows.at(-1)!;
    expect(workflow).toMatchObject({
      id: 'between-visit', workflowId: 'W08', openingPromptId: 'S08',
      reusableTopicIds: ['Q08', 'Q11', 'Q15', 'Q16'], owners: ['medical', 'nutrition'], detailStatus: 'proposed-detail',
      patientSummary: 'Send a short update on how things are going between visits.',
      contextRequirement: 'Most recent confirmed submission if available (T3.9); otherwise none required.',
      completion: 'Each relevant owner reviews the update and records a next step. PHQ-4 is scored only when all four items are answered by buttons.',
    });
    expect(workflow.additionalTopics[0].corvo.wordingStatus).toBe('proposed-detail');
    expect(workflow.additionalTopics[0].item.map(item => ({ id: item.linkId, text: item.text, prompts: item.corvo.promptIds, acceptsNegative: item.corvo.acceptsNegative }))).toStrictEqual([
      { id: 'overall', text: 'How things have been overall since the last visit', prompts: ['S08'], acceptsNegative: false },
      { id: 'changes', text: 'Changes since the last visit, or none', prompts: ['W08.followup.1'], acceptsNegative: true },
      { id: 'help', text: 'Anything the care team should help with before the next visit', prompts: ['W08.followup.2'], acceptsNegative: true },
    ]);
    expect(parsed.provenance).toMatchObject({ wordingStatus: 'proposed-detail', clinicalProtocolApproval: false, runtimeRegistration: 'deferred-until-owner-requalification' });
  });

  it.each(['phq4', 'unscored', 'pending'] as const)('compiles the proposed W08 workflow while retaining all adult fields for %s', mentalHealth => {
    const compiled = compilePack(proposedBetweenVisitPack, { mentalHealth });
    const adult = compilePack(questionnairePackSchema.parse(adultIntakePack), { mentalHealth });
    const added = Object.values(compiled.scenarios).find(workflow => workflow.workflowId === 'W08')!;
    expect(added.id).toBe('between-visit');
    expect(added.additionalTopics[0].slots.map(slot => [slot.id, slot.promptIds, slot.acceptsNegative])).toStrictEqual([
      ['overall', ['S08'], false], ['changes', ['W08.followup.1'], true], ['help', ['W08.followup.2'], true],
    ]);
    for (const [id, workflow] of Object.entries(adult.scenarios)) expect(compiled.scenarios[id as keyof typeof adult.scenarios]).toStrictEqual(workflow);
    expect(compiled.topics).toStrictEqual(adult.topics);
    expect(compiled.branches).toStrictEqual(adult.branches);
    expect(compiled.mentalHealthOption).toStrictEqual(adult.mentalHealthOption);
    expect(compiled.stopSemantics).toStrictEqual(adult.stopSemantics);
    expect(compiled.promptsById.S08).toStrictEqual(expectedPrompts[0]);
  });

  it('retains the locked PHQ block and rejects rewording or free-text permission', () => {
    expect(proposedBetweenVisitPack.lockedInstruments).toStrictEqual(adultIntakePack.lockedInstruments);
    expect(proposedBetweenVisitPack.mentalHealth).toStrictEqual(adultIntakePack.mentalHealth);
    const lockedPromptIds = new Set(['MH.stem', 'COPY-10', 'MH01', 'MH02', 'MH03', 'MH04']);
    expect(proposedBetweenVisitPack.prompts.filter(prompt => lockedPromptIds.has(prompt.id))).toStrictEqual(adultIntakePack.prompts.filter(prompt => lockedPromptIds.has(prompt.id)));
    const reworded = structuredClone(proposedBetweenVisitPack);
    reworded.prompts.find(prompt => prompt.id === 'MH01')!.text = 'A changed instrument item';
    expect(questionnairePackSchema.safeParse(reworded).success).toBe(false);
    const freeText = structuredClone(proposedBetweenVisitPack);
    expect(questionnairePackSchema.safeParse({ ...freeText, lockedInstruments: freeText.lockedInstruments.map(lock => ({ ...lock, freeTextAnswerable: true })) }).success).toBe(false);
  });

  it('does not register W08, mutate the adult mirror, or alias adult data', () => {
    expect([...scenarioIds]).not.toContain('between-visit');
    const adult = createClinicContent();
    expect(Object.values(adult.scenarios).some(workflow => workflow.workflowId === 'W08')).toBe(false);
    expect(adult.promptsById.S08).toBeUndefined();
    expect(adultIntakePack.prompts.some(prompt => prompt.id === 'S08')).toBe(false);
    expect(adultIntakePack.workflows.some(workflow => workflow.workflowId === 'W08')).toBe(false);
    expect(proposedBetweenVisitPack.topics).toStrictEqual(adultIntakePack.topics);
    expect(proposedBetweenVisitPack.topics).not.toBe(adultIntakePack.topics);
    expect(proposedBetweenVisitPack.topics[0]).not.toBe(adultIntakePack.topics[0]);
    expect(proposedBetweenVisitPack.mentalHealth).not.toBe(adultIntakePack.mentalHealth);
    const adultBefore = JSON.stringify(adultIntakePack);
    compilePack(proposedBetweenVisitPack, { mentalHealth: 'phq4' });
    expect(JSON.stringify(adultIntakePack)).toBe(adultBefore);
  });
});
