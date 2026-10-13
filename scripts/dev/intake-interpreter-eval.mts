/**
 * Small bounded live check for intake-interpreter-v1 against DigitalOcean (synthetic text only).
 *
 *   node_modules/.bin/vite-node scripts/dev/intake-interpreter-eval.mts -- glm-5.3,qwen3.8-max [caseId,...]
 *
 * Loads DIGITALOCEAN_MODEL_ACCESS_KEY from INTAKE_EVAL_ENV_FILE (default: the main checkout's .env.local)
 * without printing it. One call per case per model, no retries.
 */
import { readFileSync } from 'node:fs';
import { createClinicContent, type TopicResponse } from '../../packages/clinic-content/src/index.ts';
import { DO_ENDPOINT, DO_MODELS, digitalOcean } from '../../packages/clinical-core/src/digitalocean.ts';
import { buildIntakeInterpreterMessages, interpretIntakeResponse, intakeRequestBytes, parseIntakeInterpreterText } from '../../packages/clinic-api/src/intake-interpreter.ts';
import type { AdaptiveContext, AdaptiveOutcome } from '../../packages/clinic-api/src/adaptive-validation.ts';
import { selectAdaptiveDialogue } from '../../packages/clinic-api/src/dialogue.ts';

const envFile = process.env.INTAKE_EVAL_ENV_FILE ?? '/Volumes/rexy/GitHub/unfiltered/.env.local';
const apiKey = readFileSync(envFile, 'utf8').split('\n').map(line => /^\s*DIGITALOCEAN_MODEL_ACCESS_KEY\s*=\s*"?([^"\s]+)"?/.exec(line)?.[1]).find(Boolean);
if (!apiKey) throw new Error('DIGITALOCEAN_MODEL_ACCESS_KEY missing');

const register = createClinicContent({ mentalHealth: 'phq4' });
// Same topic set the server offers in first-intake adaptive mode: register topics (minus Q18) plus condition branches (COND excluded for PHQ-4).
const topics = [...register.topics.filter(topic => topic.id !== 'Q18'), ...Object.values(register.branches).map(branch => branch.topic).filter(topic => topic.id !== 'COND')];

interface Case { id: string; displayed: { topicId: string; promptId: string; targetPaths: string[]; specificity?: { key: string } }; question: string; text: string; prior?: Record<string, TopicResponse>; check(outcome: AdaptiveOutcome): string[]; }
const value = (outcome: AdaptiveOutcome, topicId: string, path: string) => { const answer = outcome.responses[topicId]?.answers[path]; return answer?.state === 'known' ? answer.value : answer?.state; };
const items = (outcome: AdaptiveOutcome, topicId: string, path: string) => { const answer = outcome.responses[topicId]?.answers[path]; return answer?.state === 'known' ? answer.items ?? [] : []; };
const changedTopics = (outcome: AdaptiveOutcome) => [...new Set(outcome.updates.map(update => update.topicId))];
const noPadding = (outcome: AdaptiveOutcome) => outcome.updates.filter(update => ['unknown', 'declined'].includes(update.answer.state)).map(update => `padded ${update.topicId}.${update.path}=${update.answer.state}`);

