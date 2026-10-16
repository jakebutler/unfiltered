import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compilePack, compilePackItem } from '../src/pack-compile.js';
import { adultIntakePack } from '../src/packs/adult-intake.js';
import { questionnairePackSchema } from '../src/pack.js';
import { createClinicContent } from '../src/register.js';
import { buildAdultIntakePack, createAuthoredClinicContent, exportAdultIntakePack, serializeAdultIntakePack, slotToPackItem } from '../../../scripts/dev/export-intake-pack.mts';
import type { SlotDefinition } from '../src/types.js';

const jsonPath = new URL('../packs/adult-intake.pack.json', import.meta.url);
const tsPath = new URL('../src/packs/adult-intake.ts', import.meta.url);

describe('adult intake pack parity with independent authoring oracle', () => {
  it.each(['phq4', 'unscored', 'pending'] as const)('reconstructs every runtime field for %s', mentalHealth => {
    const authored = createAuthoredClinicContent({ mentalHealth });
    expect(compilePack(questionnairePackSchema.parse(adultIntakePack), { mentalHealth })).toStrictEqual(authored);
    expect(createClinicContent({ mentalHealth })).toStrictEqual(authored);
  });

  it('retains the published native digest when the publisher consumes compiled content', async () => {
    const compiled = compilePack(questionnairePackSchema.parse(adultIntakePack), { mentalHealth: 'phq4' });
    expect(compiled).toStrictEqual(createAuthoredClinicContent({ mentalHealth: 'phq4' }));
    const factory = vi.fn(() => compiled);
    vi.resetModules();
    vi.doMock('../src/register.js', async () => ({
      ...await vi.importActual<typeof import('../src/register.js')>('../src/register.js'),
      createClinicContent: factory,
    }));
    try {
      // Exercise the unchanged publisher through its existing factory dependency.
      const { getNativeQuestionnaireDefinition } = await import('../src/native-questionnaire.js');
      expect((await getNativeQuestionnaireDefinition()).binding.digest).toBe('45ece585454dbda2226bf0bfd5a8ae4d352c0617edc24a267b50925686e60a8f');
      expect(factory).toHaveBeenCalledWith({ mentalHealth: 'phq4' });
    } finally {
      vi.doUnmock('../src/register.js');
      vi.resetModules();
    }
  });

  it('matches the JSON, TS mirror, and freshly validated authoring source', async () => {
    const json = await readFile(jsonPath, 'utf8');
    const generated = serializeAdultIntakePack();
    expect(JSON.parse(json)).toStrictEqual(adultIntakePack);
    expect(buildAdultIntakePack()).toStrictEqual(JSON.parse(json));
    expect(generated.json).toBe(json);
    expect(generated.typescript).toBe(await readFile(tsPath, 'utf8'));
  });

  it('writes byte-identical JSON and TS output on two exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corvo-pack-export-'));
    try {
      const paths = ['packages/clinic-content/packs/adult-intake.pack.json', 'packages/clinic-content/src/packs/adult-intake.ts'];
      await exportAdultIntakePack(root);
      const first = await Promise.all(paths.map(path => readFile(join(root, path))));
      await exportAdultIntakePack(root);
      const second = await Promise.all(paths.map(path => readFile(join(root, path))));
      expect(second).toStrictEqual(first);
      expect(first[0].toString()).toBe(await readFile(jsonPath, 'utf8'));
      expect(first[1].toString()).toBe(await readFile(tsPath, 'utf8'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves absent and explicit false optional slot fields recursively', () => {
    const slots: SlotDefinition[] = [
      { id: 'absent', label: 'Absent', kind: 'text', promptIds: [] },
      { id: 'explicit', label: 'Explicit', kind: 'collection', promptIds: [], optional: false, acceptsNegative: false, acceptsNotApplicable: false, acceptsUncertain: false, fields: [
        { id: 'child', label: 'Child', kind: 'choice', promptIds: [], optional: true, choices: [false, 0, ''], when: { slotId: 'child', condition: 'positive', alsoWhenTrue: 'child', orSlotIds: [] } },
      ] },
    ];
    expect(slots.map(slotToPackItem).map(compilePackItem)).toStrictEqual(slots);
  });

  it('rejects a pending configuration collision in the merged runtime namespace', () => {
    const pack = questionnairePackSchema.parse(adultIntakePack);
    pack.topics.find(topic => topic.linkId === 'Q16')!.item.push({
      linkId: 'mentalHealth.configuration', text: 'Authored slot', type: 'text', corvo: { promptIds: [] },
    });
    expect(questionnairePackSchema.safeParse(pack).success).toBe(true);
    expect(() => compilePack(pack, { mentalHealth: 'pending' })).toThrow('pack-duplicate-compiled-slot-id');
    expect(() => compilePack(pack, { mentalHealth: 'phq4' })).not.toThrow();
  });

  it('accepts direct base PHQ placement and replaces its slots in other modes', () => {
    const pack = questionnairePackSchema.parse(adultIntakePack);
    const q16 = pack.topics.find(topic => topic.linkId === 'Q16')!;
    const phq = pack.mentalHealth.slots.phq4!;
    q16.item.splice(3, 0, ...phq);
    delete pack.mentalHealth.slots.phq4;
    const parsed = questionnairePackSchema.parse(pack);
    for (const mentalHealth of ['phq4', 'unscored', 'pending'] as const) {
      expect(compilePack(parsed, { mentalHealth })).toStrictEqual(createAuthoredClinicContent({ mentalHealth }));
    }
  });

  it('rejects direct base PHQ items outside the canonical locked order', () => {
    const pack = questionnairePackSchema.parse(adultIntakePack);
    const q16 = pack.topics.find(topic => topic.linkId === 'Q16')!;
    q16.item.splice(3, 0, ...[...pack.mentalHealth.slots.phq4!].reverse());
    delete pack.mentalHealth.slots.phq4;
    const result = questionnairePackSchema.safeParse(pack);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['topics', pack.topics.indexOf(q16), 'item'], message: 'PHQ-4 base items require the exact ordered locked item ids' }));
    expect(() => compilePack(pack, { mentalHealth: 'phq4' })).toThrow('PHQ-4 base items require the exact ordered locked item ids');
  });

  it('rejects mode selection that leaves a condition referencing a removed PHQ item', () => {
    const pack = questionnairePackSchema.parse(adultIntakePack);
    const q16 = pack.topics.find(topic => topic.linkId === 'Q16')!;
    q16.item.splice(3, 0, ...pack.mentalHealth.slots.phq4!);
    delete pack.mentalHealth.slots.phq4;
    q16.item.push({ linkId: 'dependent', text: 'Dependent', type: 'text', corvo: { promptIds: [] }, enableWhen: { question: 'MH01', operator: 'positive' } });
    expect(questionnairePackSchema.safeParse(pack).success).toBe(true);
    expect(() => compilePack(pack, { mentalHealth: 'phq4' })).not.toThrow();
    for (const mentalHealth of ['unscored', 'pending'] as const) {
      expect(() => compilePack(pack, { mentalHealth })).toThrow('pack-compiled-slot-reference-missing');
    }
  });

  it('rejects malformed packs and unavailable configuration before returning content', () => {
    const value = questionnairePackSchema.parse(adultIntakePack);
    value.prompts[0].text = 'Changed source';
    expect(compilePack(value, { mentalHealth: 'pending' }).promptsById[value.prompts[0].id].text).toBe('Changed source');
    value.prompts[0].wordingStatus = 'approved' as never;
    expect(() => compilePack(value, { mentalHealth: 'phq4' })).toThrow();
    const missing = questionnairePackSchema.parse(adultIntakePack);
    delete missing.mentalHealth.options.pending;
    expect(() => compilePack(missing, { mentalHealth: 'pending' })).toThrow('mental-health-selection-unavailable');
    expect(() => compilePack(adultIntakePack, { mentalHealth: 'invalid' as never })).toThrow('mental-health-selection-required');
  });
});
