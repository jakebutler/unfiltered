import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import Ajv from 'ajv';
import { describe, it, expect, vi } from 'vitest';
import { createAdaptiveSourceHandles } from '../src/adaptive-group-source-handles.js';
import {
  createAdaptiveSourceGroupManifest,
  issuedAdaptiveSourceGroupManifest,
  expandAdaptiveSourceGroupProposal,
  sourceGroupProtocol,
  sourceGroupGuidanceRevision,
  sourceGroupNativeRevision,
} from '../src/adaptive-group-v7.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { selectAdaptiveGroupDialogue, eligibleAdaptiveProbes, adaptiveGroupRejectedTargets } from '../src/dialogue.js';
import { createAdaptiveGroupManifest, issuedAdaptiveGroupManifest } from '../src/adaptive-group-manifest.js';
import { issuedAdaptiveSourceExpansion } from '../src/adaptive-group-v7.js';
import { createDigitalOceanProposer, prepareAdaptiveRequest, validateAdaptiveProposalResult } from '../src/adaptive.js';
import { context, withPrior, register } from './fixtures/adaptive.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
const saved = JSON.parse(
  readFileSync(new URL('../../../docs/implementation/evidence/DO-A19-PREFLIGHT.json', import.meta.url), 'utf8'),
);
const harness = readFileSync(new URL('../../../scripts/qualification/qualify-adaptive.mjs', import.meta.url), 'utf8');
const invariants = runInNewContext(
  `(${harness.slice(harness.indexOf('function invariants('), harness.indexOf('const selectedFixtures'))})`,
);
const config = {
  endpoint: 'https://inference.do-ai.run' as const,
  apiKey: 'offline-mock-only',
  model: 'qwen3.8-max' as const,
  timeoutMs: 15000,
  maxOutputTokens: 4096,
  maxRequestBytes: 60000,
};
const options = {
  protocol: sourceGroupProtocol,
  guidanceRevision: sourceGroupGuidanceRevision,
  nativeSchemaRevision: sourceGroupNativeRevision,
};
function setup(ctx: AdaptiveContext) {
  const manifest = createAdaptiveSourceGroupManifest(ctx),
    { handles } = issuedAdaptiveSourceGroupManifest(manifest, ctx);
  const p = (quote: string) => {
    const found = handles.statements.find((p) => p.text.includes(quote));
    if (!found) throw new Error(`No statement ${quote}`);
    return found.ref;
  };
  const f = (r: string, quote: string, support = quote) => {
    const primary = p(support),
      lex = handles.lexical.find((v) => v.text === quote && v.statement === primary);
    return { r, s: 'known', v: lex?.ref ?? { q: quote }, p: [primary] };
  };
  const n = (r: string, state: string, support: string) => ({ r, s: state, v: null, p: [p(support)] });
  const g = (kind: string, fields: unknown[], key = 'g') => ({ kind, key, scope: 'patient', fields });
  const item = (kind: string, key: string, anchor: any, fields: unknown[]) => ({
    kind,
    key,
    scope: { mode: 'new', anchor },
    fields,
  });
  const wire = (groups: unknown[], rest = {}) => ({ schema: 7, context: manifest.id, groups, ...rest });
  const validate = (raw: unknown) => {
    const x = expandAdaptiveSourceGroupProposal(raw, ctx, manifest),
      groups = validateAdaptiveGroupProposal(x.raw, ctx, x.manifest);
    return { groups, outcome: groups.outcome, dialogue: selectAdaptiveGroupDialogue(ctx, groups) };
  };
  return { manifest, handles, p, f, n, g, item, wire, validate };
}
function oracle(id: string, ctx: AdaptiveContext) {
  const x = setup(ctx),
    { f, n, g, item, p, wire } = x;
  let raw: any;
  if (id === 'G1')
    raw = wire([
      g('Q04', [
        f('height.value', 'five feet eight inches'),
        f('lastMeasuredWeight.value', '230'),
        f('lastMeasuredWeight.unit', 'pounds', '230 pounds'),
        f('lastMeasuredWeight.measuredWhen', 'August 12'),
        n('lastMeasuredWeight.representsCurrent', 'uncertain', 'not sure whether'),
        f('currentWeightEstimate.value', '235'),
        f('currentWeightEstimate.unit', 'pounds', '235 pounds'),
      ]),
    ]);
  if (id === 'G2')
    raw = wire([
      g('Q03', [
        f('childhood', 'heavier than my classmates'),
        f('teenage', 'my weight stayed steady'),
        f('afterSchool', 'my weight increased'),
        n('past18Months', 'unknown', 'past 18 months'),
      ]),
    ]);
  if (id === 'G3')
    raw = wire(
      [
        g('Q11', [
          f('day', 'Yesterday'),
          n('otherIntake', 'negative', 'Nothing else'),
          f('typicality', 'It was a usual day.'),
        ]),
        item('Q11.occasions', 'b', f('foods', 'oatmeal'), [
          f('time', '8 am'),
          f('drinks', 'coffee', 'oatmeal and coffee'),
          n('foodAmounts', 'unknown', 'oatmeal portion'),
          n('drinkAdditions', 'unknown', 'oatmeal portion'),
        ]),
        item('Q11.occasions', 'l', f('foods', 'sandwich'), [
          f('time', 'noon'),
          f('foodAmounts', 'one sandwich'),
          f('drinks', 'water'),
          f('drinkAmounts', 'a glass'),
        ]),
      ],
      { completedLists: [{ family: 'Q11.occasions', p: [p('all the food')] }] },
    );
  if (id === 'G4')
    raw = wire(
      [
        item('Q08.medicines', 'm', f('name', 'Metformin'), [
          f('strength', '500 mg'),
          f('labelDirections', 'twice daily'),
          f('actualUse', 'once daily'),
          f('reason', 'PCOS'),
        ]),
        item('Q08.medicines', 'v', f('name', 'Vitamin D'), [
          f('strength', '1000 IU'),
          f('labelDirections', 'once weekly'),
          f('actualUse', 'once monthly'),
        ]),
      ],
      {
        sharedConcerns: [
          { family: 'Q08.medicines', entities: ['m', 'v'], answer: { s: 'negative', v: null, p: [p('No concerns')] } },
        ],
        completedLists: [{ family: 'Q08.medicines', p: [p('all of my medicines')] }],
      },
    );
  if (id === 'G5')
    raw = wire(
      [
        g('Q06', [
          n('conditions.prediabetes', 'uncertain', 'might have prediabetes'),
          f('uncertainDiagnosis', 'I was told I might have prediabetes, but no diagnosis yet.'),
        ]),
        item('Q10.familyHistory', 'f', f('condition', 'diabetes', 'My mother'), [f('relationship', 'mother')]),
      ],
      { acts: [{ kind: 'question', reply: 'COPY-02', p: [p('Can you tell')] }] },
    );
  if (id === 'G6')
    raw = wire([g('Q04', [f('height.value', '172'), f('height.unit', 'cm')])], {
      acts: [{ kind: 'question', reply: 'COPY-05', p: [p('Should I double')] }],
    });
  if (id === 'G7')
    raw = wire([
      {
        kind: 'Q08.medicines',
        key: 'm',
        scope: { mode: 'existing', ref: 'e0', anchor: { v: { q: 'metformin' }, p: [p('Actually')] } },
        fields: [f('strength', '500 mg')],
        correct: [0],
      },
    ]);
  if (id === 'G8')
    raw = wire(
      [
        item('W07', 'r', f('medicine', 'Semaglutide'), [
          f('directions', 'weekly'),
          f('actualUse', 'Sundays'),
          f('remaining', 'one pen'),
          f('pharmacy', 'Main Street Pharmacy'),
          f('symptomsChanges', 'mildly nauseated'),
          f('help', 'prescribe it now'),
        ]),
      ],
      { acts: [{ kind: 'question', reply: 'COPY-05', p: [p('Tell me what dose')] }] },
    );
  return { x, raw };
}