const cases: Case[] = [
  { id: 'goals', displayed: { topicId: 'Q01', promptId: 'Q01', targetPaths: ['reason', 'priority'] }, question: 'What would you most like help with, and what would meaningful progress look like for you?',
    text: 'Mostly I want to get my energy back. Progress would be walking my dog for 30 minutes without getting winded.',
    check: o => [...(value(o, 'Q01', 'reason') || value(o, 'Q01', 'priority') ? [] : ['no Q01 goal']), ...changedTopics(o).filter(t => t !== 'Q01').map(t => `unexpected topic ${t}`), ...noPadding(o)] },
  { id: 'height-weight', displayed: { topicId: 'Q04', promptId: 'Q04', targetPaths: ['height.value', 'height.unit'] }, question: 'What is your height, including the units?',
    text: "I'm 5 foot 6. Last time I weighed myself was in June and it said 182 pounds, but I've probably gained a bit since then, maybe 188 now.",
    check: o => { const h = value(o, 'Q04', 'height.value') as { feet: number; inches: number } | undefined; return [
      ...(h && typeof h === 'object' && h.feet === 5 && h.inches === 6 ? [] : [`height ${JSON.stringify(h)}`]),
      ...(value(o, 'Q04', 'lastMeasuredWeight.value') === 182 ? [] : [`weight ${value(o, 'Q04', 'lastMeasuredWeight.value')}`]),
      ...(value(o, 'Q04', 'lastMeasuredWeight.unit') === 'lb' ? [] : ['weight unit']),
      ...(String(value(o, 'Q04', 'lastMeasuredWeight.measuredWhen') ?? '').includes('June') ? [] : ['measuredWhen']),
      ...(value(o, 'Q04', 'currentWeightEstimate.value') === 188 ? [] : [`estimate ${value(o, 'Q04', 'currentWeightEstimate.value')}`]),
      ...noPadding(o)]; } },
  { id: 'two-meds', displayed: { topicId: 'Q08', promptId: 'Q08', targetPaths: ['medicines'] }, question: 'What medicines, vitamins, supplements, or weight-loss products do you currently use, if any? Share the names and how you take them as best you know.',
    text: 'I take metformin 500 mg. The bottle says twice a day with meals but I usually only take it at dinner. I also take a vitamin D supplement, 2000 IU, once a day.',
    check: o => { const meds = items(o, 'Q08', 'medicines'); const met = meds.find(i => /metformin/i.test(String((i.answers.name as { value?: unknown })?.value))); const vit = meds.find(i => /vitamin d/i.test(String((i.answers.name as { value?: unknown })?.value)));
      return [...(meds.length === 2 ? [] : [`${meds.length} medicines`]), ...(met ? [] : ['no metformin']), ...(vit ? [] : ['no vitamin D']),
        ...(met && /500/.test(String((met.answers.strength as { value?: unknown })?.value)) ? [] : ['metformin strength']),
        ...(met && /twice/i.test(String((met.answers.labelDirections as { value?: unknown })?.value)) ? [] : ['metformin label']),
        ...(met && /dinner/i.test(String((met.answers.actualUse as { value?: unknown })?.value)) && !/twice/i.test(String((met.answers.actualUse as { value?: unknown })?.value)) ? [] : ['metformin actual use']),
        ...(vit && /2000/.test(String((vit.answers.strength as { value?: unknown })?.value)) ? [] : ['vitamin D strength']), ...noPadding(o)]; } },
  { id: 'mother-diabetes', displayed: { topicId: 'Q06', promptId: 'Q06', targetPaths: ['reportedConditions'] }, question: "What health conditions have you been told you have? I'll also check a few common conditions so we don't miss something that could matter to your care.",
    text: 'My mother has diabetes. I was told I might have prediabetes, but no diagnosis yet. Can you tell whether I have diabetes?',
    check: o => { const family = items(o, 'Q10', 'familyHistory'); const d = o.responses.Q06?.answers['conditions.diabetes'];
      return [...(family.some(i => /mother/i.test(String((i.answers.relationship as { value?: unknown })?.value)) && /diabetes/i.test(String((i.answers.condition as { value?: unknown })?.value))) ? [] : ['no mother/diabetes family item']),
        ...(d && ['known', 'negative'].includes(d.state) ? [`patient diabetes ${d.state}`] : []),
        ...(['uncertain', undefined].includes(o.responses.Q06?.answers['conditions.prediabetes']?.state) ? [] : [`prediabetes ${o.responses.Q06?.answers['conditions.prediabetes']?.state}`]),
        ...(o.acts.some(a => a.kind === 'question') ? [] : ['question lost']), ...noPadding(o)]; } },
  { id: 'dm-type', displayed: { topicId: 'DM', promptId: 'DM01', targetPaths: ['typeStatus', 'when'] }, question: 'What type were you told you have, and roughly when were you told?',
    prior: { Q06: { presented: true, answers: { 'conditions.diabetes': { state: 'known', value: true, sourceIds: ['prior'] } } }, DM: { presented: true, answers: {}, applicability: 'applicable', applicabilitySourceIds: ['prior'] } },
    text: 'My clinician diagnosed me with diabetes. I would like help with meals.',
    check: o => [...noPadding(o), ...o.updates.filter(u => u.answer.state === 'negative').map(u => `negative ${u.topicId}.${u.path}`), ...(o.updates.some(u => /meal/i.test(JSON.stringify(u.answer))) ? [] : ['meal help not captured'])] },
  { id: 'q02-dated', displayed: { topicId: 'Q02', promptId: 'Q02', targetPaths: ['concern'] }, question: 'Are there any specific symptoms or health concerns you want your care team to know about now?',
    text: "Since March 3 I've felt nauseous after meals. I have an appointment with my GP on the 20th. I don't need help with transport.",
    check: o => [...(/nause/i.test(String(value(o, 'Q02', 'concern'))) ? [] : ['concern']), ...(/march 3/i.test(String(value(o, 'Q02', 'onset'))) ? [] : [`onset ${value(o, 'Q02', 'onset')}`]),
      ...noPadding(o), ...changedTopics(o).filter(t => !['Q02', 'Q20', 'Q19'].includes(t)).map(t => `unexpected topic ${t}`)] },
  { id: 'diet-recall', displayed: { topicId: 'Q11', promptId: 'Q11', targetPaths: ['day', 'occasions'] }, question: "Let's walk through yesterday's eating and drinking, from when you woke up until you went to sleep. What did you first eat or drink, and about when?",
    text: 'Yesterday I had coffee when I woke up around 7, then a turkey sandwich and an apple for lunch at noon.',
    check: o => { const occ = items(o, 'Q11', 'occasions'); const coffee = occ.find(i => /coffee/i.test(String((i.answers.drinks as { value?: unknown })?.value)));
      return [...(occ.length >= 2 ? [] : [`${occ.length} occasions`]), ...(coffee ? [] : ['no coffee']), ...(coffee && coffee.answers.drinkAmounts?.state === 'known' ? [`invented coffee amount ${JSON.stringify((coffee.answers.drinkAmounts as { value?: unknown }).value)}`] : []), ...noPadding(o)]; } },
  { id: 'move-on', displayed: { topicId: 'Q16', promptId: 'Q16', targetPaths: ['stress'] }, question: 'What has been stressful for you lately, if anything?',
    text: "I'd rather not talk about that.",
    check: o => [...(o.responses.Q16?.stopped ? [] : ['not stopped']), ...o.updates.filter(u => u.answer.state !== 'declined').map(u => `update ${u.topicId}.${u.path}`)] },
  // HOLDOUT (written 2026-10-11 after prompt tuning; never used to change the prompt). Run with: -- qwen3.8-max holdout-sister-sleep,holdout-weight-undated,holdout-diet-resist
  { id: 'holdout-sister-sleep', displayed: { topicId: 'Q06', promptId: 'Q06', targetPaths: ['reportedConditions'] }, question: "What health conditions have you been told you have? I'll also check a few common conditions so we don't miss something that could matter to your care.",
    text: "My sister has sleep apnea. I snore a lot but I've never been tested. I do have high blood pressure.",
    check: o => { const family = items(o, 'Q10', 'familyHistory'); const sleep = o.responses.Q06?.answers['conditions.sleepApnea']?.state;
      return [...(family.some(i => /sister/i.test(String((i.answers.relationship as { value?: unknown })?.value)) && /apnea/i.test(String((i.answers.condition as { value?: unknown })?.value))) ? [] : ['no sister/sleep apnea family item']),
        ...(sleep === 'known' || sleep === 'negative' ? [`patient sleepApnea ${sleep}`] : []),
        ...(value(o, 'Q06', 'conditions.bloodPressure') === true ? [] : [`bloodPressure ${value(o, 'Q06', 'conditions.bloodPressure')}`]), ...noPadding(o)]; } },
  { id: 'holdout-weight-undated', displayed: { topicId: 'Q04', promptId: 'Q04', targetPaths: ['height.value', 'height.unit'] }, question: 'What is your height, including the units?',
    text: "170 cm. I think I'm around 95 kg but I honestly can't remember the last time I stepped on a scale.",
    check: o => { const est = value(o, 'Q04', 'currentWeightEstimate.value'), last = value(o, 'Q04', 'lastMeasuredWeight.value'), when = o.responses.Q04?.answers['lastMeasuredWeight.measuredWhen'];
      return [...(String(value(o, 'Q04', 'height.value') ?? '').includes('170') ? [] : [`height ${JSON.stringify(value(o, 'Q04', 'height.value'))}`]),
        ...(est === 95 ? [] : [`estimate ${est}`]), ...(last === 95 ? ['estimate recorded as measured'] : []),
        ...(when?.state === 'known' ? [`invented measuredWhen ${JSON.stringify(when)}`] : [])]; } },
  { id: 'holdout-diet-resist', displayed: { topicId: 'Q11', promptId: 'Q11', targetPaths: ['day', 'occasions'] }, question: "Let's walk through yesterday's eating and drinking, from when you woke up until you went to bed. What did you have first?",
    text: "Honestly I'd rather not list everything, it's kind of embarrassing. I usually skip breakfast and graze in the evening.",
    check: o => { const occ = items(o, 'Q11', 'occasions'); const foods = occ.map(i => String((i.answers.foods as { value?: unknown })?.value ?? '')).join(' ');
      return [...(/sandwich|salad|chips|pizza|cereal|eggs/i.test(foods) ? [`invented foods ${foods}`] : []), ...o.updates.filter(u => u.topicId !== 'Q11').map(u => `unexpected ${u.topicId}.${u.path}`),
        ...(o.updates.some(u => u.answer.state === 'negative') ? ['resistance recorded as negative'] : [])]; } },
  // Answer specificity (SP-0.1): descriptions stay verbatim as names, purposes never become conditions, follow-up replies attach to the same item.
  { id: 'spec-heart-pills', displayed: { topicId: 'Q08', promptId: 'Q08', targetPaths: ['medicines'] }, question: 'What medicines, vitamins, supplements, or weight-loss products do you currently use, if any? Share the names and how you take them as best you know.',
    text: 'I take a couple of pills for my heart in the morning, and something for my sugar at night.',
    check: o => { const names = items(o, 'Q08', 'medicines').map(i => String((i.answers.name as { value?: unknown })?.value ?? ''));
      return [...(names.length === 2 ? [] : [`${names.length} medicines ${JSON.stringify(names)}`]), ...(names.some(n => /heart/i.test(n)) ? [] : ['heart description lost']), ...(names.some(n => /sugar/i.test(n)) ? [] : ['sugar description lost']),
        ...(['heartDisease', 'diabetes', 'prediabetes'].filter(c => o.responses.Q06?.answers[`conditions.${c}`]).map(c => `condition from purpose ${c}`)), ...noPadding(o)]; } },
  { id: 'spec-name-reply', displayed: { topicId: 'Q08', promptId: 'B02', targetPaths: ['medicines[m1].name'], specificity: { key: 'Q08:medicines[m1].name' } }, question: "You mentioned “pills for my heart”. Do you know the name of that medicine? It's printed on the label. It's fine to say you don't know, or that you'll bring it to your visit.",
    prior: { Q08: { presented: true, answers: { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'm1', answers: { name: { state: 'known', value: 'pills for my heart', sourceIds: ['prior'] } } }] } } } },
    text: "Oh, it's metoprolol, 25 mg.",
    check: o => { const meds = items(o, 'Q08', 'medicines'); const m1 = meds.find(i => i.id === 'm1');
      return [...(meds.length === 1 ? [] : [`${meds.length} medicines (expected the same item)`]), ...(m1 && /metoprolol/i.test(String((m1.answers.name as { value?: unknown })?.value)) ? [] : ['name not on m1']), ...(m1 && /25/.test(String((m1.answers.strength as { value?: unknown })?.value)) ? [] : ['strength']), ...o.clarifications.map(c => `clarification ${c.path}:${c.reason}`), ...noPadding(o)]; } },
  { id: 'spec-bring-reply', displayed: { topicId: 'Q08', promptId: 'B02', targetPaths: ['medicines[m1].name'], specificity: { key: 'Q08:medicines[m1].name' } }, question: "You mentioned “pills for my heart”. Do you know the name of that medicine? It's printed on the label. It's fine to say you don't know, or that you'll bring it to your visit.",
    prior: { Q08: { presented: true, answers: { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'm1', answers: { name: { state: 'known', value: 'pills for my heart', sourceIds: ['prior'] } } }] } } } },
    text: "I'm not sure, I'll bring the bottle next time.",
    check: o => { const meds = items(o, 'Q08', 'medicines'); const name = meds.find(i => i.id === 'm1')?.answers.name;
      return [...(meds.length === 1 ? [] : [`${meds.length} medicines`]), ...(name?.state === 'known' && /heart/.test(String(name.value)) ? [] : [`name became ${JSON.stringify(name)}`]), ...o.clarifications.map(c => `clarification ${c.path}:${c.reason}`), ...(o.hasUnresolvedInterpretation ? ['marked unresolved'] : [])]; } },
  { id: 'spec-family-vague', displayed: { topicId: 'Q10', promptId: 'Q10', targetPaths: ['familyHistory'] }, question: 'Has anyone in your close family had health conditions you know about?',
    text: "Heart stuff runs on my dad's side.",
    check: o => { const fam = items(o, 'Q10', 'familyHistory');
      return [...(fam.length === 1 ? [] : [`${fam.length} family items`]), ...(fam.some(i => /heart/i.test(String((i.answers.condition as { value?: unknown })?.value))) ? [] : ['condition lost']),
        ...(o.responses.Q06?.answers['conditions.heartDisease'] ? ['recorded as own condition'] : []), ...noPadding(o)]; } },
];

