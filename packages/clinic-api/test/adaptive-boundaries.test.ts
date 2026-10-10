import { describe, expect, it, vi } from 'vitest';
import { applyValidatedTurn, validateAdaptiveProposal } from '../src/adaptive-validation.js';
import { buildAdaptiveMessages, createDigitalOceanProposer } from '../src/adaptive.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { context, evidence, fact, proposal, register, source, withPrior } from './fixtures/adaptive.js';

describe('untrusted proposal and immutable application boundaries', () => {
  it.each([
    { owner: 'physician' }, { patient: 'Patient/other' }, { complete: true }, { score: 0 }, { prescribed: true }, { replyText: 'You are eligible' },
  ])('rejects model authority keys %j', extra => {
    const ctx = context('172 cm');
    expect(() => validateAdaptiveProposal({ ...proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number')]), ...extra }, ctx)).toThrow('invalid-adaptive-proposal');
    expect(ctx.responses).toEqual({});
  });
  it('rejects a forbidden field even alongside otherwise valid height extraction', () => {
    const ctx = context('172 cm');
    expect(() => validateAdaptiveProposal(proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number'), fact(ctx, 'Q04', 'currentWeightEstimate.statedAt', '172')]), ctx)).toThrow('model-field-forbidden');
  });
  it('rejects a foreign source, out of bounds span, unknown topic and unknown item instead of partially applying', () => {
    const ctx = context('172 cm');
    const good = fact(ctx, 'Q04', 'height.value', '172', 'explicit-number');
    for (const bad of [
      { ...good, evidence: [{ sourceId: 'another-patient', start: 0, end: 3 }] },
      { ...good, evidence: [{ sourceId: ctx.source.id, start: 0, end: 9999 }] },
      { ...good, topicId: 'W07' }, { ...good, path: 'medicines[guessed].name' },
    ]) expect(() => validateAdaptiveProposal(proposal([bad]), ctx)).toThrow();
    expect(ctx.responses).toEqual({});
  });
  it('rejects assistant evidence and a source that does not match the persisted source snapshot', () => {
    const ctx = context('172 cm');
    expect(() => validateAdaptiveProposal(proposal(), { ...ctx, source: { ...ctx.source, role: 'assistant' } })).toThrow('invalid-adaptive-source');
    expect(() => validateAdaptiveProposal(proposal(), { ...ctx, sources: [{ ...ctx.source, text: '173 cm' }] })).toThrow('invalid-adaptive-source');
  });
  it('preserves UTF-16 offsets and newlines, rejecting split emoji surrogates', () => {
    const ctx = context('🙂\nI want to walk with my family.', ['Q01']);
    const valid = validateAdaptiveProposal(proposal([fact(ctx, 'Q01', 'priority', 'walk with my family')]), ctx);
    expect(applyValidatedTurn(ctx, valid).provenance[0].sourceText).toEqual(['walk with my family']);
    const bad = { ...fact(ctx, 'Q01', 'priority', '🙂'), evidence: [{ sourceId: ctx.source.id, start: 0, end: 1 }] };
    expect(() => validateAdaptiveProposal(proposal([bad]), ctx)).toThrow('invalid-source-span');
  });
  it('refuses application after source, patient, content, revision or answer snapshot changes', () => {
    const ctx = context('172 cm');
    const validated = validateAdaptiveProposal(proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number')]), ctx);
    for (const changed of [
      { ...ctx, binding: { ...ctx.binding, patient: 'Patient/other' } },
      { ...ctx, binding: { ...ctx.binding, revision: 3 } },
      { ...ctx, binding: { ...ctx.binding, contentVersion: 'CC-new' } },
      { ...ctx, source: { ...ctx.source, text: '173 cm' } },
      { ...ctx, responses: { Q04: { presented: true, answers: {} } } },
    ]) expect(() => applyValidatedTurn(changed, validated)).toThrow('stale-adaptive-context');
  });
  it('does not accept a forged or serialized trust marker', () => {
    const ctx = context('172 cm');
    const validated = validateAdaptiveProposal(proposal(), ctx);
    expect(() => applyValidatedTurn(ctx, JSON.parse(JSON.stringify(validated)))).toThrow('stale-adaptive-context');
  });
  it('does not expose a mutable internal result through the applied outcome', () => {
    const ctx = context('172 cm');
    const validated = validateAdaptiveProposal(proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number')]), ctx);
    const first = applyValidatedTurn(ctx, validated); first.responses.Q04 = undefined;
    expect(applyValidatedTurn(ctx, validated).responses.Q04?.answers['height.value']).toMatchObject({ value: 172 });
  });
  it('requires an explicit correction with exactly the prior field source IDs', () => {
    const ctx = withPrior(context('My height is 173 cm'), 'Q04', { 'height.value': { state: 'known', value: 172, sourceIds: ['prior'] } });
    expect(() => validateAdaptiveProposal(proposal([{ ...fact(ctx, 'Q04', 'height.value', '173', 'explicit-number'), correctsSourceIds: ['prior'] }]), ctx)).toThrow('invalid-correction-target');
  });
  it('defers ambiguous alternatives instead of extracting one of two plausible numbers', () => {
    const ctx = context('It was 172 or 173 cm');
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number')]), ctx));
    expect(result.updates).toEqual([]);
    expect(result.clarifications[0].reason).toBe('ambiguous-value');
  });
  it('does not borrow units from the earlier reading for a different estimate', () => {
    const ctx = context('Last measured 230 pounds; I estimate 235 now.');
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([
      fact(ctx, 'Q04', 'lastMeasuredWeight.value', '230', 'explicit-number'), fact(ctx, 'Q04', 'lastMeasuredWeight.unit', 'pounds', 'explicit-unit'),
      fact(ctx, 'Q04', 'currentWeightEstimate.value', '235', 'explicit-number'), fact(ctx, 'Q04', 'currentWeightEstimate.unit', 'pounds', 'explicit-unit'),
    ]), ctx));
    expect(result.responses.Q04?.answers['lastMeasuredWeight.unit']).toMatchObject({ value: 'lb' });
    expect(result.responses.Q04?.answers['currentWeightEstimate.value']).toMatchObject({ value: 235 });
    expect(result.responses.Q04?.answers['currentWeightEstimate.unit']).toBeUndefined();
    expect(result.responses.Q04?.answers['lastMeasuredWeight.representsCurrent']).toBeUndefined();
    expect(result.clarifications).toContainEqual(expect.objectContaining({ path: 'currentWeightEstimate.unit', reason: 'unscoped-response' }));
  });
  it('activates the existing diabetes branch from an explicit same-turn diagnosis without letting metformin trigger it', () => {
    const ctx = context('I was told I have diabetes. Type 2, diagnosed in 2020.', ['Q06', 'DM']);
    const input = proposal([
      fact(ctx, 'DM', 'when', '2020'), fact(ctx, 'DM', 'typeStatus', 'Type 2'), fact(ctx, 'Q06', 'conditions.diabetes', 'I was told I have diabetes', 'explicit-choice'),
    ]);
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
    expect(result.responses.DM).toMatchObject({ applicability: 'applicable', answers: { typeStatus: { value: 'Type 2' }, when: { value: '2020' } } });
    const uncertain = context('I might have diabetes. Type 2 maybe.', ['Q06', 'DM']);
    const held = applyValidatedTurn(uncertain, validateAdaptiveProposal(proposal([
      fact(uncertain, 'Q06', 'conditions.diabetes', 'I might have diabetes', 'scoped-response', 'uncertain'), fact(uncertain, 'DM', 'typeStatus', 'Type 2 maybe'),
    ]), uncertain));
    expect(held.responses.Q06?.answers['conditions.diabetes']?.state).toBe('uncertain');
    expect(held.responses.DM).toBeUndefined();
    expect(held.clarifications[0].reason).toBe('condition-unresolved');
  });
  it('keeps a model uncertainty act visibly unresolved even when the schema is valid', () => {
    const ctx = context('There is much more I meant to say.');
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([], { acts: [{ kind: 'unclear', evidence: evidence(ctx, ctx.source.text) }] }), ctx));
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
  it('does not promote pre-diabetes to diabetes or swap a point glucose result into A1C', () => {
    const ctx = context('I was told I have pre-diabetes.', ['Q06']);
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([
      fact(ctx, 'Q06', 'conditions.diabetes', ctx.source.text, 'explicit-choice'), fact(ctx, 'Q06', 'conditions.prediabetes', ctx.source.text, 'explicit-choice'),
    ]), ctx));
    expect(result.responses.Q06?.answers['conditions.diabetes']).toBeUndefined();
    expect(result.responses.Q06?.answers['conditions.prediabetes']).toMatchObject({ value: true });
    const glucose = context('My meter read 120 mg/dL yesterday; A1C was 6.5 percent.', ['DM']);
    glucose.responses = { DM: { presented: true, applicability: 'applicable', answers: {} } };
    const swapped = applyValidatedTurn(glucose, validateAdaptiveProposal(proposal([
      fact(glucose, 'DM', 'a1c.value', '120', 'explicit-number'), fact(glucose, 'DM', 'latestGlucose.value', '6.5', 'explicit-number'),
    ]), glucose));
    expect(swapped.updates).toEqual([]);
    expect(swapped.clarifications).toHaveLength(2);
  });
  it('requires matching explicit composite height units and rejects invalid inch components', () => {
    const ctx = context('5 feet 8 inches cm');
    expect(() => validateAdaptiveProposal(proposal([fact(ctx, 'Q04', 'height.value', '5 feet 8 inches', 'explicit-height'), fact(ctx, 'Q04', 'height.unit', 'cm', 'explicit-unit')]), ctx)).toThrow('height-unit-conflict');
    const bad = context('5 feet 12 inches');
    expect(applyValidatedTurn(bad, validateAdaptiveProposal(proposal([fact(bad, 'Q04', 'height.value', bad.source.text, 'explicit-height')]), bad)).updates).toEqual([]);
  });
  it('does not close a list from silence, a finite paragraph, or an unrelated completion phrase', () => {
    const ctx = context('Metformin. That is all.', ['Q08']);
    const field = fact(ctx, 'Q08', 'name', 'Metformin');
    const input = proposal([], { newItems: [{ topicId: 'Q08', collection: 'medicines', key: 'model-name', fields: [{ path: 'name', state: 'known', evidence: field.evidence, transform: 'verbatim' }] }] });
    const open = applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
    expect(open.responses.Q08?.answers.medicines).toMatchObject({ complete: false });
    const closed = applyValidatedTurn(ctx, validateAdaptiveProposal({ ...input, completedLists: [{ topicId: 'Q08', path: 'medicines', evidence: evidence(ctx, 'That is all') }] }, ctx));
    expect(closed.responses.Q08?.answers.medicines).toMatchObject({ complete: true });
    expect(closed.provenance.find(item => item.transform === 'explicit-list-completion')).toBeDefined();
  });
  it('keeps duplicate item identity server-derived and stable across the same proposal', () => {
    const ctx = context('Metformin', ['Q08']);
    const input = proposal([], { newItems: [{ topicId: 'Q08', collection: 'medicines', key: 'arbitrary-model-key', fields: [{ path: 'name', state: 'known', transform: 'verbatim', evidence: evidence(ctx, 'Metformin') }] }] });
    const one = applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
    const two = applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
    expect(one.responses).toEqual(two.responses);
    expect(JSON.stringify(one.responses)).not.toContain('arbitrary-model-key');
  });
  it('validates bounded arrays and refuses hidden value/coercion fields', () => {
    const ctx = context('172 cm');
    const good = fact(ctx, 'Q04', 'height.value', '172', 'explicit-number');
    expect(() => validateAdaptiveProposal(proposal(Array(33).fill(good)), ctx)).toThrow('invalid-adaptive-proposal');
    expect(() => validateAdaptiveProposal(proposal([{ ...good, value: 173 } as never]), ctx)).toThrow('invalid-adaptive-proposal');
    expect(() => validateAdaptiveProposal(proposal([{ ...good, evidence: [{ sourceId: ctx.source.id, start: '0', end: 3 }] } as never]), ctx)).toThrow('invalid-adaptive-proposal');
  });
  it('does not use an unsupported reply ID or an ineligible next probe', () => {
    const ctx = context('Can I have medication?');
    expect(() => validateAdaptiveProposal(proposal([], { acts: [{ kind: 'question', replyId: 'invented-advice', evidence: evidence(ctx, ctx.source.text) }] }), ctx)).toThrow('reply-not-allowed');
    expect(() => validateAdaptiveProposal(proposal([], { next: { topicId: 'Q04', promptId: 'DM05', targetPaths: ['height.value'] } }), ctx)).toThrow('probe-not-allowed');
  });
  it('groups common-condition questions and permits explicit agenda changes', () => {
    const ctx = context('I would rather discuss medicines first', ['Q03', 'Q06', 'Q08']);
    const condition = eligibleAdaptiveProbes(ctx).find(probe => probe.promptId === 'Q06a')!;
    expect(condition.targetPaths).toEqual(['conditions.diabetes', 'conditions.prediabetes']);
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([], { acts: [{ kind: 'topic-switch', targetTopicId: 'Q08', evidence: evidence(ctx, ctx.source.text) }] }), ctx));
    expect(selectAdaptiveDialogue(ctx, result).prompt?.topicId).toBe('Q08');
  });
  it('allows a previously unknown detail to become known without a false contradiction', () => {
    const ctx = withPrior(context('I remember, it was 172 cm'), 'Q04', { 'height.value': { state: 'unknown', sourceIds: ['prior'] } });
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number')]), ctx));
    expect(result.responses.Q04?.answers['height.value']).toMatchObject({ state: 'known', value: 172 });
    expect(result.clarifications).toEqual([]);
  });
  it('reopens a stopped topic only from an explicit return request, preserving the earlier decline source', () => {
    const ctx = withPrior(context('I would like to return to height. It is 172 cm.'), 'Q04', { 'height.value': { state: 'declined', sourceIds: ['prior'] } });
    ctx.responses = { Q04: { ...ctx.responses.Q04!, stopped: 'patient-declines' } };
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number')], { acts: [{ kind: 'topic-switch', targetTopicId: 'Q04', evidence: evidence(ctx, 'I would like to return to height') }] }), ctx));
    expect(result.responses.Q04?.stopped).toBeUndefined();
    expect(result.responses.Q04?.answers['height.value']).toMatchObject({ state: 'known', value: 172 });
    expect(ctx.sources.map(item => item.id)).toContain('prior');
  });
  it('keeps a suspended topic after a patient question despite a different model nomination', () => {
    const ctx = context('What can you help with?', ['Q04', 'Q03']);
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([], { acts: [{ kind: 'question', replyId: 'COPY-02', evidence: evidence(ctx, ctx.source.text) }], next: { topicId: 'Q03', promptId: 'Q03', targetPaths: ['childhood'] } }), ctx));
    expect(selectAdaptiveDialogue(ctx, result).prompt?.topicId).toBe('Q04');
  });
});

