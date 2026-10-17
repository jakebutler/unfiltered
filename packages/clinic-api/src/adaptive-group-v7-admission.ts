import type { AdaptiveContext, AdaptiveFact, EvidenceSpan } from './adaptive-validation.js';
import type { GroupFamily, GroupRole } from './adaptive-group-manifest.js';
import type { SourceHandle } from './adaptive-group-source-handles.js';

/** V7-only admission proof. It never derives omitted values or grants readiness. */
export const sourceGroupAdmissionRevision = 'v7-positive-state-temporal-grammar-v2' as const;
const normalize = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (grammar: string, text: string) => new RegExp(`^(?:${grammar})$`, 'u').test(text);
type Nonknown = Exclude<AdaptiveFact['state'], 'known'>;
const direct: Record<Nonknown, string> = {
  unknown: "unknown|i (?:don't|do not) (?:know|remember)|i (?:can't|cannot) recall",
  uncertain: "not sure|unsure|uncertain|i(?: am|'m) (?:not sure|unsure|uncertain)",
  declined: "skip|move on|i (?:prefer|would rather) not (?:to )?answer|i (?:don't|do not) want to answer",
  negative: 'no|none|none that i know of|none known',
  'not-applicable': "not applicable|it (?:doesn't|does not) apply",
};
const historyWindows: Readonly<Record<string, string>> = {
  childhood: 'as a child|in (?:my )?childhood|during (?:my )?childhood|in primary school|in elementary school',
  teenage: 'in my teens|as a teenager|during (?:my )?teenage years|in high school|in secondary school',
  afterSchool: 'after (?:leaving )?(?:high |secondary )?school|after graduation',
  lastFiveYears: '(?:in|over|during) the (?:last|past) (?:five|5) years',
  past18Months: '(?:in|over|during) the (?:last|past) (?:eighteen|18) months',
};
// Complete object grammars, never role words searched in arbitrary text.
// Unlisted roles still accept an exact, single displayed-target direct reply.
const patientObjects: Readonly<Record<string, string>> = {
  'height.value': 'my height|my height (?:value|number)',
  'height.unit': 'my height units?|the units? of my height',
  'lastMeasuredWeight.value': 'my (?:last measured weight|measured weight|last weight reading)',
  'lastMeasuredWeight.unit': 'my measured weight units?|the units? of my (?:measured weight|last weight reading)',
  'lastMeasuredWeight.measuredWhen': 'the date of my (?:last weight reading|last weight measurement)|when i was (?:last )?weighed',
  'lastMeasuredWeight.datePrecision': 'the precision of my measurement date|whether my measurement date is exact',
  'lastMeasuredWeight.representsCurrent': 'whether my (?:last weight reading|measured weight) (?:still )?(?:reflects|represents) my (?:current )?weight(?: now)?',
  'lastMeasuredWeight.describedAsOld': 'whether my (?:last weight reading|measured weight) is old',
  'currentWeightEstimate.value': 'my (?:current weight|estimated weight|weight estimate)',
  'currentWeightEstimate.unit': 'my estimated weight units?|the units? of my weight estimate',
};
const conditionObjects: Readonly<Record<string, string>> = {
  diabetes: 'diabetes', prediabetes: 'prediabetes|pre-diabetes',
  bloodPressure: 'high blood pressure|hypertension', cholesterol: 'high cholesterol',
  heartDisease: 'heart disease', stroke: 'a stroke', sleepApnea: 'sleep apnea|sleep apnoea',
  liver: 'a liver condition|fatty liver', kidney: 'kidney disease|a kidney condition',
  joint: 'arthritis|a joint condition', thyroidHormone: 'a thyroid condition|a hormone condition',
  digestive: 'a digestive condition',
};
const entityObjects: Readonly<Record<string, (identity: string) => string>> = {
  strength: name => `${name}(?:'s)? strength|the strength of ${name}`,
  labelDirections: name => `${name}(?:'s)? label directions|the label directions (?:of|for) ${name}`,
  directions: name => `${name}(?:'s)? label directions|the label directions (?:of|for) ${name}`,
  actualUse: name => `my actual use of ${name}|how i (?:take|use) ${name}`,
  reason: name => `my reason for (?:taking|using) ${name}`,
  concerns: name => `my concerns (?:with|about|for) ${name}`,
  foodAmounts: name => `the ${name} portion|the portion of ${name}`,
  drinkAmounts: name => `the amount of ${name}`,
  drinkAdditions: name => `what was added to (?:the )?${name}`,
};
export interface StateScope {
  readonly family: GroupFamily;
  readonly role: GroupRole;
  readonly path: string;
  /** Exact selected entity anchor, never model-assigned identity semantics. */
  readonly identity?: string;
  /** The same group's other proposed fields; a drink role names the item's own known drink. */
  readonly siblings?: Readonly<Record<string, { readonly state: AdaptiveFact['state']; readonly value?: string }>>;
}
/** Preserve original sentence boundaries even when a handle coalesces sentences. */
function sentences(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?](?=\s|$)|;|\r?\n/g)) {
    if (match[0] === '.' && /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|[A-Z])$/i.test(text.slice(0, match.index))) continue;
    result.push(text.slice(start, match.index! + match[0].length));
    start = match.index! + match[0].length;
  }
  if (start < text.length) result.push(text.slice(start));
  return result.map(text => normalize(text).replace(/[.;\r\n]+$/, '').trim()).filter(Boolean);
}
const drinkRoles = new Set(['drinkAmounts', 'drinkAdditions']);
function roleObject(scope: StateScope, role = scope.role.role): string | undefined {
  if (scope.family.anchorRoles.length) {
    const drink = drinkRoles.has(role) && scope.siblings?.drinks?.state === 'known' ? scope.siblings.drinks.value : undefined;
    const name = drink ?? scope.identity;
    if (!name || !entityObjects[role]) return;
    return entityObjects[role](escape(normalize(name)));
  }
  return patientObjects[role];
}
function historyPredicate(text: string, state: Nonknown, role: string): boolean {
  const window = historyWindows[role];
  if (!window) return false;
  const unavailable = "i (?:don't|do not) (?:know|remember|recall) my weight";
  if (state === 'unknown') return exact(`(?:${window}) ${unavailable}|i (?:don't|do not) (?:know|remember|recall) what happened (?:${window})`, text);
  if (state === 'not-applicable') return exact(`(?:${window}) (?:is not applicable|does not apply to me)`, text);
  if (state === 'declined') return exact(`i (?:prefer|would rather) not to answer about my weight (?:${window})`, text);
  if (state === 'uncertain') return exact(`(?:${window}) i(?: am|'m) (?:not sure|uncertain) about my weight`, text);
  return false;
}
function historyDeclaration(text: string, state: Nonknown, role: string): boolean {
  if (historyPredicate(text, state, role)) return true;
  // One closed coordination: each fronted window owns its own weight predicate.
  // An arbitrary suffix, contrast, or unavailable predicate is never ignored.
  const parts = text.split(', but ');
  return parts.length === 2 && historyPredicate(parts[0], state, role)
    && Object.values(historyWindows).some(window => exact(`(?:${window}) my weight (?:was stable|stayed steady|increased|decreased)`, parts[1]));
}
function hasPrecedingMeasurement(context: AdaptiveContext, statement: SourceHandle): boolean {
  const preceding = sentences(context.source.text.slice(0, statement.start)).at(-1);
  return !!preceding && measuredTemporalTail(preceding) !== undefined;
}
function assertedState(context: AdaptiveContext, text: string, state: Nonknown, scope: StateScope, statement: SourceHandle): boolean {
  if (scope.family.kind === 'Q03') return historyDeclaration(text, state, scope.role.role);
  const condition = scope.role.role.startsWith('conditions.') ? conditionObjects[scope.role.role.slice('conditions.'.length)] : undefined;
  if (condition) {
    if (state === 'negative') return exact(`i (?:don't|do not) have (?:${condition})|i have no (?:${condition})`, text);
    if (state === 'uncertain') return exact(`i (?:might|may) have (?:${condition})|i was told i (?:might|may) have (?:${condition})(?:, but no diagnosis yet)?`, text);
    if (state === 'unknown') return exact(`i (?:don't|do not) know whether i have (?:${condition})`, text);
    if (state === 'declined') return exact(`i (?:prefer|would rather) not to answer about (?:${condition})`, text);
    return false;
  }
  if (scope.role.role === 'lastMeasuredWeight.representsCurrent' && state === 'uncertain'
    && exact("i(?: am|'m) not sure whether that still reflects my weight", text)) return hasPrecedingMeasurement(context, statement);
  if (scope.family.kind === 'Q11' && scope.role.role === 'otherIntake' && state === 'negative')
    return exact('nothing else(?: that day)?', text);
  const object = roleObject(scope);
  if (!object) return false;
  // One closed coordination: every conjunct is a complete object grammar of a sibling field proposed with the same state.
  const others = Object.entries(scope.siblings ?? {}).filter(([role, sibling]) => role !== scope.role.role && sibling.state === state)
    .map(([role]) => roleObject(scope, role)).filter((grammar): grammar is string => !!grammar).join('|');
  const coordinated = others ? `(?:(?:${others}),? (?:or|and|nor) )?(?:${object})(?:,? (?:or|and|nor) (?:${others}))?` : object;
  if (state === 'unknown') return exact(`i (?:don't|do not|can't|cannot) (?:know|remember|recall) (?:${coordinated})|(?:${object}) (?:is|are) unknown`, text);
  if (state === 'uncertain') return exact(`i(?: am|'m) (?:not sure|unsure|uncertain) (?:about )?(?:${object})|(?:${object}) (?:is|are) (?:uncertain|unconfirmed)`, text);
  if (state === 'declined') return exact(`i (?:prefer|would rather) not (?:to )?answer about (?:${object})|i (?:don't|do not) want to answer about (?:${object})`, text);
  if (state === 'not-applicable') return exact(`(?:${object}) (?:is not applicable|does not apply to me)`, text);
  if (state === 'negative' && scope.role.role === 'concerns' && scope.identity)
    return exact(`no concerns (?:with|about|for) ${escape(normalize(scope.identity))}|i have no concerns (?:with|about|for) ${escape(normalize(scope.identity))}`, text);
  return false;
}
/** A complete positive declaration proves state, patient, role and entity together. */
export function scopedStateRejection(
  context: AdaptiveContext, state: AdaptiveFact['state'], statements: readonly SourceHandle[], scope: StateScope,
): string | undefined {
  if (state === 'known') return;
  const full = normalize(context.source.text).replace(/[.!]+$/, '');
  if (context.displayed?.topicId === scope.family.topicId && context.displayed.targetPaths.length === 1
    && context.displayed.targetPaths[0] === scope.path && exact(direct[state], full)) return;
  if (statements.some(statement => sentences(statement.text).some(text => assertedState(context, text, state, scope, statement)))) return;
  // Keep the unchanged history guard's rejection/probe contract for an entirely
  // absent proposed window only when another complete history predicate parses.
  // The history guard rejects; this does not apply an answer.
  if (scope.family.kind === 'Q03' && historyWindows[scope.role.role]
    && !statements.some(statement => new RegExp(historyWindows[scope.role.role]).test(normalize(statement.text)))
    && statements.some(statement => sentences(statement.text).some(text => Object.keys(historyWindows)
      .some(role => role !== scope.role.role && historyDeclaration(text, state, role))))) return;
  return 'unscoped-state-evidence';
}

