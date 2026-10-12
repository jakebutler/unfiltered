/** E-0.2 synthetic-demo safety floor, not a validated triage classifier.
 * Detection and decision are split: this deterministic floor pauses only explicit, current,
 * first-person emergencies; a scoped mention (negated, someone else's, historical, hypothetical,
 * a question, or media) is only *downgraded* to the model gate, never cleared here. */
export const escalationCopy = {
  E01: "This could need emergency help. If this is happening to you now, call 911 in the U.S. or your local emergency number now. Don't wait for a reply here. This fictional demo cannot provide emergency care or contact help for you.",
  E02: "This needs prompt medical attention. If this is happening to you now, contact a medical professional now; if you can't reach one, seek urgent medical care. If you feel seriously unwell or think this may be an emergency, call 911 in the U.S. or your local emergency number. Don't wait for a reply in this demo.",
  E03: "If you may have been exposed to something poisonous, taken an extra dose, or taken the wrong medicine, contact Poison Help now at 1-800-222-1222 in the U.S. If you have serious symptoms such as trouble breathing, collapse, or a seizure, call 911 in the U.S. or your local emergency number now. Outside the U.S., contact your local poison service. Don't wait for a reply in this demo.",
  E04: "I'm sorry you're going through this. If you might act on these thoughts now, have already hurt yourself, or are in immediate danger, call 911 in the U.S. or your local emergency number now. In the U.S., you can also call or text 988, or visit 988lifeline.org, for crisis support. This demo is not monitored for care, so please don't wait for a reply here.",
  E05: "Thank you for telling me. Concerns about eating deserve support. I can include what you've shared for both the medical clinician and dietitian to review; you don't need to give more detail here. If this is a real concern, please contact your health care professional rather than waiting for this demo.",
} as const;
export type EscalationRule = keyof typeof escalationCopy;
export const safetyVersion = "E-0.2" as const;