describe('V7 issued source handles, offline only', () => {
  it('preserves every character, punctuation protection, Unicode and deterministic consecutive <=64 coalescing', () => {
    const text =
      "Dr. A. says 1.72 m;\r\n🙂 5 feet 8 inches. I am in school; I'm unsure. " +
      Array.from({ length: 130 }, (_, i) => `Clause ${i}; `).join('');
    const a = createAdaptiveSourceHandles(context(text)),
      b = createAdaptiveSourceHandles(context(text));
    expect(a).toEqual(b);
    expect(a.statements.length).toBeLessThanOrEqual(64);
    expect(a.statements.map((p) => p.text).join('')).toBe(text);
    expect(a.statements[0].text).toContain('Dr. A. says 1.72 m;');
    for (let i = 1; i < a.statements.length; i++) expect(a.statements[i].start).toBe(a.statements[i - 1].end);
    expect(a.lexical.filter((v) => v.kind === 'unit').map((v) => v.text)).not.toContain('in');
    expect(a.lexical.some((v) => v.kind === 'height' && v.text === '5 feet 8 inches')).toBe(true);
    const clutter = createAdaptiveSourceGroupManifest(
      context(Array(210).fill("I'm in school, m is a letter.").join(' ')),
    );
    expect(
      issuedAdaptiveSourceGroupManifest(clutter, context(Array(210).fill("I'm in school, m is a letter.").join(' ')))
        .handles.lexical,
    ).toEqual([]);
    expect(() => createAdaptiveSourceHandles(context(Array(100).fill('2 kg;').join(' ')))).toThrow(
      'source-handle-limit',
    );
  });
  it.each(saved.results.map((entry: any) => [entry.caseId, entry.context]))(
    'retains unchanged development %s clinical invariants and valid native output',
    async (id: string, ctx: AdaptiveContext) => {
      const { x, raw } = oracle(id, ctx),
        validate = new Ajv().compile(x.manifest.jsonSchema);
      expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
      const v = x.validate(raw);
      expect(invariants({ id }, v.outcome, v.dialogue)).toEqual([]);
      const prepared = await prepareAdaptiveRequest(ctx, config, options);
      expect(prepared.nativeSchemaRevision).toBe(sourceGroupNativeRevision);
      expect(prepared.responseSchema?.name).toBe('adaptive_scoped_groups_v7');
      expect(v.groups.hasInterpretationGaps).toBe(false);
    },
  );
  it('isolates absent and ambiguous exact quotes and dependent anchors while retaining independent question', () => {
    const ctx = context('Amlodipine Amlodipine 5 mg. Should I double my dose?', ['Q08']),
      x = setup(ctx);
    const raw = x.wire([x.item('Q08.medicines', 'm', x.f('name', 'Amlodipine'), [x.f('strength', '5 mg')])], {
      acts: [{ kind: 'question', reply: 'COPY-05', p: [x.p('Should I double')] }],
    });
    const v = x.validate(raw);
    expect(v.groups.rejectedCandidates.map((c) => [c.role, c.reason, c.guardCode])).toEqual([
      ['name', 'source-quote-rejection', 'ambiguous-source-quote'],
      ['strength', 'dependent-anchor-rejected', undefined],
    ]);
    expect(v.dialogue.reply?.id).toBe('COPY-05');
    expect(v.outcome.responses.Q08?.answers.medicines).toBeUndefined();
    expect(v.dialogue.clarification).toBeUndefined();
    expect(v.groups.hasInterpretationGaps).toBe(true);
    (raw.groups[0] as any).scope.anchor.v = { q: 'foreign absent quote' };
    expect(x.validate(raw).groups.rejectedCandidates[0].guardCode).toBe('source-quote-not-found');
  });
  it('rejects foreign refs, wrong-source lexical values, malformed/duplicate declarations, stale binding and safety envelope', () => {
    const ctx = context('I am 172 cm. I estimate 80 kg.');
    const x = setup(ctx),
      base = x.wire([x.g('Q04', [x.f('height.value', '172')])]);
    const unknown = structuredClone(base);
    (unknown.groups[0] as any).fields[0].v = 'v999';
    expect(() => x.validate(unknown)).toThrow('invalid-group-proposal');
    const foreign = structuredClone(base);
    (foreign.groups[0] as any).fields[0].p = ['p999'];
    expect(() => x.validate(foreign)).toThrow('invalid-statement-ref');
    const wrong = structuredClone(base);
    (wrong.groups[0] as any).fields[0].p = [x.p('estimate')];
    expect(() => x.validate(wrong)).toThrow('unsupported-value-span');
    const duplicate = structuredClone(base);
    (duplicate.groups[0] as any).fields.push((duplicate.groups[0] as any).fields[0]);
    expect(() => x.validate(duplicate)).toThrow('duplicate-group-role');
    const malformed = structuredClone(base);
    (malformed.groups[0] as any).fields[0].v = null;
    expect(() => x.validate(malformed)).toThrow('invalid-group-proposal');
    expect(new Ajv().compile(x.manifest.jsonSchema)(malformed)).toBe(false);
    const nonknown = structuredClone(base);
    (nonknown.groups[0] as any).fields[0].s = 'unknown';
    expect(() => x.validate(nonknown)).toThrow('invalid-group-proposal');
    expect(new Ajv().compile(x.manifest.jsonSchema)(nonknown)).toBe(false);
    expect(() =>
      expandAdaptiveSourceGroupProposal(base, { ...ctx, binding: { ...ctx.binding, revision: 4 } }, x.manifest),
    ).toThrow('stale-group-manifest');
    const safety = context('I am 172 cm. I want to kill myself.');
    const s = setup(safety);
    expect(() => s.validate(s.wire([s.g('Q04', [s.f('height.value', '172')])]))).toThrow('safety-interruption');
  });
  it('narrows native/local selectors by reviewed role kind and never issues ordinal or preposition units', () => {
    const ctx = context(
        'My height is 172 cm. I measured 80 kg. There were 5 in the last five years. I am 1st in school.',
      ),
      x = setup(ctx),
      native = new Ajv().compile(x.manifest.jsonSchema);
    expect(x.handles.lexical.some((v) => v.kind === 'unit' && v.text === 'in')).toBe(false);
    expect(x.handles.lexical.some((v) => v.kind === 'unit' && v.text === 'st')).toBe(false);
    expect(x.handles.lexical.some((v) => v.kind === 'number' && v.text === '1')).toBe(false);
    const number = x.handles.lexical.find((v) => v.text === '172')!,
      unit = x.handles.lexical.find((v) => v.text === 'cm')!;
    for (const field of [
      { r: 'lastMeasuredWeight.value', s: 'known', v: unit.ref, p: [unit.statement] },
      { r: 'height.unit', s: 'known', v: number.ref, p: [number.statement] },
      { r: 'height.value', s: 'known', v: { q: '172' }, p: [number.statement] },
    ]) {
      const raw = x.wire([x.g('Q04', [field])]);
      expect(native(raw)).toBe(false);
      expect(() => x.validate(raw)).toThrow('invalid-group-proposal');
    }
    const preposition = context('My height is 5 in the last five years.'),
      p = setup(preposition),
      raw = p.wire([p.g('Q04', [p.f('height.value', '5'), p.f('height.unit', 'in')])]);
    expect(new Ajv().compile(p.manifest.jsonSchema)(raw)).toBe(false);
    expect(() => p.validate(raw)).toThrow('invalid-group-proposal');
  });
  it('retains exact correction lineage and leaves wrong entity/invalid strength as local gaps', () => {
    const ctx = saved.results.find((e: any) => e.caseId === 'G7').context,
      { x, raw } = oracle('G7', ctx),
      v = x.validate(raw);
    expect(v.outcome.provenance[0].correctsSourceIds).toEqual(['prior']);
    expect(ctx.responses.Q08.answers.medicines.items[0].answers.strength.value).toBe('850 mg');
    const wrong = structuredClone(raw);
    wrong.groups[0].scope.ref = 'e1';
    expect(x.validate(wrong).groups.rejectedCandidates.map((c) => c.reason)).toContain('entity-anchor-unresolved');
    const strength = structuredClone(raw);
    strength.groups[0].fields[0] = x.f('strength', '500');
    expect(x.validate(strength).groups.rejectedCandidates[0].guardCode).toBe('incomplete-strength-value');
  });
  it('preserves same-clause multi-medicine correction anchors, dependent isolation and genuine conflict', () => {
    const known = (value: string) => ({ state: 'known' as const, value, sourceIds: ['prior'] });
    const ctx = withPrior(
        context('Correction: Amlodipine is 10 mg and iron is 20 mg. Should I double my dose?', ['Q08']),
        'Q08',
        {
          medicines: {
            state: 'known',
            complete: true,
            sourceIds: ['prior'],
            items: [
              { id: 'a', answers: { name: known('Amlodipine'), strength: known('5 mg') } },
              { id: 'i', answers: { name: known('Iron'), strength: known('18 mg') } },
            ],
          },
        },
      ),
      x = setup(ctx);
    const existing = (key: string, ref: string, name: string, strength: string) => ({
      kind: 'Q08.medicines',
      key,
      scope: { mode: 'existing', ref, anchor: { v: { q: name }, p: [x.p(name)] } },
      fields: [x.f('strength', strength)],
      correct: [0],
    });
    const raw = x.wire([existing('a', 'e0', 'Amlodipine', '10 mg'), existing('i', 'e1', 'iron', '20 mg')], {
      acts: [{ kind: 'question', reply: 'COPY-05', p: [x.p('Should I double')] }],
    });
    const v = x.validate(raw);
    expect(v.groups.rejectedCandidates).toEqual([]);
    expect(v.outcome.provenance.filter((p) => p.correctsSourceIds).map((p) => p.correctsSourceIds)).toEqual([
      ['prior'],
      ['prior'],
    ]);
    const broken = structuredClone(raw);
    (broken.groups[0] as any).scope.anchor.v = { q: 'absent anchor' };
    const isolated = x.validate(broken);
    expect(isolated.groups.rejectedCandidates.map((c) => c.reason)).toEqual([
      'source-quote-rejection',
      'dependent-anchor-rejected',
    ]);
    expect(isolated.dialogue.reply?.id).toBe('COPY-05');
    expect((isolated.outcome.responses.Q08?.answers.medicines as any).items[1].answers.strength.value).toBe('20 mg');
    const conflict = structuredClone(raw);
    (conflict.groups[0] as any).correct = [];
    expect(x.validate(conflict).dialogue.clarification?.reason).toBe('conflict');
  });
  it('rejects source-expansion mutation/cloning and isolates a split-surrogate quote', () => {
    const ctx = context('🙂 I want more energy.', ['Q01']),
      x = setup(ctx),
      raw = x.wire([x.g('Q01', [x.f('reason', 'more energy')])]);
    const expanded = expandAdaptiveSourceGroupProposal(raw, ctx, x.manifest);
    (expanded.raw.groups[0] as any).key = 'changed';
    expect(() => validateAdaptiveGroupProposal(expanded.raw, ctx, expanded.manifest)).toThrow('stale-source-expansion');
    const clone = expandAdaptiveSourceGroupProposal(raw, ctx, x.manifest);
    expect(() => validateAdaptiveGroupProposal(structuredClone(clone.raw), ctx, clone.manifest)).toThrow(
      'invalid-source-segment',
    );
    (raw.groups[0] as any).fields[0].v = { q: '\uD83D' };
    expect(x.validate(raw).groups.rejectedCandidates[0].guardCode).toBe('invalid-source-quote');
  });
  it('agrees on omitted-empty arrays and rejects null, extra, malformed and supplied invalid arrays without completeness defaults', () => {
    const ctx = context('I am 172 cm.'),
      x = setup(ctx),
      raw = x.wire([x.g('Q04', [x.f('height.value', '172')])]),
      native = new Ajv().compile(x.manifest.jsonSchema);
    expect(native(raw)).toBe(true);
    const expanded = expandAdaptiveSourceGroupProposal(raw, ctx, x.manifest);
    expect(expanded.raw.completedLists).toEqual([]);
    expect(expanded.raw.groups[0].correct).toEqual([]);
    expect(x.validate(raw).groups.hasInterpretationGaps).toBe(false);
    for (const mutate of [
      (r: any) => ({ ...r, acts: null }),
      (r: any) => ({ ...r, extra: true }),
      (r: any) => ({ ...r, completedLists: [{ family: 'Q04', p: ['p0'] }] }),
      (r: any) => ({ ...r, groups: [{ ...r.groups[0], correct: null }] }),
      (r: any) => ({
        ...r,
        groups: [{ ...r.groups[0], fields: [{ ...r.groups[0].fields[0], p: ['p0', 'p0', 'p0', 'p0', 'p0'] }] }],
      }),
      (r: any) => ({ ...r, groups: Array(33).fill(r.groups[0]) }),
    ]) {
      const malformed = mutate(raw);
      expect(native(malformed)).toBe(false);
      expect(() => x.validate(malformed)).toThrow('invalid-group-proposal');
    }
  });
  it('permutes all five history windows, permitting a missing-window probe only for exactly retained other-window evidence', () => {
    const windows = {
      childhood: "As a child I don't remember my weight.",
      teenage: "In my teens I don't remember my weight.",
      afterSchool: "After high school I don't remember my weight.",
      lastFiveYears: "In the last five years I don't remember my weight.",
      past18Months: "In the past 18 months I don't remember my weight.",
    };
    for (const [own, text] of Object.entries(windows))
      for (const missing of Object.keys(windows).filter((path) => path !== own)) {
        const ctx = context(text, ['Q03']);
        ctx.displayed!.targetPaths = [missing];
        const x = setup(ctx),
          raw = x.wire([x.g('Q03', [x.n(own, 'unknown', text), x.n(missing, 'unknown', text)])]),
          v = x.validate(raw);
        expect(v.outcome.responses.Q03?.answers[own]?.state).toBe('unknown');
        expect(v.groups.hasInterpretationGaps).toBe(true);
        expect(
          eligibleAdaptiveProbes(
            { ...ctx, responses: v.outcome.responses },
            adaptiveGroupRejectedTargets(ctx, v.groups),
          ).flatMap((p) => p.targetPaths),
        ).toContain(missing);
        expect(v.groups.semanticRejections.map((c) => c.path)).toContain(missing);
        const absent = x.validate(x.wire([x.g('Q03', [x.n(missing, 'unknown', text)])]));
        expect(
          eligibleAdaptiveProbes(
            { ...ctx, responses: absent.outcome.responses },
            adaptiveGroupRejectedTargets(ctx, absent.groups),
          ).flatMap((p) => p.targetPaths),
        ).not.toContain(missing);
        const uncertain = context(`${text} ${windows[missing]}`, ['Q03']);
        uncertain.displayed!.targetPaths = [missing];
        const y = setup(uncertain);
        const blocked = y.validate(y.wire([y.g('Q03', [y.n(own, 'unknown', text), y.n(missing, 'unknown', text)])]));
        expect(
          eligibleAdaptiveProbes(
            { ...uncertain, responses: blocked.outcome.responses },
            adaptiveGroupRejectedTargets(uncertain, blocked.groups),
          ).flatMap((p) => p.targetPaths),
        ).not.toContain(missing);
      }
  });
  it('reproduces the G2 rejected last-five-years claim without suppressing its truly missing probe or clearing the gap', () => {
    const ctx = saved.results.find((entry: any) => entry.caseId === 'G2').context,
      { x, raw } = oracle('G2', ctx);
    raw.groups[0].fields.push(x.n('lastFiveYears', 'unknown', 'past 18 months'));
    const v = x.validate(raw);
    expect(invariants({ id: 'G2' }, v.outcome, v.dialogue)).toEqual([]);
    expect(v.groups.hasInterpretationGaps).toBe(true);
    expect(v.groups.semanticRejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'lastFiveYears', reason: 'unscoped-response' })]),
    );
    const reversed = structuredClone(raw);
    reversed.groups[0].fields.reverse();
    const r = x.validate(reversed);
    expect(r.groups.hasInterpretationGaps).toBe(true);
    expect(r.dialogue.prompt?.targetPaths).toContain('lastFiveYears');
  });
  it('keeps candidate admission separate and rejects provider metadata shortcuts and receipt selection', async () => {
    const ctx = context('Semaglutide weekly. Amlodipine 5 mg.', ['W07'], 'refill');
    const m = createAdaptiveSourceGroupManifest(ctx, {
        candidateTopics: [register.topics.find((t) => t.id === 'Q08')!],
      }),
      h = issuedAdaptiveSourceGroupManifest(m, ctx).handles;
    const raw = {
      schema: 7,
      context: m.id,
      groups: [
        {
          kind: 'Q08.medicines',
          key: 'm',
          scope: { mode: 'new', anchor: { r: 'name', s: 'known', v: { q: 'Amlodipine' }, p: [h.statements[1].ref] } },
          fields: [],
        },
      ],
    };
    const expansion = expandAdaptiveSourceGroupProposal(raw, ctx, m);
    expect(validateAdaptiveGroupProposal(expansion.raw, ctx, expansion.manifest).rejectedCandidates[0].reason).toBe(
      'requires-topic-admission',
    );
    const c = saved.results.find((e: any) => e.caseId === 'G6').context,
      { raw: packet } = oracle('G6', c),
      prepared = await prepareAdaptiveRequest(c, config, options);
    const mock = vi.fn(async (_url, init) => {
      expect(init?.body).toBe(prepared.body);
      return new Response(
        JSON.stringify({
          id: 'offline-v7',
          model: config.model,
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(packet) } }],
        }),
      );
    });
    const result = await createDigitalOceanProposer(config, mock, options).propose(c);
    expect(
      validateAdaptiveProposalResult(c, { ...result, groups: { hasInterpretationGaps: false } } as any, options)
        .dialogue.reply?.id,
    ).toBe('COPY-05');
    expect(() =>
      validateAdaptiveProposalResult(
        c,
        { ...result, receipt: { ...result.receipt!, nativeSchemaRevision: 'v6-native-v1' } },
        options,
      ),
    ).toThrow('group-receipt-mismatch');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('reproduces V6 historical V1 and V2 requests unchanged', async () => {
    for (const file of ['DO-A16-PREFLIGHT.json', 'DO-A19-PREFLIGHT.json']) {
      const old = JSON.parse(
        readFileSync(new URL(`../../../docs/implementation/evidence/${file}`, import.meta.url), 'utf8'),
      );
      for (const e of old.results) {
        const p = await prepareAdaptiveRequest(e.context, config, {
          protocol: 'scoped-groups-v6',
          guidanceRevision: 'v6-sparse-groups-v1',
          nativeSchemaRevision: file === 'DO-A16-PREFLIGHT.json' ? undefined : 'v6-native-draft7-v2',
        });
        expect(createHash('sha256').update(p.body).digest('hex')).toBe(e.preflight.requestSha256);
      }
    }
  });
  it('records equivalent supported V6/V7 output bytes without claiming unavailable provider token measurements', () => {
    const results = [];
    for (const entry of saved.results) {
      const ctx = entry.context,
        { x, raw } = oracle(entry.caseId, ctx),
        expanded = expandAdaptiveSourceGroupProposal(raw, ctx, x.manifest),
        issued = issuedAdaptiveSourceExpansion(expanded.raw, ctx, expanded.manifest)!;
      const manifest = createAdaptiveGroupManifest(ctx, { nativeSchemaRevision: 'v6-native-draft7-v2' }),
        bound = issuedAdaptiveGroupManifest(manifest, ctx);
      const rewrite = (value: any): any => {
        if (Array.isArray(value)) return value.map(rewrite);
        if (value && typeof value === 'object') {
          if ('segment' in value && 'quote' in value) {
            const span = issued.addresses[`${value.segment}\0${value.quote}`],
              index = bound.segments.findIndex(
                (s) => s.kind === 'sentence' && s.start <= span.start && s.end >= span.end,
              );
            if (index < 0) throw new Error('Cannot author equivalent V6 address');
            return { segment: `s${index}`, quote: ctx.source.text.slice(span.start, span.end) };
          }
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
        }
        return value;
      };
      const v6 = rewrite(expanded.raw);
      v6.context = manifest.id;
      const old = validateAdaptiveGroupProposal(v6, ctx, manifest),
        next = x.validate(raw),
        oldDialogue = selectAdaptiveGroupDialogue(ctx, old);
      expect(next.groups.proposal).toEqual(old.proposal);
      expect(next.outcome).toEqual(old.outcome);
      expect(next.dialogue).toEqual(oldDialogue);
      results.push({
        caseId: entry.caseId,
        source: ctx.source.text,
        v6,
        v7: raw,
        v6OutputBytes: Buffer.byteLength(JSON.stringify(v6)),
        v7OutputBytes: Buffer.byteLength(JSON.stringify(raw)),
        proposedCompletionTokenGate: { G1: 280, G2: 240, G3: 400, G4: 420, G5: 240, G6: 150, G7: 160, G8: 300 }[
          entry.caseId as 'G1'
        ],
        completionTokens: null,
        canonicalEqual: true,
        provenanceEqual: true,
        dialogueEqual: true,
        dialogueDifference: null,
        supportedMeanings: next.outcome.responses,
        interpretationGaps: next.groups.hasInterpretationGaps,
        genuineMissingPaths: eligibleAdaptiveProbes(
          { ...ctx, responses: next.outcome.responses },
          adaptiveGroupRejectedTargets(ctx, next.groups),
        ).flatMap((p) => p.targetPaths),
        invariantFailures: invariants({ id: entry.caseId }, next.outcome, next.dialogue),
      });
    }
    writeFileSync(
      new URL('../../../docs/implementation/evidence/S2-ADAPTIVE-V7-SUPPORTED-OUTPUTS.json', import.meta.url),
      `${JSON.stringify({ mode: 'authored-offline-equivalence-not-model-qualification', protocol: sourceGroupProtocol, guidanceRevision: sourceGroupGuidanceRevision, nativeSchemaRevision: sourceGroupNativeRevision, measurement: 'UTF-8 compact JSON bytes; no exact DO/qwen3.8-max tokenizer available, no completion-token estimate', providerCalls: 0, results }, null, 2)}\n`,
    );
  });
});
