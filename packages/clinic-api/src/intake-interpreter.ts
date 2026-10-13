import { z } from 'zod';
import { addCollectionItem, applyGuidedAnswer, finishCollection, type EvidenceContext, type Scalar, type SlotAnswer, type SlotDefinition, type TopicDefinition, type TopicResponse } from '../../clinic-content/src/index.js';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { digitalOcean, type DigitalOceanConfig, type InferenceMessage } from '../../clinical-core/src/digitalocean.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import { AdaptiveProposalFailure, type AdaptiveProposalReceipt } from './adaptive.js';
import { activateAdaptiveBranch, AdaptiveError, adaptiveSlot, conditionalReady, parseExplicitHeight, type AdaptiveClarification, type AdaptiveContext, type AdaptiveOutcome, type AdaptiveRejectedCandidate, type EvidenceSpan, type ValidatedAct } from './adaptive-validation.js';
import { escalation } from './safety.js';
import { scanReference } from '../../clinic-reference/src/index.js';
import { specificityTerminal } from '../../clinic-content/src/specificity.js';

/**
 * Simple single-call intake interpreter (protocol intake-interpreter-v1).
 *
 * One DigitalOcean chat call per patient turn with a small readable contract. The model proposes
 * facts with a value and an exact quote; the SERVER validates every fact independently and writes
 * accepted facts into the existing guided answer model. A malformed or unfaithful fact is rejected
 * on its own; only a non-JSON / non-object response fails the turn. Dialogue (next question),
 * review, PHQ-4 and handoff stay with the existing authored-content code paths.
 */
export const intakeInterpreterProtocol = 'intake-interpreter-v1' as const;
export const intakeInterpreterTransform = 'interpreted-v1';
const maxRequestBytes = 60000;

export interface IntakeInterpretation { outcome: AdaptiveOutcome; receipt?: AdaptiveProposalReceipt; rawProposal?: unknown; }
/** Inject for offline tests. Runtime instances call DigitalOcean once per interpret(). */
export interface IntakeInterpreter { interpret(context: AdaptiveContext, signal?: AbortSignal): Promise<IntakeInterpretation>; }

// ---------------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------------

const rules = `You turn ONE patient message from a clinic intake chat into structured facts. A server checks every fact against the patient's exact words, so be literal and brief.

RULES
1. Extract ONLY what the patient says in the final user message. The assistant message is the question they were answering. Answers already given are listed under KNOWN ANSWERS; do not repeat them unless the patient changes them.
2. Most messages touch 1-3 fields. If the patient did not mention a field, OMIT it. Never output unknown, negative or declined for something the patient did not talk about.
3. state:
   known = the patient states it.
   negative = the patient explicitly says no / none / never for that field.
   uncertain = the patient is unsure or it is unconfirmed ("might", "maybe", "possibly", "borderline", "told I might have", "no diagnosis yet").
   unknown = the patient explicitly says they don't know / can't remember that detail.
   declined = the patient explicitly says they don't want to answer it.
   "No diagnosis yet" or "might have" is uncertain, never negative. Prediabetes is not diabetes.
4. quote = an exact, contiguous copy of the patient's own words that supports the fact (same spelling and punctuation, usually 2-15 words). Never quote the question. Never invent or reword a quote.
5. value = the patient's information, short, in their words and units. Keep dates and amounts as said ("last March", "about 2 cups"). Do not convert units, do not translate into medical terms, do not add details. Number fields get just the number; the unit goes in the separate unit field.
6. A relative's condition (mother, father, sister, brother, grandparent, aunt, uncle, child...) goes ONLY into a Q10 familyHistory item with condition and relationship. Never record it as the patient's own condition.
7. Lists (medicines, conditions, family history, meals, ...) use "items", one item per thing. To add or change details of an item already in KNOWN ANSWERS, set "existing" to its id (the text inside [ ]). Use listsDone only when the patient says the list is finished ("that's all", "nothing else").
8. Medicines: labelDirections = what the label says; actualUse = how the patient really takes it. Keep them separate. Strength includes units ("500 mg").
9. Goals (Q01): what they want help with goes in reason ("more energy", "stop snacking at night"); priority is only what progress or success would look like for them.
   Weight: a remembered scale reading is lastMeasuredWeight; a guess about their weight now is currentWeightEstimate.
10. Corrections: if the patient changes something in KNOWN ANSWERS, output the new value with "corrects" set to that answer's number. If they correct themselves inside this message ("500 mg, no wait, 850 mg"), output only the final value.
11. A question the patient asks goes in "questions" with its exact quote. Do not answer it.
12. moveOn: only when the patient asks to skip / move on / not talk about the current question. Still extract every other fact in the same message.
13. Never diagnose or give advice. Never fill MH01-MH04 or any field not in the FIELD CATALOG.
14. ack (optional): one short neutral sentence saying what you noted (max 20 words). No advice, no opinion, no question.
15. Patients often volunteer things beyond the current question. Record each one in whichever catalog field fits best (any topic), e.g. a concern or kind of help they want goes in the matching concern/request field.
16. A medicine the patient describes without naming it ("some pills for my heart", "my water pill", "the shot") is still a medicine item: put their description in name, verbatim. Never record a condition only because of what a medicine is for ("pills for my heart" is not heart disease).
17. REFERENCE (when present) lists words in this message that match a medicine or condition name list. Use it only to tell medicine names from condition names. Never add a name the patient did not say, never correct their spelling, and never use it to choose a diagnosis.

OUTPUT exactly one JSON object, no markdown:
{"facts":[{"topic":"Q04","field":"height.value","state":"known","value":"5 ft 8 in","quote":"I'm 5'8\\"","corrects":null}],
 "items":[{"topic":"Q08","list":"medicines","existing":null,"fields":[{"field":"name","state":"known","value":"Metformin","quote":"Metformin 850 mg"},{"field":"strength","state":"known","value":"850 mg","quote":"850 mg"}]}],
 "listsDone":[{"topic":"Q08","list":"medicines","quote":"that's all I take"}],
 "questions":[{"quote":"Can I take it at night?"}],
 "moveOn":null,
 "ack":"Thanks, I've noted metformin 850 mg."}
Use [] for empty lists and null for moveOn when not needed.

EXAMPLES (invented people, not the current patient; never copy their content)
Q: "What is your height, including the units?"
P: "6 foot 1. Scale said 210 lb last month, probably a bit more now, maybe 215."
{"facts":[{"topic":"Q04","field":"height.value","state":"known","value":"6 ft 1 in","quote":"6 foot 1"},{"topic":"Q04","field":"lastMeasuredWeight.value","state":"known","value":210,"quote":"Scale said 210 lb"},{"topic":"Q04","field":"lastMeasuredWeight.unit","state":"known","value":"lb","quote":"210 lb"},{"topic":"Q04","field":"lastMeasuredWeight.measuredWhen","state":"known","value":"last month","quote":"last month"},{"topic":"Q04","field":"currentWeightEstimate.value","state":"known","value":215,"quote":"maybe 215"}],"items":[],"listsDone":[],"questions":[],"moveOn":null,"ack":"Noted 6 ft 1 in and a reading of 210 lb last month."}

Q: "What health conditions have you been told you have?"
P: "My dad had a stroke. I might have high cholesterol, nobody confirmed it. Should I be on a statin?"
{"facts":[{"topic":"Q06","field":"conditions.cholesterol","state":"uncertain","value":null,"quote":"I might have high cholesterol, nobody confirmed it"}],"items":[{"topic":"Q10","list":"familyHistory","existing":null,"fields":[{"field":"relationship","state":"known","value":"dad","quote":"My dad had a stroke"},{"field":"condition","state":"known","value":"stroke","quote":"had a stroke"}]}],"listsDone":[],"questions":[{"quote":"Should I be on a statin?"}],"moveOn":null,"ack":"Noted your dad's stroke and the possible high cholesterol."}

Q: "What medicines do you currently use?"
P: "Lisinopril 10 mg - the label says once daily but I take it every other day. Also fish oil. That's all."
{"facts":[],"items":[{"topic":"Q08","list":"medicines","existing":null,"fields":[{"field":"name","state":"known","value":"Lisinopril","quote":"Lisinopril 10 mg"},{"field":"strength","state":"known","value":"10 mg","quote":"10 mg"},{"field":"labelDirections","state":"known","value":"once daily","quote":"the label says once daily"},{"field":"actualUse","state":"known","value":"every other day","quote":"I take it every other day"}]},{"topic":"Q08","list":"medicines","existing":null,"fields":[{"field":"name","state":"known","value":"fish oil","quote":"Also fish oil"}]}],"listsDone":[{"topic":"Q08","list":"medicines","quote":"That's all."}],"questions":[],"moveOn":null,"ack":"Noted lisinopril 10 mg and fish oil."}

KNOWN ANSWERS: #2 Q08 medicines[x7].strength = "20 mg"
P: "Sorry, the atorvastatin is actually 40 mg, not 20."
{"facts":[{"topic":"Q08","field":"medicines[x7].strength","state":"known","value":"40 mg","quote":"actually 40 mg","corrects":2}],"items":[],"listsDone":[],"questions":[],"moveOn":null,"ack":"Updated atorvastatin to 40 mg."}

Q: "About when was your weight measured?"
P: "No idea, honestly."
{"facts":[{"topic":"Q04","field":"lastMeasuredWeight.measuredWhen","state":"unknown","value":null,"quote":"No idea"}],"items":[],"listsDone":[],"questions":[],"moveOn":null,"ack":null}

Q: "Do you use any substances you'd like to tell us about?"
P: "I'd rather skip this one."
{"facts":[],"items":[],"listsDone":[],"questions":[],"moveOn":{"quote":"I'd rather skip this one"},"ack":null}`;