const medicineName = '[\\p{L}][\\p{L}\\p{N}-]*(?: [\\p{L}][\\p{L}\\p{N}-]*){0,3}';
const cadence = '(?:once|twice|three times) (?:daily|weekly|monthly)|daily|weekly|monthly';
/** Proves a universe only when EVERY preceding sentence is a complete medicine
 * introduction. No proposed entity participates in the source parse. */
function precedingMedicineUniverse(context: AdaptiveContext, before: number): string[] | undefined {
  const names: string[] = [];
  for (const sentence of sentences(context.source.text.slice(0, before))) {
    const simple = new RegExp(`^i take (${medicineName})$`, 'u').exec(sentence);
    const detailed = new RegExp(`^(${medicineName}) \\d+(?:\\.\\d+)? (?:mg|mcg|iu): the label says (?:${cadence}), but i take it (?:${cadence})(?: for [\\p{L}][\\p{L}\\p{N}-]*)?$`, 'u').exec(sentence);
    const name = (simple ?? detailed)?.[1];
    if (!name || /\b(?:and|or|with|without|if|it|them)\b/.test(name) || names.includes(name)) return;
    names.push(name);
  }
  return names.length ? names : undefined;
}
/** Named negatives bind independently. Indirect negatives need source-complete proof. */
export function sharedStateRejection(context: AdaptiveContext, state: AdaptiveFact['state'], statements: readonly SourceHandle[], scopes: readonly StateScope[]): string | undefined {
  if (state === 'known') return;
  if (scopes.length && scopes.every(scope => !scopedStateRejection(context, state, statements, scope))) return;
  const identities = scopes.map(scope => scope.identity && normalize(scope.identity));
  if (state === 'negative' && scopes.every(scope => scope.family.kind === 'Q08.medicines' && scope.role.role === 'concerns')
    && identities.length >= 2 && identities.every((identity): identity is string => !!identity) && new Set(identities).size === identities.length) {
    for (const statement of statements) {
      const phrases = sentences(statement.text);
      // The assertion must be the entire cited statement. Coalesced/qualified
      // text cannot hide another entity or an unparsed qualification.
      if (phrases.length !== 1) continue;
      const indirect = /^no concerns (?:with|about|for) (either|both|any of them|all)$/.exec(phrases[0]);
      if (!indirect || (['either', 'both'].includes(indirect[1]) && identities.length !== 2)) continue;
      const universe = precedingMedicineUniverse(context, statement.start);
      if (universe && universe.length === identities.length && universe.every(name => identities.includes(name))) return;
    }
  }
  return 'unscoped-state-evidence';
}