const args = process.argv.slice(2).filter(arg => arg !== '--');
const models = (args[0] ?? 'glm-5.3,qwen3.8-max').split(',') as (typeof DO_MODELS[number])[];
const only = args[1]?.split(',');
for (const model of models) if (!DO_MODELS.includes(model)) throw new Error(`unsupported model ${model}`);
const summary: string[] = [];
for (const model of models) {
  let passed = 0, total = 0, latency = 0;
  for (const testCase of cases.filter(entry => only ? only.includes(entry.id) : !entry.id.startsWith('holdout-') && !entry.id.startsWith('spec-'))) {
    const at = '2026-10-10T12:00:00.000Z';
    const current = { id: 'eval-turn', role: 'patient' as const, text: testCase.text, at };
    const sources = [...(testCase.prior ? [{ id: 'prior', role: 'patient' as const, text: 'Earlier answer.', at: '2026-10-10T11:50:00.000Z' }] : []), current];
    const context: AdaptiveContext = { binding: { operationId: 'eval', sessionId: 'eval', patient: 'eval', scenario: 'first-intake', revision: 1, contentVersion: 'eval', snapshotDigest: 'eval' }, source: current, sources, topics, responses: testCase.prior ?? {}, displayed: testCase.displayed, displayedText: testCase.question, ...(testCase.id.startsWith('spec-') ? { specificity: {} } : {}) };
    const messages = buildIntakeInterpreterMessages(context);
    const started = Date.now();
    let line: string;
    total++;
    try {
      const result = await digitalOcean({ endpoint: DO_ENDPOINT, apiKey, model, timeoutMs: 45000, maxOutputTokens: 1500, responseFormat: 'json', maxRequestBytes: 60000 }).generate(messages);
      const ms = Date.now() - started; latency += ms;
      const raw = parseIntakeInterpreterText(result.text);
      const outcome = interpretIntakeResponse(raw, context);
      const failures = testCase.check(outcome);
      if (!failures.length) passed++;
      const next = selectAdaptiveDialogue(context, outcome);
      line = [`[${model}] ${testCase.id}: ${failures.length ? 'FAIL ' + failures.join('; ') : 'PASS'}  (${ms} ms, ${intakeRequestBytes(messages)} B in, ${result.usage?.completion_tokens ?? '?'} tok out)`,
        `  raw: ${JSON.stringify(raw).slice(0, 900)}`,
        `  accepted: ${outcome.updates.map(u => `${u.topicId}.${u.path}=${u.answer.state === 'known' ? JSON.stringify(u.answer.items ? `${u.answer.items.length} items` : u.answer.value) : u.answer.state}`).join(' | ') || '-'}`,
        `  clarifications: ${outcome.clarifications.map(c => `${c.topicId}.${c.path}:${c.reason}`).join(' | ') || '-'}`,
        `  rejected: ${(outcome.rejectedCandidates ?? []).map(r => `${r.topicId ?? r.kind}.${r.path ?? ''}:${r.reason}`).join(' | ') || '-'}`,
        `  acts: ${outcome.acts.map(a => `${a.kind}${a.replyId ? `(${a.replyId})` : ''}`).join(', ') || '-'}  ack: ${outcome.acknowledgement ?? '-'}  unresolved: ${outcome.hasUnresolvedInterpretation}`,
        `  next: ${next.reply ? `[${next.reply.id}] ` : ''}${next.prompt?.text ?? next.status}`].join('\n');
    } catch (error) {
      const ms = Date.now() - started; latency += ms;
      line = `[${model}] ${testCase.id}: FAIL error ${(error as Error).message}${(error as { status?: number }).status ? ` ${(error as { status?: number }).status}` : ''} (${ms} ms)`;
    }
    console.log(line + '\n');
  }
  summary.push(`${model}: ${passed}/${total} pass, mean ${Math.round(latency / Math.max(1, total))} ms`);
}
console.log(summary.join('\n'));