const excludedSlot = (definition: SlotDefinition) => /^MH0[1-4]$/.test(definition.id) || definition.kind === 'configuration' || definition.id === 'currentWeightEstimate.statedAt';
const branchNotes: Record<string, string> = {
  DM: 'only when the patient has diabetes or prediabetes',
  SLEEP: 'only when the patient has sleep apnea',
  GI: 'only when the patient has a digestive condition',
  COND: 'only for another reported condition',
};

function fieldHint(definition: SlotDefinition): string {
  const none = definition.acceptsNegative ? '; negative allowed' : '';
  const when = definition.when ? `; only if ${definition.when.slotId} applies` : '';
  switch (definition.kind) {
    case 'text': return `text${none}${when}`;
    case 'positive-number': return `number only${when}`;
    case 'height-value': return `height as said, e.g. "5 ft 8 in" or "173"${when}`;
    case 'choice': return `one of ${(definition.choices ?? []).map(String).join(', ')}${when}`;
    case 'presence': return `known=patient has it, negative=explicitly not, uncertain=might/unconfirmed${when}`;
    default: return `${definition.kind}${when}`;
  }
}

function formatAnswer(answer: SlotAnswer): string {
  if (answer.state !== 'known') return answer.state;
  if (answer.items) return `${answer.items.length} item(s)${answer.complete ? ', list finished' : ''}`;
  const value = answer.value as Scalar;
  if (typeof value === 'object') return `"${value.feet} ft ${value.inches} in"`;
  return JSON.stringify(value);
}

export interface KnownAnswerLine { number: number; topicId: string; path: string; answer: SlotAnswer; }
/** Deterministic numbering shared by the prompt and the validator. */
export function intakeKnownAnswers(context: AdaptiveContext): { lines: KnownAnswerLine[]; items: { topicId: string; path: string; id: string }[] } {
  const lines: KnownAnswerLine[] = [], items: { topicId: string; path: string; id: string }[] = [];
  for (const topic of context.topics) {
    const response = context.responses[topic.id];
    if (!response) continue;
    const visit = (definitions: readonly SlotDefinition[], answers: TopicResponse['answers'], prefix: string) => {
      for (const definition of definitions) {
        const answer = answers[definition.id];
        if (!answer || answer.state === 'not-asked' || excludedSlot(definition)) continue;
        if (definition.kind === 'collection' && answer.state === 'known' && answer.items) {
          for (const item of answer.items) {
            items.push({ topicId: topic.id, path: `${prefix}${definition.id}`, id: item.id });
            visit(definition.fields ?? [], item.answers, `${prefix}${definition.id}[${item.id}].`);
          }
          if (!answer.complete) continue;
        }
        lines.push({ number: lines.length + 1, topicId: topic.id, path: `${prefix}${definition.id}`, answer });
      }
    };
    visit(topic.slots, response.answers, '');
  }
  return { lines, items };
}

function catalogText(context: AdaptiveContext): string {
  const out: string[] = ['FIELD CATALOG (topic | field | meaning | value)'];
  for (const topic of context.topics) {
    const response = context.responses[topic.id];
    if (response?.stopped) continue;
    if (topic.presentation === 'C' && branchNotes[topic.id]) out.push(`# ${topic.id}: ${branchNotes[topic.id]}`);
    for (const definition of topic.slots) {
      if (excludedSlot(definition)) continue;
      if (definition.kind === 'collection') {
        const fields = (definition.fields ?? []).filter(field => !excludedSlot(field)).map(field => `${field.id} (${field.label}${field.acceptsNegative ? '; none allowed' : ''})`).join(', ');
        out.push(`${topic.id} | ${definition.id}[] | ${definition.label} | item fields: ${fields}`);
      } else out.push(`${topic.id} | ${definition.id} | ${definition.label} | ${fieldHint(definition)}`);
    }
  }
  const displayed = context.displayed;
  if (displayed) out.push('', `CURRENT QUESTION is about ${displayed.topicId}${displayed.targetPaths.length ? `: ${displayed.targetPaths.join(', ')}` : ''}`);
  const known = intakeKnownAnswers(context);
  out.push('', 'KNOWN ANSWERS (numbered)');
  if (!known.lines.length && !known.items.length) out.push('none yet');
  for (const line of known.lines) out.push(`#${line.number} ${line.topicId} ${line.path} = ${formatAnswer(line.answer)}`);
  for (const item of known.items) if (!known.lines.some(line => line.topicId === item.topicId && line.path.startsWith(`${item.path}[${item.id}].`))) out.push(`${item.topicId} ${item.path}[${item.id}] (item with no details yet)`);
  const stopped = context.topics.filter(topic => context.responses[topic.id]?.stopped).map(topic => topic.id);
  if (stopped.length) out.push(`Topics the patient stopped (do not extract): ${stopped.join(', ')}`);
  // Retrieve-then-interpret (D5): offline exact name matches in this message only; no patient text leaves the server.
  const reference = scanReference(context.source.text);
  if (reference.length) out.push('', 'REFERENCE (exact name matches in this message)', ...reference.map(entry => `"${entry.mention}" = ${entry.domain} name${entry.display.toLowerCase() !== entry.mention ? ` (${entry.display})` : ''}`));
  return out.join('\n');
}

/** Exact request messages. Binding/patient/session identity never enters the prompt. */
export function buildIntakeInterpreterMessages(context: AdaptiveContext): InferenceMessage[] {
  if (context.safetyPaused || escalation(context.source.text)) throw new AdaptiveError('safety-interruption');
  if (context.source.role !== 'patient' || !context.source.text.trim() || context.source.text.length > 8000) throw new AdaptiveError('invalid-adaptive-source');
  if (context.displayed && /^MH0[1-4]$/.test(context.displayed.promptId)) throw new AdaptiveError('instrument-guided-required');
  // One system message: some DigitalOcean models (qwen3.8-max) reject a second system message.
  const messages: InferenceMessage[] = [{ role: 'system', content: `${rules}\n\n${catalogText(context)}` }];
  const question = context.displayedText?.trim();
  if (question) messages.push({ role: 'assistant', content: question.slice(0, 4000) });
  messages.push({ role: 'user', content: context.source.text });
  if (messages.some(message => typeof message.content === 'string' && message.content.length > 32000) || intakeRequestBytes(messages) > maxRequestBytes - 2000) throw new AdaptiveError('adaptive-context-too-large');
  return messages;
}
export function intakeRequestBytes(messages: readonly InferenceMessage[]) {
  return messages.reduce((sum, message) => sum + new TextEncoder().encode(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).byteLength, 0);
}

// ---------------------------------------------------------------------------------------------
// Wire parsing (lenient on extra keys, strict on used keys)
// ---------------------------------------------------------------------------------------------