/** Hard stops: explicit wording only, in the E-0.1 precedence order. Anything softer is the screen's and the model gate's job. */
export const safetyRules: ReadonlyArray<{ id: EscalationRule; pattern: RegExp }> = [
  {
    id: "E01",
    pattern:
      /\b(?:can'?t breathe?|cannot breathe|struggling to breathe|(?:i'?m|i am|i think i'?m|i think i am) having a (?:heart attack|stroke)|medical emergency|(?:vomiting|throwing up|coughing up) blood|uncontrolled bleeding|(?:won'?t|will not) stop bleeding|(?:my )?chest (?:is|feels) (?:like it'?s being )?crush(?:ing|ed)|crushing (?:chest )?pain|severe (?:chest|abdominal|stomach|belly) pain|(?:chest|abdominal|stomach|belly) pain (?:is|was|feels) (?:so |really |very )?severe|(?:just|today|tonight) (?:fainted|passed out|collapsed)|(?:fainted|passed out|collapsed) (?:just now|today|tonight|this morning|a few minutes ago))/g,
  },
  {
    id: "E04",
    pattern:
      /\b(?:kill(?:ing)? my ?self|kms|end(?:ing)? (?:my (?:own )?life|it all)|take my (?:own )?life|suicid\w*|unalive my ?self|harm(?:ing)? my ?self|(?:want|wanting|going|gonna|plan(?:ning)?|thinking about|thoughts of|urges? to|may|might|will|about to) (?:to )?hurt(?:ing)? my ?self|(?:don'?t|do not) want to (?:live|be alive)|(?:want|wanna|going) to die)/g,
  },
  {
    id: "E03",
    pattern:
      /\b(?:overdos(?:e|ed|ing)|od'?d|(?:took|taken|swallowed|injected|had) (?:way |far )?too many (?:of my )?(?:pills|tablets|doses)|(?:took|taken|injected|gave my ?self) (?:an? |my )?(?:extra|double) (?:dose|shot|injection)|twice by (?:accident|mistake)|(?:took|taken|swallowed|injected) (?:the )?wrong (?:medicine|medication|pills?|dose)|swallowed (?:some |a |the )?(?:cleaner|bleach|poison|detergent))/g,
  },
  {
    id: "E02",
    pattern:
      /\b(?:(?:can'?t|cannot|unable to) keep (?:liquids|fluids|water|anything) down|(?:haven'?t|have not) (?:urinated|peed))/g,
  },
  { id: "E05", pattern: /\b(?:mak(?:e|ing) my ?self (?:throw up|vomit|sick)|purg(?:e|es|ing))\b/g },
];

/** NegEx-style scope cues, applied inside the clause that contains a hard-stop match. */
export const safetyScopeCues = {
  negated: /\b(?:no|not|never|dont|without|deny|denies|none|nor|no longer|free of|zero)\b|n't\b/g,
  otherPerson:
    /\b(?:he|she|they|his|her|their|him|them|someone|somebody|people|(?:my|a|our|his|her|their) (?:best |close |older |younger |little |big |ex-?)?(?:mom|mum|mother|dad|father|parents?|sister|brother|siblings?|son|daughter|kids?|child(?:ren)?|husband|wife|partner|boyfriend|girlfriend|friend|cousin|aunt|uncle|grand\w+|coworker|co-worker|neighbou?r|roommate|patient))\b/g,
  firstPerson: /\b(?:i|i'm|i've|i'd|i'll|me|myself)\b/g,
  historical:
    /\b(?:years? ago|decades? ago|last year|in the past|used to|when i was (?:a |in )?(?:\d+|kid|teen|teenager|child|younger|little|high school|school|college)|in a long time|(?:last|past) (?:month|year|summer|winter|spring|fall)|months ago|as a (?:kid|teen|teenager|child)|in (?:high school|college)|back (?:in|then)|a long time ago|long ago|history of|previously|in my (?:teens|twenties|20s))\b/,
  current:
    /\b(?:now|right now|today|tonight|currently|again|still|lately|recently|this (?:week|morning|evening|afternoon)|these days|anymore|just)\b/,
  hypothetical: /\b(?:if|what if|hypothetical(?:ly)?|in case|suppose|supposing|imagine)\b/,
  media: /\b(?:movie|film|show|book|song|tv|series|novel|article|news|podcast|character)\b/,
} as const;
export type SafetyScope = "direct" | "negated" | "other-person" | "historical" | "hypothetical" | "question" | "media";
export interface SafetyFloorHit { rule: EscalationRule; scope: SafetyScope; term: string; }

const clauseBreak = /[.!?;\n]|\bbut\b|\bthough\b|\balthough\b/g;
function clauseAround(value: string, start: number, end: number): { before: string; clause: string; after: string } {
  let from = 0, to = value.length;
  for (const match of value.matchAll(clauseBreak)) {
    const at = match.index!;
    if (at + match[0].length <= start) from = at + match[0].length;
    else if (at >= end) { to = at + (match[0] === "?" ? 1 : 0); break; }
  }
  return { before: value.slice(from, start), clause: value.slice(from, to), after: value.slice(end, to) };
}
/** Position just after the last match of a global cue in `text`, or -1. */
function lastCue(cue: RegExp, text: string): number {
  let at = -1;
  for (const match of text.matchAll(cue)) at = match.index! + match[0].length;
  return at;
}
function scopeOf(value: string, start: number, end: number): SafetyScope {
  const { before, clause } = clauseAround(value, start, end);
  const near = before.split(/\s+/).filter(Boolean).slice(-6).join(" ");
  // A cue only scopes the hit when the patient has not restarted as the subject after it ("I told my husband I want to...").
  const restart = lastCue(safetyScopeCues.firstPerson, near);
  const scoped = (cue: RegExp) => { const at = lastCue(cue, near); return at >= 0 && restart < at; };
  if (scoped(safetyScopeCues.negated)) return "negated";
  if (scoped(safetyScopeCues.otherPerson)) return "other-person";
  // "...last year, still think about it": the time cue covers the sentence; "now"-type cues only count in the hit's own phrase.
  const phrase = clause.slice(before.lastIndexOf(",") + 1).split(",")[0];
  if (safetyScopeCues.historical.test(clause) && !safetyScopeCues.current.test(phrase)) return "historical";
  if (safetyScopeCues.hypothetical.test(clause)) return "hypothetical";
  if (clause.trimEnd().endsWith("?")) return "question";
  if (safetyScopeCues.media.test(clause)) return "media";
  return "direct";
}
const normalize = (text: string) => text.toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, " ");

/** Every hard-stop mention with its scope. Only "direct" hits pause; the rest go to the model gate. */
export function safetyFloorHits(text: string): SafetyFloorHit[] {
  const value = normalize(text), hits: SafetyFloorHit[] = [];
  for (const rule of safetyRules)
    for (const match of value.matchAll(rule.pattern))
      hits.push({ rule: rule.id, scope: scopeOf(value, match.index!, match.index! + match[0].length), term: match[0].trim().slice(0, 80) });
  return hits;
}
export function escalation(text: string): EscalationRule | undefined {
  return safetyFloorHits(text).find((hit) => hit.scope === "direct")?.rule;
}

/** The decision contract of the model gate (protocol safety-gate-v1). Prompt wording is corpus-gated, not pinned here. */
export const safetyGateContract = {
  protocol: "safety-gate-v1",
  runsWhen: "tier-1 screen or a scoped floor hit flags a patient message; in parallel with interpretation, before the next question",
  actions: { imminent: "pause", high: "pause", moderate: "clinician-review", low: "clinician-review", none: "cleared" },
  cleared: "only an explicit concern=false with level none",
  failSafe: "self-harm, medical-urgent or medication-substance flags show the authored help copy as a non-blocking notice and go to clinician review; nothing fails to cleared",
  pauseRule: { "self-harm": "E04", "medication-substance": "E03", "eating-only": "E05", otherwise: "E01" },
} as const;

/** Stable regex source, independent of bundler/transpiler output. */
export const safetyDefinition = {
  version: safetyVersion,
  copies: escalationCopy,
  rules: safetyRules.map((rule) => ({ id: rule.id, pattern: rule.pattern.source })),
  scope: Object.fromEntries(Object.entries(safetyScopeCues).map(([key, pattern]) => [key, pattern.source])),
  scopeWindow: "clause bounded by . ! ? ; newline but though although; negation and other-person cues within the 6 preceding words unless the patient restarts as subject",
  scopePolicy: "a scoped hit is downgraded to the model gate and never cleared by the floor",
  gate: safetyGateContract,
  interruptionPrecedesCollection: true,
} as const;