/** These roles carry a supplied date/period, not a generic text or numeric value. */
export function temporalRole(role: GroupRole): boolean {
  return role.definition.kind === 'text' && (/(?:^|\.)(?:measuredWhen|when|timing|period|time|day|onset|mostRecent|requestedDate|serviceDate)$/.test(role.role)
    || /\b(?:date|timing|timecourse|period|duration)\b/i.test(role.definition.label));
}
const month = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)';
const amount = '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|a|an|a few|several|couple of)';
const calendar = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?|${month}\\.?(?: (?:\\d{4}|\\d{1,2}(?:st|nd|rd|th)?(?:[–—-]\\d{1,2})?(?:(?:,? | of )\\d{4})?))?|\\d{1,2}(?:st|nd|rd|th)? ${month}(?: \\d{4})?|\\d{4})`;
const relative = `(?:(?:last|past|next|this) (?:${amount} )?(?:days?|weeks?|months?|years?|summer|winter|spring|fall|autumn)|${amount} (?:days?|weeks?|months?|years?) (?:ago|earlier)|yesterday|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)`;
const clock = '(?:\\d{1,2}(?::\\d{2})? (?:am|pm)|noon|midnight|morning|afternoon|evening)';
const qualifier = '(?:(?:about|around|approximately|roughly|sometime in|early|late|mid|almost|over|at least|more than|less than|before|after|by|since) )?';
const atom = `${qualifier}(?:${calendar}|${relative}|${amount} (?:days?|weeks?|months?|years?)|${clock})`;
const event = '(?:before|after|during|since) (?:my )?(?:surgery|operation|pregnancy|hospital stay|hospitalization|hospitalisation|graduation)';
function completeTemporal(text: string): boolean {
  return exact(`${atom}|${event}|(?:from|between) ${atom} (?:to|through|until|and) ${atom}|${atom}(?: (?:or|to|through|until) ${atom})+`, text);
}
function measuredTemporalTail(text: string): string | undefined {
  const match = /^the scale read \d+(?:\.\d+)? (?:pounds?|lbs?|kilograms?|kg|stones?|st) (?:on |at )?(.+)$/.exec(text);
  return match && completeTemporal(match[1]) ? match[1] : undefined;
}
// A small complete recall carrier preserves separate identified day/time facts.
const food = '(?:(?:one|two|three|a|an) |a glass of )?[a-z]+';
function recallTemporal(text: string, role: string): string | undefined {
  const match = new RegExp(`^(?:(yesterday|today) (?:at (${clock}) )?|at (${clock}) )i had (${food}(?: and ${food})?)$`).exec(text);
  if (!match) return;
  // Opaque food atoms cannot consume a terminal from the temporal grammar.
  if (match[4].split(' and ').some(item => completeTemporal(item.replace(/^(?:(?:one|two|three|a|an) |a glass of )/, '')))) return;
  return role === 'day' ? match[1] : role === 'time' ? match[2] ?? match[3] : undefined;
}
/** A whole phrase owned by a closed carrier or exact single-target reply.
 * Unknown suffixes and alternatives cannot disappear through overlap matching. */
export function temporalCoverageRejection(
  context: AdaptiveContext, role: GroupRole, value: EvidenceSpan | null, lexical: boolean, statements: readonly SourceHandle[], topicId: string,
): string | undefined {
  if (!temporalRole(role) || !value) return;
  if (lexical) return 'temporal-lexical-selector';
  const owner = statements.find(statement => statement.start <= value.start && statement.end >= value.end);
  if (!owner) return 'temporal-meaning-not-covered';
  const quote = normalize(context.source.text.slice(value.start, value.end));
  const full = normalize(context.source.text).replace(/[.!]+$/, '');
  if (context.displayed?.topicId === topicId && context.displayed.targetPaths.length === 1 && context.displayed.targetPaths[0] === role.role
    && quote === full && completeTemporal(full)) return;
  const local = sentences(owner.text);
  if (local.length !== 1) return 'temporal-meaning-not-covered';
  const phrase = role.role === 'lastMeasuredWeight.measuredWhen' ? measuredTemporalTail(local[0]) : recallTemporal(local[0], role.role);
  if (phrase !== undefined && quote === phrase) return;
  return 'temporal-meaning-not-covered';
}