const text = z.string().max(4000);
const state = z.enum(['known', 'negative', 'uncertain', 'unknown', 'declined']);
const corrects = z.union([z.number().int().positive(), z.string().regex(/^#?\d{1,4}$/).transform(value => Number(value.replace('#', ''))), z.null()]).optional();
const wireValue = z.union([z.string().max(4000), z.number(), z.boolean(), z.object({ feet: z.number(), inches: z.number() }).passthrough(), z.null()]).optional();
const factWire = z.object({ topic: z.string().min(1).max(40), field: z.string().min(1).max(300), state, value: wireValue, quote: text.nullable().optional(), corrects }).passthrough();
const itemFieldWire = z.object({ field: z.string().min(1).max(120), state, value: wireValue, quote: text.nullable().optional(), corrects }).passthrough();
const itemWire = z.object({ topic: z.string().min(1).max(40), list: z.string().min(1).max(120), existing: z.string().max(120).nullable().optional(), fields: z.array(z.unknown()).max(16) }).passthrough();
const listDoneWire = z.object({ topic: z.string().min(1).max(40), list: z.string().min(1).max(120), quote: text }).passthrough();
const quoteWire = z.object({ quote: text }).passthrough();

/** Accepts a fenced or prefixed JSON object, never a repaired one. */
export function parseIntakeInterpreterText(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AdaptiveError('invalid-interpreter-json');
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { throw new AdaptiveError('invalid-interpreter-json'); }
}

// ---------------------------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------------------------

function normalizeWithMap(input: string): { norm: string; map: number[] } {
  let norm = '', space = false; const map: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let ch = input[i];
    if (/[‘’ʼ`´]/.test(ch)) ch = "'";
    else if (/[“”″]/.test(ch)) ch = '"';
    else if (/[–—]/.test(ch)) ch = '-';
    if (/\s/.test(ch)) { if (space) continue; ch = ' '; space = true; } else space = false;
    const lower = ch.toLowerCase();
    norm += lower.length === 1 ? lower : ch; map.push(i);
  }
  return { norm, map };
}
const norm = (value: string) => normalizeWithMap(value).norm.trim();

function findPart(source: string, part: string, from: number): { start: number; end: number } | undefined {
  const exact = source.indexOf(part, from);
  if (exact >= 0) return { start: exact, end: exact + part.length };
  const { norm: haystack, map } = normalizeWithMap(source);
  const offset = map.findIndex(index => index >= from);
  if (offset < 0) return;
  const stripped = part.trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  for (const candidate of [part.trim(), stripped, stripped.replace(/[.!?,;:]+$/, '').trim()]) {
    const needle = normalizeWithMap(candidate).norm.trim();
    if (!needle) continue;
    const at = haystack.indexOf(needle, offset);
    if (at >= 0) return { start: map[at], end: map[at + needle.length - 1] + 1 };
  }
}
/** Exact first, then case/whitespace/quote-insensitive. An ellipsis may join up to four exact parts in order; unmarked short gaps up to three. */
export function locateQuote(context: AdaptiveContext, quote: unknown): EvidenceSpan[] | undefined {
  if (typeof quote !== 'string') return;
  const trimmed = quote.trim();
  if (!trimmed || trimmed.length > 2000) return;
  const whole = findPart(context.source.text, trimmed, 0);
  if (whole) return [{ sourceId: context.source.id, ...whole }];
  const parts = trimmed.split(/\s*(?:\.\.\.|…)\s*/).filter(part => /[\p{L}\p{N}]/u.test(part));
  if (parts.length < 2) return unmarkedGaps(context, trimmed);
  if (parts.length > 4) return;
  const spans: EvidenceSpan[] = []; let from = 0;
  for (const part of parts) {
    const found = findPart(context.source.text, part, from);
    if (!found) return;
    spans.push({ sourceId: context.source.id, ...found }); from = found.end;
  }
  return spans;
}

/** Models sometimes drop a few words without marking the gap: accept at most three in-order runs with short gaps. */
function unmarkedGaps(context: AdaptiveContext, quote: string): EvidenceSpan[] | undefined {
  const words = quote.split(/\s+/).filter(Boolean), spans: EvidenceSpan[] = [];
  let from = 0;
  for (let i = 0; i < words.length;) {
    let found: { start: number; end: number } | undefined, next = i;
    for (let j = words.length; j > i && !found; j--) { found = findPart(context.source.text, words.slice(i, j).join(' '), from); next = j; }
    if (!found || spans.length === 3) return;
    const previous = spans.at(-1);
    if (previous && (found.start - previous.end > 30 || /[.!?\n]/.test(context.source.text.slice(previous.end, found.start)))) return;
    spans.push({ sourceId: context.source.id, ...found }); from = found.end; i = next;
  }
  return spans.length > 1 ? spans : undefined;
}

interface Region { start: number; end: number; text: string; }
function regions(source: string, clauses = false): Region[] {
  const delimiter = clauses ? /[;,\n]|[.!?](?=\s|$)|\bbut\b/gi : /[\n]|[.!?](?=\s|$)/g;
  const result: Region[] = []; let start = 0;
  for (const match of source.matchAll(delimiter)) {
    const end = match.index! + match[0].length;
    result.push({ start, end, text: source.slice(start, end) }); start = end;
  }
  if (start < source.length) result.push({ start, end: source.length, text: source.slice(start) });
  return result;
}
function covering(source: string, spans: readonly EvidenceSpan[], clauses = false): string {
  const parts = regions(source, clauses).filter(region => spans.some(span => region.start < span.end && region.end > span.start));
  return parts.map(part => part.text).join(' ');
}

const unknownWords = /\b(?:(?:i )?(?:don't|do not|didn't|did not) (?:know|remember|recall)|not sure|unsure|(?:can't|cannot|couldn't) (?:remember|recall|say|tell)|no idea|no clue|unknown|forgot|forget|not certain|no recollection)\b/i;
const declinedWords = /\b(?:prefer not|rather not|(?:don't|do not) want to|not comfortable|skip|rather discuss|pass on|leave (?:it|that) out|not (?:willing|ready) to)\b/i;
const negativeWords = /\b(?:no|none|not|never|nothing|without|nope|neither|nor)\b|n't\b/i;
const uncertainWords = /\b(?:might|maybe|may (?:have|be)|possibly|possible|not sure|unsure|uncertain|think|thought|suspect(?:ed)?|borderline|yet|probably|perhaps|unconfirmed|not confirmed|could (?:be|have)|told i might)\b/i;
const approximateWords = /\b(?:around|about|approximately|approx|roughly|or so|give or take|somewhere (?:around|near))\b|~|\b\d+(?:\.\d+)?ish\b/i;
const relativeWords = /\b(?:mother|mom|mum|father|dad|parents?|sister|brother|siblings?|grandmother|grandfather|grandma|grandpa|grandparents?|aunt|uncle|cousin|son|daughter|children|kids?|family|husband|wife|partner)\b/i;
const thirdPerson = /\b(?:she|he|they)\b/i;
const firstPerson = /\b(?:i|i'm|i've|i'd|i was|me)\b/i;
const correctionCue = /\b(?:actually|correction|correct that|i meant|i mean|sorry|wrong|mistake|changed|now it's|now it is|update|not\b[^.!?;]{0,40}\bbut)\b/i;
/** A correction inside one message ("500 mg, no wait, 850 mg"). Bare "actually" counts only directly before the new value and not after "and/also". */
const inMessageCorrection = /\b(?:no,? wait|wait,? no|wait|i mean|i meant|sorry|correction|or rather|make (?:that|it)|scratch that|let me correct|no,? it'?s|not\b[^,.;]{1,30},? (?:but|it'?s))\b|\bno\s*,/i;
const correctingActually = /(?:^|[^\p{L}])actually[\s,]*$/iu, actuallyJoined = /\b(?:and|also|plus)\b[^,.;]*\bactually[\s,]*$/i;
const completionWords = /\b(?:that's all|that is all|that's it|that is it|that's everything|nothing else|no others?|only (?:those|these|that|this|one|two|three)|just (?:those|these|that|this|the one)|none other|all of them|no more|that's the lot)\b/i;
/** An acknowledgement may only restate the patient's own words: every number and substantive word must appear in the message. */
const ackFrame = new Set('noted note thanks thank you your yours i ive i\'ve have has and or but the a an of for to with that this these about around now it its is are was were in on at as we will can later come back okay ok got sure also both so far updated update recorded added skipping skip moving move goal goals height weight weights reading readings estimate medicine medicines medication medications symptom symptoms concern concerns family history condition conditions question questions care team diet meal meals food sleep mood details detail possible possibly no not any approach approaches lb lbs pound pounds kg kilograms cm ft foot feet in inch inches mg mcg iu ml units'.split(' '));
function ackGrounded(ack: string, source: string): boolean {
  const said = new Set(norm(source).toLowerCase().match(/[a-z0-9']+/g) ?? []);
  return (norm(ack).toLowerCase().match(/[a-z0-9']+/g) ?? []).every(word => ackFrame.has(word) || said.has(word) || said.has(word.replace(/'s$/, '')) || said.has(word.replace(/s$/, '')));
}
const pointerAnswer = /\b(?:(?:the )?(?:first|second|last|earlier|previous|original|other) (?:thing|one|answer|statement|version)|keep (?:it|that|the (?:first|second|earlier|original|last))|what i said (?:first|before|earlier))\b/i;
/** Restating an item ("WW" then "the WW program") must not create a duplicate; names match case-insensitively or by containment. */
function sameItemName(saved: string, proposed: string): boolean {
  const a = saved.toLowerCase(), b = proposed.toLowerCase();
  // Whole words only, so "mother" never matches "grandmother".
  const within = (outer: string, inner: string) => inner.length >= 2 && new RegExp(`(?:^|[^a-z0-9])${inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`).test(outer);
  return a === b || within(a, b) || within(b, a);
}
const avoidanceWords = /\b(?:rather not|prefer not|(?:don't|do not|dont) (?:want|wish|like) to|not comfortable|uncomfortable|not ready|too personal|private|off limits)\b/i;
const moveOnWords = /\b(?:skip|move on|next question|rather not|prefer not|(?:don't|do not) want to|not comfortable|pass)\b/i;
const ackForbidden = /\b(?:dose|dosing|diagnos\w*|prescri\w*|eligib\w*|should take|should stop|recommend\w*|stop taking|normal|healthy|risk|safe|unsafe|treat\w*|cure)\b|\?/i;
const vagueValue = /^(?:fine|normal|normally|okay|ok|good|unknown|not sure|no|none|n\/a|not applicable|null|undefined|yes|true|false|i don't know|i do not know)$/;
const conditionNames: Record<string, RegExp> = {
  diabetes: /\bdiabet(?:es|ic)\b/i, prediabetes: /\bpre[- ]?diabet(?:es|ic)\b/i, bloodPressure: /\b(?:high blood pressure|hypertension|blood pressure)\b/i,
  cholesterol: /\b(?:cholesterol|lipids?)\b/i, heartDisease: /\bheart\b/i, stroke: /\bstroke\b/i,
  sleepApnea: /\b(?:sleep )?apn[oe]+a\b/i, liver: /\bliver\b/i, kidney: /\bkidney\b/i, joint: /\b(?:arthritis|joint)\b/i,
  thyroidHormone: /\b(?:thyroid|hormone)\b/i, digestive: /\b(?:digestive|crohn'?s|colitis|ibs|reflux|celiac|coeliac|gerd)\b/i,
};
/** A medicine described by its purpose: "pills for my heart", "something for my blood pressure", "arthritis meds". */
const medicinePurpose = /\b(?:pills?|meds?|medicines?|medications?|tablets?|capsules?|drugs?|shots?|injections?|prescriptions?|inhalers?|something|stuff)\b[^.;,]{0,12}?\b(?:for|to help(?: with)?|to treat|to control|to lower)\b[^.;,]*|\b[\w']+(?: [\w']+)? (?:pills?|meds?|medicines?|medications?|tablets?|drugs?|shots?)\b/gi;
const smallNumbers: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11 };
const unitAliases: Record<string, string> = { pound: 'lb', pounds: 'lb', lb: 'lb', lbs: 'lb', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg', kg: 'kg', kgs: 'kg', stone: 'st', stones: 'st', st: 'st', centimetre: 'cm', centimetres: 'cm', centimeter: 'cm', centimeters: 'cm', cm: 'cm', metre: 'm', metres: 'm', meter: 'm', meters: 'm', m: 'm', inch: 'in', inches: 'in', in: 'in', foot: 'ft', feet: 'ft', ft: 'ft', 'ft-in': 'ft-in' };
const stopWords = new Set(['the', 'and', 'with', 'that', 'this', 'have', 'from', 'about', 'they', 'them', 'their', 'would', 'like', 'into', 'your', 'what', 'when', 'will', 'been', 'were', 'some', 'more', 'very', 'just', 'also', 'then', 'than', 'because', 'for', 'but', 'not', 'was', 'are', 'has', 'had', 'its', "it's", "i'm", 'patient', 'reports', 'reported', 'states', 'said', 'says', 'wants', 'want', 'currently', 'takes', 'take']);

function numberMentioned(value: number, quote: string): boolean {
  const digits = quote.replace(/(\d),(\d{3})/g, '$1$2');
  if (new RegExp(`(?:^|[^\\d.])${String(value).replace('.', '\\.')}(?![\\d])`).test(digits)) return true;
  if (Number.isInteger(value) && new RegExp(`(?:^|[^\\d.])${value}\\.0+(?!\\d)`).test(digits)) return true;
  const word = Object.entries(smallNumbers).find(([, number]) => number === value)?.[0];
  return !!word && new RegExp(`\\b${word}\\b`, 'i').test(quote);
}
function textSupported(value: string, source: string): boolean {
  const lowered = norm(source);
  const words = norm(value).match(/[\p{L}\p{N}']+/gu)?.filter(word => /\d/.test(word) || word.length >= 3 && !stopWords.has(word)) ?? [];
  if (!words.length) return true;
  const hits = words.filter(word => lowered.includes(word) || word.length >= 6 && lowered.includes(word.slice(0, word.length - 3))).length;
  return hits / words.length >= 0.6;
}
function parseHeightValue(raw: unknown): { value: Scalar; unit?: string } | undefined {
  if (raw && typeof raw === 'object' && 'feet' in raw && 'inches' in raw) {
    const { feet, inches } = raw as { feet: unknown; inches: unknown };
    if (typeof feet === 'number' && typeof inches === 'number' && Number.isSafeInteger(feet) && feet >= 0 && inches >= 0 && inches < 12 && feet * 12 + inches > 0) return { value: { feet, inches }, unit: 'ft-in' };
    return;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? { value: raw } : undefined;
  if (typeof raw !== 'string') return;
  const textValue = raw.trim().replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  const explicit = parseExplicitHeight(textValue);
  if (explicit) return { value: explicit, unit: 'ft-in' };
  const word = '(\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven)';
  const ftIn = new RegExp(`^${word}\\s*(?:feet|foot|ft\\.?|')\\s*(?:${word}(?:\\.\\d+)?\\s*(?:inches|inch|in\\.?|"|'')?)?$`, 'i').exec(textValue);
  if (ftIn) {
    const number = (value: string | undefined) => value === undefined ? 0 : smallNumbers[value.toLowerCase()] ?? Number(value);
    const feet = number(ftIn[1]), inches = number(ftIn[2]);
    if (Number.isSafeInteger(feet) && Number.isFinite(inches) && inches >= 0 && inches < 12 && feet * 12 + inches > 0) return { value: { feet, inches }, unit: 'ft-in' };
    return;
  }
  const scalar = /^(\d+(?:\.\d+)?)\s*([a-z]+)?\.?$/i.exec(textValue);
  if (!scalar) return;
  const unit = scalar[2] ? unitAliases[scalar[2].toLowerCase()] : undefined;
  if (scalar[2] && (!unit || !['cm', 'm', 'in'].includes(unit))) return;
  const value = Number(scalar[1]);
  return Number.isFinite(value) && value > 0 ? { value, ...(unit ? { unit } : {}) } : undefined;
}
function unitInQuote(unit: string, quote: string): boolean {
  const q = norm(quote);
  if (unit === 'ft-in') return /\d\s*'\s*\d|\b(?:feet|foot|ft)\b/.test(q);
  return Object.entries(unitAliases).some(([alias, target]) => target === unit && new RegExp(`(?:\\b|\\d)${alias}\\b`).test(q));
}
const replyFor = (question: string) => /\b(?:dose|dosage|double|skip|repeat|take more|take less|stop taking|how much should i take)\b/i.test(question) ? 'COPY-05'
  : /\b(?:diagnos\w*|whether i have|do i have|if i have|am i (?:diabetic|prediabetic))\b/i.test(question) ? 'COPY-02'
  : /\b(?:eligib\w*|prescri\w*|treatment|medication|medicine|statin|qualify)\b/i.test(question) ? 'COPY-04' : 'unsupported';

// ---------------------------------------------------------------------------------------------
// Validation and application
// ---------------------------------------------------------------------------------------------

interface Candidate {
  topicId: string; path: string; state: z.infer<typeof state>; value: unknown; quote: unknown; corrects?: number | null;
  /** Item-field candidates on a new item: the item id is server-generated. */
  item?: { list: string; field: string };
}
const sameAnswer = (a: SlotAnswer, b: SlotAnswer) => canonicalJson({ ...a, sourceIds: [], note: undefined }) === canonicalJson({ ...b, sourceIds: [], note: undefined });
const emptyResponse = (): TopicResponse => ({ presented: false, answers: {} });

/** Validate the model's object fact-by-fact and return a normal AdaptiveOutcome. */
export function interpretIntakeResponse(raw: unknown, context: AdaptiveContext): AdaptiveOutcome {
  if (context.source.role !== 'patient' || !context.source.text.trim() || !context.sources.some(source => source.id === context.source.id && source.text === context.source.text)) throw new AdaptiveError('invalid-adaptive-source');
  if (context.safetyPaused || escalation(context.source.text)) throw new AdaptiveError('safety-interruption');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AdaptiveError('invalid-interpreter-output');
  const wire = raw as Record<string, unknown>;
  const list = (value: unknown, limit: number) => Array.isArray(value) ? value.slice(0, limit) : [];
  const sourceText = context.source.text, sourceId = context.source.id;
  const responses = structuredClone(context.responses) as Record<string, TopicResponse | undefined>;
  const outcome: AdaptiveOutcome = { responses, updates: [], provenance: [], clarifications: [], acts: [], sourceId, hasUnresolvedInterpretation: false };
  const rejected: AdaptiveRejectedCandidate[] = [];
  const evidence: EvidenceContext = { validSourceIds: new Set(context.sources.filter(source => source.role === 'patient').map(source => source.id)) };
  const topic = (id: string) => context.topics.find(entry => entry.id === id);
  const response = (id: string) => responses[id] ?? emptyResponse();
  const known = intakeKnownAnswers(context);
  const reject = (entry: Omit<AdaptiveRejectedCandidate, 'protocol'>) => { rejected.push({ ...entry, protocol: intakeInterpreterProtocol }); };
  const quoteOf = (spans: readonly EvidenceSpan[]) => spans.map(span => sourceText.slice(span.start, span.end));
  /** Which of two same-field values the patient corrected within this message, judged by position and the words between. */
  function selfCorrection(earlierSpans: readonly EvidenceSpan[], laterSpans: readonly EvidenceSpan[]): 'later' | 'earlier' | undefined {
    const bounds = (list: readonly EvidenceSpan[]) => ({ start: Math.min(...list.map(span => span.start)), end: Math.max(...list.map(span => span.end)) });
    const a = bounds(earlierSpans), b = bounds(laterSpans);
    const cued = (from: number, to: number, quote: string) => {
      const gap = sourceText.slice(from, to);
      return inMessageCorrection.test(gap) || inMessageCorrection.test(quote.slice(0, 16)) || correctingActually.test(gap) && !actuallyJoined.test(gap) || /^\s*actually\b/i.test(quote);
    };
    if (b.start >= a.end && cued(a.end, b.start, sourceText.slice(b.start, b.end))) return 'later';
    if (a.start >= b.end && cued(b.end, a.start, sourceText.slice(a.start, a.end))) return 'earlier';
  }

  // --- move-on and questions first: they scope which topics can still change ---
  const stopTopics = new Set<string>();
  let moveOnSpans: EvidenceSpan[] | undefined;
  const moveOn = wire.moveOn && typeof wire.moveOn === 'object' ? quoteWire.safeParse(wire.moveOn) : undefined;
  if (moveOn?.success) {
    const spans = locateQuote(context, moveOn.data.quote);
    const target = context.displayed?.topicId;
    if (spans && target && moveOnWords.test(norm(quoteOf(spans).join(' ')))) {
      stopTopics.add(target); moveOnSpans = spans;
      outcome.acts.push({ kind: 'move-on', targetTopicId: target, evidence: spans });
    } else reject({ kind: 'move-on', reason: spans ? 'unsupported-move-on' : 'quote-not-found', quote: String(moveOn.data.quote).slice(0, 400), ...(spans ? { evidence: spans } : {}) });
  }
  for (const entry of list(wire.questions, 4)) {
    const parsed = quoteWire.safeParse(entry);
    const spans = parsed.success ? locateQuote(context, parsed.data.quote) : undefined;
    if (!spans) { reject({ kind: 'question', reason: parsed.success ? 'quote-not-found' : 'malformed', ...(parsed.success ? { quote: parsed.data.quote.slice(0, 400) } : {}) }); continue; }
    if (outcome.acts.filter(act => act.kind === 'question').length >= 4) continue;
    outcome.acts.push({ kind: 'question', replyId: replyFor(covering(sourceText, spans)), evidence: spans });
  }

  // --- collect fact candidates ---
  const facts: Candidate[] = [];
  for (const entry of list(wire.facts, 40)) {
    const parsed = factWire.safeParse(entry);
    if (!parsed.success) { reject({ kind: 'fact', reason: 'malformed' }); continue; }
    facts.push({ topicId: parsed.data.topic.trim().toUpperCase(), path: canonicalPath(parsed.data.topic.trim().toUpperCase(), parsed.data.field), state: parsed.data.state, value: parsed.data.value, quote: parsed.data.quote, corrects: parsed.data.corrects ?? null });
  }
  /** Tolerate case/spacing/separator slips in a field name, never a different field. */
  function canonicalPath(topicId: string, field: string): string {
    const t = topic(topicId), trimmed = field.trim();
    if (!t) return trimmed;
    try { adaptiveSlot(t, response(t.id), trimmed); return trimmed; } catch { /* try a tolerant match */ }
    const squash = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');
    const scalar = t.slots.find(slot => slot.kind !== 'collection' && squash(slot.id) === squash(trimmed));
    return scalar?.id ?? trimmed;
  }
  const order = (candidate: Candidate) => {
    const t = topic(candidate.topicId);
    let conditional = 0;
    try { conditional = t && adaptiveSlot(t, response(t.id), candidate.path).definition.when ? 3 : 0; } catch { /* rejected later */ }
    return (t?.presentation === 'C' ? 10 : 0) + conditional + (candidate.path.endsWith('.unit') ? 1 : 0);
  };
  facts.sort((a, b) => order(a) - order(b));
  const implied: { topicId: string; unitPath: string; unit: string; spans: EvidenceSpan[]; quote: string[]; corrected: boolean; height: boolean }[] = [];

  /** Lexical sanity on the quoted patient words. Returns a rejection reason, or undefined. */
  function lexicalProblem(candidate: Candidate, definition: SlotDefinition, spans: EvidenceSpan[]): string | undefined {
    const quote = norm(quoteOf(spans).join(' '));
    const clause = norm(covering(sourceText, spans, true));
    const sentence = covering(sourceText, spans);
    const leaf = candidate.path.split('.').at(-1)!;
    const conditionKey = candidate.path.startsWith('conditions.') ? candidate.path.slice('conditions.'.length) : undefined;
    const scopedSingle = context.displayed?.topicId === candidate.topicId && context.displayed.targetPaths.length === 1 && context.displayed.targetPaths[0] === candidate.path;
    const uncertainty = (value: string) => uncertainWords.test(value) || unknownWords.test(value);
    // "Prediabetes" inside the quoted words cannot support a diabetes negative ("no diabetes, just prediabetes" is cited separately).
    const quoteUncertain = uncertainty(quote) || (candidate.path === 'conditions.diabetes' && candidate.state !== 'negative' && conditionNames.prediabetes.test(quote) && !conditionNames.diabetes.test(quote.replace(/\bpre[- ]?diabet(?:es|ic)\b/gi, '')));
    if (candidate.state === 'unknown' && !unknownWords.test(quote)) return 'unknown-without-wording';
    if (candidate.state === 'declined' && !declinedWords.test(quote)) return 'declined-without-wording';
    if (candidate.state === 'negative') {
      if (!negativeWords.test(quote)) return 'negative-without-negation';
      if (uncertainty(quote) || uncertainty(clause)) return 'negative-with-uncertainty';
      if (!definition.acceptsNegative && definition.kind !== 'presence') return 'negative-not-allowed';
    }
    // An approximate number ("around 6", "about 200") is an uncertain value, never an exact one.
    const approximate = ['positive-number', 'height-value'].includes(definition.kind) && approximateWords.test(clause);
    if (candidate.state === 'uncertain' && !quoteUncertain && !uncertainty(clause) && !approximate) return 'uncertain-without-wording';
    const asked = norm(sentence).trim();
    if (['presence', 'choice'].includes(definition.kind) && (clause.includes('?') || asked.endsWith('?') && /^(?:do|does|did|can|could|should|would|will|is|am|are|have|has|what|why|how|when|where|which|who)\b/.test(asked))) return 'question-not-answer';
    if (conditionKey) {
      const named = (words: string) => conditionNames[conditionKey]?.test(conditionKey === 'diabetes' ? words.replace(/\bpre[- ]?diabet(?:es|ic)\b/gi, '') : words) ?? false;
      const mention = named(quote);
      if (!mention && !(scopedSingle && quote.split(/\s+/).length <= 6)) return 'condition-not-named';
      // "Pills for my heart" or "arthritis meds" says what a medicine is for, not that the patient was told they have the condition.
      if (mention && candidate.state !== 'negative' && !named(quote.replace(medicinePurpose, ' '))) return 'condition-from-medicine-purpose';
    }
    const ownCondition = candidate.topicId === 'Q06' && (conditionKey || /^reportedConditions\[[^\]]+\]\.term$/.test(candidate.path));
    if (ownCondition && candidate.state !== 'negative' && (relativeWords.test(clause) || thirdPerson.test(clause)) && !firstPerson.test(clause)) return 'relative-subject';
    const medicineRole = candidate.item?.field ?? (/^medicines\[[^\]]+\]\.(labelDirections|actualUse)$/.exec(candidate.path)?.[1]);
    if (candidate.topicId === 'Q08' && candidate.state === 'known' && medicineRole) {
      const labelCue = /\b(?:label|directions?|says|prescribed|bottle|box|instructions?)\b/.test(quote);
      const actualCue = /\b(?:i (?:actually |really |usually |only )?(?:take|use|inject|have)|actually|really)\b/.test(quote);
      if (medicineRole === 'labelDirections' && actualCue && !labelCue) return 'label-vs-actual';
      if (medicineRole === 'actualUse' && labelCue && !actualCue) return 'label-vs-actual';
    }
    return;
  }

  /** Derive a content-native answer from the model's value, checked against the quote. */
  function derive(candidate: Candidate, definition: SlotDefinition, spans: EvidenceSpan[]): { answer: SlotAnswer; impliedUnit?: string; transform: string } | { problem: string; patientFacing: boolean } {
    const quote = quoteOf(spans).join(' ');
    const sourceIds = [sourceId];
    if (candidate.state !== 'known') {
      return { answer: { state: candidate.state, sourceIds, note: quote.slice(0, 400) }, transform: intakeInterpreterTransform };
    }
    switch (definition.kind) {
      case 'presence': return { answer: { state: 'known', value: true, sourceIds }, transform: intakeInterpreterTransform };
      case 'text': {
        const value = typeof candidate.value === 'string' ? candidate.value.trim() : typeof candidate.value === 'number' ? String(candidate.value) : '';
        if (value && value.length <= 400 && !vagueValue.test(norm(value).replace(/[.!]+$/, '')) && textSupported(value, sourceText)) return { answer: { state: 'known', value, sourceIds }, transform: intakeInterpreterTransform };
        // An unsupported/absent paraphrase falls back to the patient's exact words.
        const literal = quote.trim();
        if (literal && literal.length <= 400 && !vagueValue.test(norm(literal).replace(/[.!]+$/, ''))) return { answer: { state: 'known', value: literal, sourceIds }, transform: `${intakeInterpreterTransform}-quote` };
        return { problem: 'unsupported-text-value', patientFacing: false };
      }
      case 'positive-number': {
        const match = typeof candidate.value === 'number' ? [String(candidate.value), String(candidate.value)] : typeof candidate.value === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\.?\s*$/i.exec(candidate.value.replace(/(\d),(\d{3})/g, '$1$2')) : null;
        const value = match ? Number(match[1]) : NaN;
        if (!Number.isFinite(value) || value <= 0) return { problem: 'invalid-number', patientFacing: true };
        if (!numberMentioned(value, quote)) return { problem: 'number-not-in-quote', patientFacing: false };
        const unit = match?.[2] ? unitAliases[match[2].toLowerCase()] : undefined;
        return { answer: { state: 'known', value, sourceIds }, transform: intakeInterpreterTransform, ...(unit ? { impliedUnit: unit } : {}) };
      }
      case 'height-value': {
        const parsed = parseHeightValue(candidate.value) ?? parseHeightValue(quote);
        if (!parsed) return { problem: 'invalid-height', patientFacing: true };
        const numbers = typeof parsed.value === 'object' ? [parsed.value.feet, ...(parsed.value.inches ? [parsed.value.inches] : [])] : [parsed.value as number];
        if (!numbers.every(number => numberMentioned(number, quote.replace(/[’']/g, ' ').replace(/["”]/g, ' ')))) return { problem: 'number-not-in-quote', patientFacing: false };
        return { answer: { state: 'known', value: parsed.value, sourceIds }, transform: intakeInterpreterTransform, ...(parsed.unit ? { impliedUnit: parsed.unit } : {}) };
      }
      case 'choice': {
        const choices = definition.choices ?? [];
        let value: string | number | boolean | undefined;
        if (choices.every(choice => typeof choice === 'boolean')) {
          const raw = typeof candidate.value === 'string' ? candidate.value.trim().toLowerCase() : candidate.value;
          value = raw === true || raw === 'true' || raw === 'yes' ? true : raw === false || raw === 'false' || raw === 'no' ? false : undefined;
        } else {
          const raw = String(candidate.value ?? '').trim().toLowerCase();
          value = choices.find(choice => String(choice).toLowerCase() === raw || String(choice).toLowerCase().replace(/[-_]/g, ' ') === raw) ?? (unitAliases[raw] && choices.includes(unitAliases[raw]) ? unitAliases[raw] : undefined);
          if (value === undefined && /\.unit$/.test(candidate.path)) value = choices.find(choice => typeof choice === 'string' && unitInQuote(choice, String(candidate.value ?? '')));
        }
        if (value === undefined) return { problem: 'invalid-choice', patientFacing: true };
        // A unit not repeated next to this number may come from the turn when exactly one weight/height unit was said ("182 pounds ... maybe 188 now").
        const turnUnit = (unit: string) => unitInQuote(unit, sourceText) && !choices.some(other => typeof other === 'string' && other !== unit && other !== 'ft-in' && unitInQuote(other, sourceText));
        if (/\.unit$/.test(candidate.path) && typeof value === 'string' && !unitInQuote(value, quote) && !turnUnit(value)) return { problem: 'unit-not-in-quote', patientFacing: false };
        return { answer: { state: 'known', value, sourceIds }, transform: intakeInterpreterTransform };
      }
      default: return { problem: 'unsupported-kind', patientFacing: false };
    }
  }

  /** Apply one validated candidate at an exact resolved path. Never throws for model content. */
  function applyFact(candidate: Candidate, spans: EvidenceSpan[]): boolean {
    const t = topic(candidate.topicId);
    if (!t) { reject({ kind: 'fact', topicId: candidate.topicId, path: candidate.path, reason: 'unknown-topic', evidence: spans }); return false; }
    activateAdaptiveBranch(responses, t, evidence);
    const current = response(t.id);
    let resolved: ReturnType<typeof adaptiveSlot>;
    try { resolved = adaptiveSlot(t, current, candidate.path); } catch { reject({ kind: 'fact', topicId: t.id, path: candidate.path, reason: 'unknown-field', evidence: spans, state: candidate.state }); return false; }
    const definition = resolved.definition;
    if (excludedSlot(definition) || definition.kind === 'collection' && candidate.state === 'known') { reject({ kind: 'fact', topicId: t.id, path: candidate.path, reason: 'field-forbidden', evidence: spans }); return false; }
    const problem = lexicalProblem(candidate, definition, spans);
    if (problem) { reject({ kind: 'fact', topicId: t.id, path: candidate.path, reason: problem, evidence: spans, state: candidate.state }); return false; }
    const clarify = (reason: AdaptiveClarification['reason'], proposed?: SlotAnswer) => outcome.clarifications.push({ topicId: t.id, path: candidate.path, reason, evidence: spans, ...(resolved.answer ? { previous: resolved.answer } : {}), ...(proposed ? { proposed } : {}) });
    if (current.stopped) { clarify('stopped-topic'); return false; }
    if ((t.presentation === 'C' && current.applicability !== 'applicable') || !conditionalReady(definition, resolved.siblings, resolved.definitions, context)) { clarify('condition-unresolved'); return false; }
    const derived = derive(candidate, definition, spans);
    if ('problem' in derived) {
      if (derived.patientFacing) clarify('ambiguous-value');
      else reject({ kind: 'fact', topicId: t.id, path: candidate.path, reason: derived.problem, evidence: spans, state: candidate.state });
      return false;
    }
    let answer = derived.answer;
    const prior = resolved.answer;
    let correctsSourceIds: string[] | undefined;
    // "Keep the first thing I said" refers to an alternative; it is never itself clinical content.
    if (answer.state === 'known' && typeof answer.value === 'string' && pointerAnswer.test(answer.value)) { clarify('ambiguous-value'); return false; }
    const asked = context.displayed?.topicId === t.id && context.displayed.promptId !== '__clarify-record' && (context.displayed.targetPaths ?? []).includes(candidate.path);
    // "I don't know" to a specificity follow-up keeps the description already given; the session records the reply.
    if (asked && context.displayed?.specificity && prior?.state === 'known' && answer.state !== 'known') return false;
    // Two values for one field in the same message with a correction cue between them: the later one replaces the earlier.
    const earlier = prior?.state === 'known' && prior.sourceIds.includes(sourceId) ? outcome.provenance.filter(entry => entry.topicId === t.id && entry.path === candidate.path).flatMap(entry => entry.evidence).filter(span => span.sourceId === sourceId) : [];
    const order = earlier.length ? selfCorrection(earlier, spans) : undefined;
    if (order === 'earlier') {
      // This value is the one the patient corrected later in the same message: keep it only as superseded provenance.
      outcome.provenance.push({ topicId: t.id, path: candidate.path, evidence: spans, transform: `${intakeInterpreterTransform}-superseded-in-message`, sourceText: quoteOf(spans) });
      return false;
    }
    if (order === 'later') { /* replaces the earlier value from this same message; both spans stay in provenance */ }
    else if (prior && sameAnswer(prior, answer)) answer = { ...answer, sourceIds: [...new Set([...(prior.sourceIds ?? []), ...(answer.sourceIds ?? [])])] } as SlotAnswer;
    // Several parts of one message for the same text field ("more energy, and to stop eating at night") are one answer, not a conflict.
    // A follow-up that asks for more about an answered text field gets an elaboration, not a contradiction.
    // A reply to a specificity follow-up adds the detail it asked for, even when the model labels it a correction.
    else if (prior?.state === 'known' && answer.state === 'known' && definition.kind === 'text' && (prior.sourceIds.includes(sourceId) || asked && (!candidate.corrects || !!context.displayed?.specificity)) && typeof prior.value === 'string' && typeof answer.value === 'string')
      answer = { ...answer, value: norm(prior.value).includes(norm(answer.value)) ? prior.value : `${prior.value}; ${answer.value}` } as SlotAnswer;
    // Answering a field already marked conflicting is the patient's clarification: it resolves the conflict, keeping both earlier sources on record.
    else if (prior?.state === 'conflicting') correctsSourceIds = [...(prior.sourceIds ?? [])];
    else if (prior && !['not-asked', 'unknown', 'uncertain'].includes(prior.state)) {
      const line = candidate.corrects ? known.lines.find(entry => entry.number === candidate.corrects) : undefined;
      const valid = line && line.topicId === t.id && line.path === candidate.path && correctionCue.test(norm(sourceText));
      if (!valid) {
        // Do not overwrite earlier information. Keep both alternatives for explicit clarification.
        const conflict: SlotAnswer = { state: 'conflicting', sourceIds: [...new Set([...(prior.sourceIds ?? []), ...(answer.sourceIds ?? [])])], note: 'Patient statements differ; clarification is needed.' };
        try { responses[t.id] = applyGuidedAnswer(t, current, { path: candidate.path, answer: conflict }, evidence); outcome.updates.push({ topicId: t.id, path: candidate.path, answer: conflict }); } catch { /* keep prior */ }
        clarify('conflict', answer);
        return false;
      }
      correctsSourceIds = [...(prior.sourceIds ?? [])];
    }
    try { responses[t.id] = applyGuidedAnswer(t, current, { path: candidate.path, answer }, evidence); }
    catch { reject({ kind: 'fact', topicId: t.id, path: candidate.path, reason: 'invalid-answer', evidence: spans, state: candidate.state }); return false; }
    const quote = quoteOf(spans);
    outcome.updates.push({ topicId: t.id, path: candidate.path, answer });
    if (order === 'later') for (const entry of outcome.provenance) if (entry.topicId === t.id && entry.path === candidate.path && !entry.transform.endsWith('-superseded-in-message')) entry.transform = `${intakeInterpreterTransform}-superseded-in-message`;
    outcome.provenance.push({ topicId: t.id, path: candidate.path, evidence: spans, transform: order === 'later' ? `${intakeInterpreterTransform}-in-message-correction` : derived.transform, sourceText: quote, ...(correctsSourceIds?.length ? { correctsSourceIds } : {}) });
    // Unit implied by the value itself ("5 ft 8 in", "173 cm", "207 lb"); applied after explicit unit facts.
    const unitPath = candidate.path.replace(/\.value$/, '.unit');
    if (derived.impliedUnit && unitPath !== candidate.path) implied.push({ topicId: t.id, unitPath, unit: derived.impliedUnit, spans, quote, corrected: !!correctsSourceIds, height: candidate.path === 'height.value' });
    if (candidate.path === 'currentWeightEstimate.value' && answer.state === 'known') {
      const timestamp: SlotAnswer = { state: 'known', value: context.source.at, sourceIds: [sourceId] };
      responses[t.id] = { ...response(t.id), answers: { ...response(t.id).answers, 'currentWeightEstimate.statedAt': timestamp } };
      outcome.updates.push({ topicId: t.id, path: 'currentWeightEstimate.statedAt', answer: timestamp });
      outcome.provenance.push({ topicId: t.id, path: 'currentWeightEstimate.statedAt', evidence: spans, transform: 'source-timestamp', sourceText: quote });
      // A different weight stated for "now" is the patient's own evidence that the reading is not current.
      // Without it the estimate is not applicable and synchronization would silently drop it.
      const answers = response(t.id).answers, measured = answers['lastMeasuredWeight.value'], represents = answers['lastMeasuredWeight.representsCurrent'];
      if ((!represents || represents.state === 'not-asked') && !(measured?.state === 'known' && measured.value === answer.value)) {
        const notCurrent: SlotAnswer = { state: 'known', value: false, sourceIds: [sourceId] };
        try {
          responses[t.id] = applyGuidedAnswer(t, response(t.id), { path: 'lastMeasuredWeight.representsCurrent', answer: notCurrent }, evidence);
          outcome.updates.push({ topicId: t.id, path: 'lastMeasuredWeight.representsCurrent', answer: notCurrent });
          outcome.provenance.push({ topicId: t.id, path: 'lastMeasuredWeight.representsCurrent', evidence: spans, transform: 'estimate-implies-not-current', sourceText: quote });
        } catch { /* leave for the authored follow-up */ }
      }
    }
    if (candidate.state === 'declined') responses[t.id] = { ...response(t.id), stopped: 'patient-declines' };
    return true;
  }

  for (const candidate of facts) {
    const spans = locateQuote(context, candidate.quote);
    if (!spans) { reject({ kind: 'fact', topicId: candidate.topicId, path: candidate.path, reason: 'quote-not-found', state: candidate.state, ...(typeof candidate.quote === 'string' ? { quote: candidate.quote.slice(0, 400) } : {}) }); continue; }
    // "ft" or "in" alongside a composite feet+inches height is the composite ft-in unit.
    const height = candidate.path === 'height.unit' ? responses[candidate.topicId]?.answers['height.value'] : undefined;
    if (height?.state === 'known' && typeof height.value === 'object' && typeof candidate.value === 'string' && ['ft', 'in', 'feet', 'foot', 'inches'].includes(candidate.value.trim().toLowerCase())) candidate.value = 'ft-in';
    applyFact(candidate, spans);
  }
  for (const pending of implied) {
    const t = topic(pending.topicId)!;
    let unitSlot: ReturnType<typeof adaptiveSlot>;
    try { unitSlot = adaptiveSlot(t, response(t.id), pending.unitPath); } catch { continue; }
    if (unitSlot.definition.kind !== 'choice' || !unitSlot.definition.choices?.includes(pending.unit)) continue;
    const prior = unitSlot.answer;
    if (prior?.state === 'known' && (prior.sourceIds.includes(sourceId) || prior.value === pending.unit)) continue;
    if (prior?.state === 'known' && !pending.corrected) {
      if (!pending.height) outcome.clarifications.push({ topicId: t.id, path: pending.unitPath, reason: 'conflict', evidence: pending.spans, previous: prior, proposed: { state: 'known', value: pending.unit, sourceIds: [sourceId] } });
      continue; // A composite height mismatch is resolved by the final consistency check.
    }
    const unitAnswer: SlotAnswer = { state: 'known', value: pending.unit, sourceIds: [sourceId] };
    try { responses[t.id] = applyGuidedAnswer(t, response(t.id), { path: pending.unitPath, answer: unitAnswer }, evidence); } catch { continue; }
    outcome.updates.push({ topicId: t.id, path: pending.unitPath, answer: unitAnswer });
    outcome.provenance.push({ topicId: t.id, path: pending.unitPath, evidence: pending.spans, transform: pending.height ? 'explicit-height-unit' : `${intakeInterpreterTransform}-unit`, sourceText: pending.quote });
  }
  for (const t of context.topics) activateAdaptiveBranch(responses, t, evidence);

  // --- collection items ---
  // Item ids must fit the capture schema (^[A-Za-z0-9_-]{1,64}$); real source ids are UUIDs.
  const sourceCode = sourceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  const keyField: Record<string, string[]> = { familyHistory: ['condition', 'relationship'] };
  list(wire.items, 12).forEach((entry, index) => {
    const parsed = itemWire.safeParse(entry);
    if (!parsed.success) { reject({ kind: 'item', reason: 'malformed' }); return; }
    const t = topic(parsed.data.topic);
    const listPath = parsed.data.list.replace(/\[\]$/, '');
    const fields = parsed.data.fields.map(field => itemFieldWire.safeParse(field)).flatMap(result => {
      if (!result.success) { reject({ kind: 'item', topicId: parsed.data.topic, path: listPath, reason: 'malformed-field' }); return []; }
      return [result.data];
    });
    if (!t) { reject({ kind: 'item', topicId: parsed.data.topic, path: listPath, reason: 'unknown-topic' }); return; }
    let definition: SlotDefinition;
    try { definition = adaptiveSlot(t, response(t.id), listPath).definition; } catch { reject({ kind: 'item', topicId: t.id, path: listPath, reason: 'unknown-field' }); return; }
    if (definition.kind !== 'collection') { reject({ kind: 'item', topicId: t.id, path: listPath, reason: 'collection-required' }); return; }
    const located = fields.map(field => ({ field, spans: locateQuote(context, field.quote) }));
    for (const { field, spans } of located) if (!spans) reject({ kind: 'item', topicId: t.id, path: `${listPath}.${field.field}`, reason: 'quote-not-found', state: field.state, ...(typeof field.quote === 'string' ? { quote: field.quote.slice(0, 400) } : {}) });
    const usable = located.filter((entry): entry is { field: typeof entry.field; spans: EvidenceSpan[] } => !!entry.spans);
    if (!usable.length) return;
    const allSpans = usable.flatMap(entry => entry.spans).slice(0, 4);
    const current = response(t.id);
    if (current.stopped || t.presentation === 'C' && current.applicability !== 'applicable') {
      outcome.clarifications.push({ topicId: t.id, path: listPath, reason: current.stopped ? 'stopped-topic' : 'condition-unresolved', evidence: allSpans }); return;
    }
    // Existing item: explicit id from KNOWN ANSWERS, else exact key-field equality to avoid duplicates.
    const collection = current.answers[listPath];
    const existingItems = collection?.state === 'known' ? collection.items ?? [] : [];
    let itemId = parsed.data.existing && existingItems.some(item => item.id === parsed.data.existing) ? parsed.data.existing : undefined;
    if (!itemId) {
      const keys = keyField[listPath] ?? [definition.fields?.[0]?.id ?? ''];
      const proposed = (key: string) => { const field = usable.find(entry => entry.field.field === key && entry.field.state === 'known'); return typeof field?.field.value === 'string' ? norm(field.field.value) : undefined; };
      if (keys.every(key => proposed(key))) itemId = existingItems.find(item => keys.every(key => { const answer = item.answers[key]; return answer?.state === 'known' && typeof answer.value === 'string' && sameItemName(norm(answer.value), proposed(key)!); }))?.id;
    }
    const created = !itemId;
    if (!itemId) {
      itemId = `a${sourceCode}_${index}`;
      try { responses[t.id] = addCollectionItem(t, current, { path: listPath, itemId, sourceIds: [sourceId] }, evidence); }
      catch { reject({ kind: 'item', topicId: t.id, path: listPath, reason: 'invalid-item', evidence: allSpans }); return; }
    }
    // Item anchors (name/term) first, then conditional fields.
    const ordered = [...usable].sort((a, b) => {
      const rank = (name: string) => { const field = definition.fields?.find(entry => entry.id === name); return (field?.id === definition.fields?.[0]?.id ? -10 : 0) + (field?.when ? 3 : 0); };
      return rank(a.field.field) - rank(b.field.field);
    });
    let accepted = 0;
    for (const { field, spans } of ordered) {
      if (accepted >= 12) break;
      if (applyFact({ topicId: t.id, path: `${listPath}[${itemId}].${field.field}`, state: field.state, value: field.value, quote: field.quote, corrects: field.corrects ?? null, item: { list: listPath, field: field.field } }, spans)) accepted++;
    }
    if (created) {
      const saved = response(t.id).answers[listPath];
      const item = saved?.state === 'known' ? saved.items?.find(entry => entry.id === itemId) : undefined;
      if (!item || !Object.keys(item.answers).length) {
        // An item with zero accepted fields is not created; drop clarifications that targeted it.
        responses[t.id] = current;
        outcome.clarifications = outcome.clarifications.map(entry => entry.topicId === t.id && entry.path.startsWith(`${listPath}[${itemId}].`) ? { ...entry, path: listPath } : entry);
        return;
      }
      outcome.updates.push({ topicId: t.id, path: listPath, answer: response(t.id).answers[listPath]! });
    }
  });
  for (const t of context.topics) activateAdaptiveBranch(responses, t, evidence);

  // --- completed lists ---
  for (const entry of list(wire.listsDone, 8)) {
    const parsed = listDoneWire.safeParse(entry);
    if (!parsed.success) { reject({ kind: 'list-done', reason: 'malformed' }); continue; }
    const t = topic(parsed.data.topic), listPath = parsed.data.list.replace(/\[\]$/, '');
    const spans = locateQuote(context, parsed.data.quote);
    if (!t || !spans) { reject({ kind: 'list-done', topicId: parsed.data.topic, path: listPath, reason: t ? 'quote-not-found' : 'unknown-topic', quote: parsed.data.quote.slice(0, 400) }); continue; }
    const quote = norm(quoteOf(spans).join(' ')), sentence = norm(covering(sourceText, spans));
    if (!completionWords.test(quote) || /[?]|\b(?:not all|isn't all|there (?:are|is) (?:other|more)|there's more|maybe|not sure|can't remember|cannot remember)\b/.test(sentence)) { reject({ kind: 'list-done', topicId: t.id, path: listPath, reason: 'no-completion-wording', evidence: spans }); continue; }
    if (response(t.id).stopped) continue;
    let answer: SlotAnswer | undefined;
    try { answer = adaptiveSlot(t, response(t.id), listPath).answer; } catch { reject({ kind: 'list-done', topicId: t.id, path: listPath, reason: 'unknown-field', evidence: spans }); continue; }
    if (answer?.state !== 'known' || !answer.items?.length) { reject({ kind: 'list-done', topicId: t.id, path: listPath, reason: 'empty-list', evidence: spans }); continue; }
    if (answer.complete) continue;
    responses[t.id] = finishCollection(t, response(t.id), { path: listPath, sourceIds: [sourceId] }, evidence);
    outcome.updates.push({ topicId: t.id, path: listPath, answer: response(t.id).answers[listPath]! });
    outcome.provenance.push({ topicId: t.id, path: listPath, evidence: spans, transform: 'explicit-list-completion', sourceText: quoteOf(spans) });
  }
  // "Would you rather move on or come back to this?" must never loop: a reply that adds nothing moves on,
  // exactly like the guided Skip control. The patient can still add answers from review.
  const engagement = context.displayed?.promptId === '__engagement-choice' ? context.displayed.topicId : undefined;
  if (engagement && !stopTopics.size && !outcome.updates.some(update => update.topicId === engagement)) {
    const spans = locateQuote(context, sourceText.trim());
    if (spans) { stopTopics.add(engagement); moveOnSpans = spans; outcome.acts.push({ kind: 'move-on', targetTopicId: engagement, evidence: spans }); }
  }
  // Avoidance is clinically meaningful: record the displayed detail as declined with the patient's words, as guided
  // "I'd rather not say" does, and stop the topic as patient-declines. A plain skip only moves on.
  for (const id of stopTopics) {
    const t = topic(id), spans = moveOnSpans!;
    const avoids = avoidanceWords.test(norm(quoteOf(spans).join(' ')));
    if (t && avoids) {
      const declined: SlotAnswer = { state: 'declined', sourceIds: [sourceId] };
      for (const path of context.displayed?.targetPaths ?? []) {
        let existing: SlotAnswer | undefined;
        try { existing = adaptiveSlot(t, response(id), path).answer; } catch { continue; }
        if (existing && existing.state !== 'not-asked') continue;
        try { responses[id] = applyGuidedAnswer(t, response(id), { path, answer: declined }, evidence); } catch { continue; }
        outcome.updates.push({ topicId: id, path, answer: declined });
        outcome.provenance.push({ topicId: id, path, evidence: spans, transform: 'verbatim', sourceText: quoteOf(spans) });
        break;
      }
    }
    responses[id] = { ...response(id), presented: true, stopped: avoids ? 'patient-declines' : 'patient-moves-on' };
  }

  // --- final composite-height consistency: undo rather than fail the turn ---
  const q04 = responses.Q04;
  if (q04) {
    const value = q04.answers['height.value'], unit = q04.answers['height.unit'];
    if (value?.state === 'known' && unit?.state === 'known' && (typeof value.value === 'object') !== (unit.value === 'ft-in')) {
      const original = context.responses.Q04?.answers ?? {};
      responses.Q04 = { ...q04, answers: { ...q04.answers, 'height.value': original['height.value'], 'height.unit': original['height.unit'] } };
      const spans = outcome.provenance.filter(entry => entry.topicId === 'Q04' && entry.path.startsWith('height.')).flatMap(entry => entry.evidence).slice(0, 4);
      outcome.updates = outcome.updates.filter(entry => !(entry.topicId === 'Q04' && entry.path.startsWith('height.')));
      outcome.provenance = outcome.provenance.filter(entry => !(entry.topicId === 'Q04' && entry.path.startsWith('height.')));
      outcome.clarifications.push({ topicId: 'Q04', path: 'height.value', reason: 'conflict', evidence: spans.length ? spans : [{ sourceId, start: 0, end: sourceText.length }] });
    }
  }

  // --- source-level question coverage, independent of the model ---
  const questionRegions = regions(sourceText).filter(region => region.text.includes('?') || /^\s*(?:tell me|please explain|i wonder)\b/i.test(region.text));
  const omitted = questionRegions.filter(region => !outcome.acts.some(act => act.kind === 'question' && act.evidence.some(span => span.start < region.end && span.end > region.start)));
  if (omitted.length) {
    outcome.unresolvedQuestions = omitted.slice(0, 32).map(region => {
      const lead = region.text.search(/\S/);
      return { sourceId, start: region.start + Math.max(0, lead), end: region.end };
    });
    if (outcome.acts.filter(act => act.kind === 'question').length < 4) outcome.acts.push({ kind: 'question', replyId: replyFor(omitted.map(region => region.text).join(' ')), evidence: outcome.unresolvedQuestions.slice(0, 4) } as ValidatedAct);
  }

  // --- optional neutral acknowledgement (never advice; the next question stays authored) ---
  const ack = typeof wire.ack === 'string' ? wire.ack.trim().replace(/\s+/g, ' ') : '';
  // Patient words the server could not place (not model padding) keep the source visible for review.
  const unplaced = rejected.some(entry => entry.evidence && (entry.state === 'known' && !['relative-subject', 'question-not-answer', 'label-vs-actual'].includes(entry.reason) || ['unknown-field', 'unknown-topic'].includes(entry.reason)));
  if (ack && ack.length <= 160 && !ackForbidden.test(ack) && ackGrounded(ack, sourceText) && outcome.updates.length && !outcome.clarifications.length && !unplaced) outcome.acknowledgement = ack;

  if (rejected.length) outcome.rejectedCandidates = rejected.slice(0, 64);
  // "I'll bring the bottle" or "yes" to a specificity follow-up settles it in the session; it is not an unplaced answer.
  const followUp = context.displayed?.specificity, settlesFollowUp = !!followUp && (!!followUp.spelling || Object.values(specificityTerminal).some(pattern => pattern.test(sourceText)));
  outcome.hasUnresolvedInterpretation = !!outcome.unresolvedQuestions?.length || outcome.clarifications.length > 0 || unplaced
    || outcome.updates.length === 0 && !settlesFollowUp && !outcome.acts.some(act => ['question', 'move-on', 'topic-switch'].includes(act.kind));
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// DigitalOcean runtime
// ---------------------------------------------------------------------------------------------

/** One direct DigitalOcean call per turn, json_object response format, no retries. */
export function createIntakeInterpreter(config: Omit<DigitalOceanConfig, 'responseFormat'>, fetcher: Fetch = fetch): IntakeInterpreter {
  return {
    async interpret(context) {
      const messages = buildIntakeInterpreterMessages(context);
      const result = await digitalOcean({ ...config, responseFormat: 'json', maxRequestBytes: Math.min(config.maxRequestBytes ?? maxRequestBytes, maxRequestBytes) }, fetcher).generate(messages);
      const receipt: AdaptiveProposalReceipt = { requestId: result.requestId, model: result.model, usage: result.usage, evidenceProtocol: intakeInterpreterProtocol, requestBytes: result.requestBytes };
      let raw: unknown;
      try { raw = parseIntakeInterpreterText(result.text); } catch { throw new AdaptiveProposalFailure('invalid-interpreter-json', receipt, result.text); }
      try { return { outcome: interpretIntakeResponse(raw, context), receipt, rawProposal: raw }; }
      catch (error) {
        if (error instanceof AdaptiveError) throw new AdaptiveProposalFailure(error.code, receipt, raw);
        throw error;
      }
    },
  };
}