describe('one bounded direct DigitalOcean proposer request', () => {
  const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'test-only-key', model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 4096 };
  const providerResponse = (content: string, finish = 'stop', model = config.model) => new Response(JSON.stringify({ id: 'provider-receipt', model, choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }));
  it('minimizes the prompt and never sends binding identifiers or unrelated source history', async () => {
    const ctx = context('172 cm'); ctx.sources = [source('UNRELATED PRIVATE SOURCE', 'older'), ...ctx.sources];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages.map((message: { content: string }) => message.content).join('\n')).not.toMatch(/Patient\/secret|session-secret|operation-secret|snapshot-secret|UNRELATED PRIVATE SOURCE/);
      expect(body.model).toBe('qwen3.8-max');
      return providerResponse(JSON.stringify(proposal()));
    });
    const result = await createDigitalOceanProposer(config, fetcher).propose(ctx);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.receipt?.requestId).toBe('provider-receipt');
    expect(result.proposal).toEqual(proposal());
  });
  it('builds a bounded first-intake context without slicing raw answers', () => {
    const ctx = context('My priority is walking with my family', register.topics.map(topic => topic.id));
    const messages = buildAdaptiveMessages(ctx);
    expect(messages[1].content).toContain(ctx.source.text);
    expect(String(messages[1].content).length).toBeLessThanOrEqual(32000);
  });
  it('does not repair markdown, malformed JSON or length-truncated provider output', async () => {
    for (const [content, finish, error] of [['```json\n{}\n```', 'stop', 'invalid-adaptive-json'], ['{', 'stop', 'invalid-adaptive-json'], ['{}', 'length', 'inference-incomplete-output']]) {
      const fetcher = vi.fn(async () => providerResponse(content, finish));
      await expect(createDigitalOceanProposer(config, fetcher).propose(context('172 cm'))).rejects.toThrow(error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('does not retry or use fallback after provider transport failure', async () => {
    const fetcher = vi.fn(async () => { throw new Error('connection lost'); });
    await expect(createDigitalOceanProposer(config, fetcher).propose(context('172 cm'))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never invokes a provider on an existing policy safety interruption', async () => {
    const fetcher = vi.fn(async () => providerResponse('{}'));
    await expect(createDigitalOceanProposer(config, fetcher).propose(context('I may hurt myself tonight'))).rejects.toThrow('safety-interruption');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed on excessive context rather than silently dropping evidence', () => {
    const ctx = context('172 cm');
    ctx.approvedReplies = [{ id: 'long', purpose: 'Long verified context', text: 'x'.repeat(33000) }];
    expect(() => buildAdaptiveMessages(ctx)).toThrow('adaptive-context-too-large');
  });
});
