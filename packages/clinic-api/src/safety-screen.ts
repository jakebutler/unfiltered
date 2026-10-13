/** Tier 1 (S1-0.1): a deliberately liberal, cheap lexical screen over every patient message.
 * A match never pauses the intake and never replaces the authored E-0.1 interruption; it only
 * queues a tier-2 model review. Negated, historical and family mentions are flagged on purpose:
 * the reviewer, not this list, decides. Synthetic demo only; not a validated triage classifier. */
import { safetyFloorHits, type EscalationRule, type SafetyScope } from './safety.js';

export const safetyScreenVersion = 'S1-0.2';
export const safetyCategories = ['self-harm', 'medical-urgent', 'medication-substance', 'eating', 'abuse-safety', 'mental-distress'] as const;
export type SafetyCategory = typeof safetyCategories[number];

const lexicon: Record<SafetyCategory, RegExp> = {
  'self-harm': /\b(think(?:ing)? about (?:dying|death|not being here)|(?:don'?t|dont|do not|not|never|no longer) (?:really |even )?wanna (?:live|be alive)|way out[^.]{0,30}disappear\w*|(?:want(?:ed)?|wanna|wish(?:ing)?) (?:to )?(?:die|disappear\w*|disapear\w*|not (?:exist|be (?:here|around|alive)|wake up))|(?:not|never) wak(?:e|ing) up|sleep forever|weren'?t (?:here|around)|not being (?:here|around)|(?:not|don'?t|dont) (?:want|wanna) to (?:be alive|live|exist|keep going)|not sure i want to keep going|point (?:of|in) (?:living|waking)|saving (?:up )?(?:my )?pills|(?:lined up|counting)[^.]{0,30}pills|pills[^.]{0,40}(?:counting|lined up|easiest|answer)|taking all of them|bought a (?:rope|gun)|(?:the|a) bridge|driv(?:e|ing) off the road|stepping in front|cutting (?:again|myself)|what i might do|trust myself|being done|feel done|life is over|unalive|\bkms\b|doing everyone a favou?r|suicid\w*|kill(?:ing)? myself|end(?:ing)? (?:it all|my life|things)|(?:hurt|harm|cut|cutting|hurting|harming) myself|self[- ]?harm\w*|no (?:reason|point) (?:to|in) (?:live|living|going on)|better off (?:dead|without me)|(?:don't|do not) want to (?:live|be alive|be here|wake up)|wish i (?:was|were) dead|not (?:want|wanting) to be (?:alive|here)|take my (?:own )?life)/,
  'medical-urgent': /\b((?:hard|difficult|trouble) (?:to )?(?:take a (?:full )?breath|breathing|speak)|can'?t (?:get|catch) my breath|chest (?:is |feels )?(?:tight|crushing|heavy)|pressure in my (?:jaw|chest)|(?:bleeding|cramps?)[^.]{0,20}(?:right now|now)|haven'?t (?:pee|peed|urinated)|pass(?:ed)? out|fading|dizz(?:y|iness)|faint\w*|(?:can'?t|cannot|barely|hard to|unable to|trouble|struggling to) (?:speak|talk|say|finish)[^.]{0,20}full sentences|heart (?:keeps )?skipping|chest (?:pain|pressure|tightness|hurts)|short(?:ness)? of breath|out of breath|can't (?:breathe|catch my breath)|cannot breathe|trouble breathing|(?:faint|fainted|fainting|passed out|passing out|blacked out)|seizure\w*|stroke|numb(?:ness)?|slurred|(?:vomit\w*|throwing up|coughing up) blood|blood in (?:my )?(?:stool|urine|pee|vomit)|black (?:stool|poop)|severe (?:pain|headache|bleeding|cramp\w*)|worst headache|heart (?:racing|pounding|attack)|palpitation\w*|high fever|can't (?:keep|hold) (?:food|anything|liquids|fluids|water) down|dehydrat\w*|confus(?:ed|ion)|swollen (?:throat|tongue|face)|throat (?:closing|swelling)|allergic reaction|anaphyla\w*|low blood sugar|hypoglyc\w*|sugar (?:is |was )?(?:over|above) [3-9]\d\d|ketoacidosis|emergency|911|urgent care)/,
  'medication-substance': /\b((?:\d+|four|five|six|seven|eight|ten|twelve) (?:beers|drinks|shots)|bottle of (?:wine|vodka|whiskey|rum)|(?:bottles?|glasses|drinks?|beers?|shots?)(?: of \w+)? (?:a|every|most|each) (?:night|day|nite)|(?:a|every|most) (?:night|nite)s?[^.]{0,20}(?:wine|vodka|beer|drink)|drink(?:ing)? like a fish|drinking from breakfast|booze|xanax|mix(?:ing|in)?[^.]{0,20}(?:with|w)[^.]{0,20}(?:pills|xanax|meds|booze)|(?:stop+ed|quit)(?: taking| takin)? (?:my |the )?(?:\w+ ){0,3}(?:pills|medication|medicine|meds|insulin)|(?:extra|more) (?:one|of my)|taking extra|more than the label|to+ many (?:pills|of my)|by mistake|phentermine|withdraw\w*|haven'?t had a drink|(?:can'?t|cant) stop drinking|sleeping pills|overdos\w*|too many (?:pills|tablets|doses)|extra (?:dose|pill|shot|injection)|double(?:d)? (?:dose|up)|took (?:the )?wrong (?:pill|medicine|medication|dose)|poison\w*|drink(?:ing)? (?:a lot|heavily|every (?:day|night))|drunk|blackout drunk|high on|cocaine|meth\b|heroin|opioid\w*|fentanyl|pills? to (?:sleep|cope|forget)|stopped taking (?:my )?(?:medication|medicine|meds|insulin)|ran out of (?:my )?(?:medication|medicine|meds|insulin)|skip(?:ping|ped)? (?:my )?(?:insulin|medication|meds))/,
  eating: /\b(made myself (?:do it|throw up|vomit|sick)|\d{3,4} calories|haven'?t eaten|(?:eating|ate|eat) (?:almost |next to )?nothing|nothing but coffee|puke|get (?:it )?(?:all )?back up|threw up (?:everything|what i ate)|underweight|(?:look|feel|am) fat|whole (?:box|pizza|pint|bag|cake)|crying in the bathroom|binging|bingeing|quit eating|(?:make|made|making) myself (?:sick|throw up|vomit)|throw(?:ing)? up after|purg\w*|binge\w*|laxative\w*|diet pills|starv\w*|(?:not|stopped|barely) eating|skip(?:ping)? (?:all )?meals|restrict\w*|fast(?:ing)? for days|afraid (?:of|to) eat|hate my body|disgusted (?:with|by) (?:myself|my body)|(?:lose|lost|losing) control (?:of|over|around) (?:food|eating)|compensat\w*|ate nothing)/,
  'abuse-safety': /\b(scared (?:of )?what (?:he|she|they)(?:'ll| will) do|shove[sd]? me|grabbed me|threw me|restraining order|scared (?:to go home|of (?:him|her|what he))|safer than home|showing up at (?:my|the) door|checks where i go|takes my phone|going to kill me|threatened me|(?:hits?|hurts?|beats?|chokes?|kicks?|pushes|slaps?) me|abus\w*|afraid of (?:my (?:partner|husband|wife|boyfriend|girlfriend|parent|family)|him|her|them)|not safe at home|unsafe at home|threaten\w*|domestic violence|forced me|controls? my (?:money|food|phone|medication))/,
  'mental-distress': /\b(no way out|nothing (?:will ever|ever) change|stopped caring|feel(?:ing)? (?:gray|grey|numb|done)|dying inside|nothin matters|disappointed to (?:still )?be here|i hate myself|hate myself after|failing at my (?:whole )?life|scared to go to sleep|hopeless\w*|worthless|can't (?:go on|cope|take (?:it|this) anymore)|panic attack\w*|depress\w*|overwhelm\w*|nothing (?:matters|to live for)|trapped|(?:a|such a) burden|desperate|crying all the time|can't stop crying|give up|giving up)/,
};

export interface SafetyScreen { version: typeof safetyScreenVersion; categories: SafetyCategory[]; terms: string[]; }

/** Returns every category whose lexicon matches, with the matched words (never the whole message). */
export function screenSafety(text: string): SafetyScreen | undefined {
  const value = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
  const hits = safetyCategories.flatMap(category => {
    const match = lexicon[category].exec(value);
    return match ? [{ category, term: match[0].trim().slice(0, 80) }] : [];
  });
  if (!hits.length) return;
  return { version: safetyScreenVersion, categories: hits.map(hit => hit.category), terms: [...new Set(hits.map(hit => hit.term))] };
}

const floorCategory: Record<EscalationRule, SafetyCategory> = { E01: 'medical-urgent', E02: 'medical-urgent', E03: 'medication-substance', E04: 'self-harm', E05: 'eating' };
export interface SafetySignalSeed extends SafetyScreen { floor?: { rule: EscalationRule; scope: Exclude<SafetyScope, 'direct'> }[]; }
/** What the model gate must look at: tier-1 hits plus floor hits the scope check downgraded.
 * Undefined when nothing is flagged, or when a direct hard stop pauses instead. */
export function safetySignalSeed(text: string): SafetySignalSeed | undefined {
  const hits = safetyFloorHits(text);
  if (hits.some(hit => hit.scope === 'direct')) return;
  const screen = screenSafety(text), scoped = hits.filter(hit => hit.scope !== 'direct');
  if (!screen && !scoped.length) return;
  return { version: safetyScreenVersion, categories: [...new Set([...(screen?.categories ?? []), ...scoped.map(hit => floorCategory[hit.rule])])], terms: [...new Set([...(screen?.terms ?? []), ...scoped.map(hit => hit.term)])],
    ...(scoped.length ? { floor: scoped.map(hit => ({ rule: hit.rule, scope: hit.scope as Exclude<SafetyScope, 'direct'> })) } : {}) };
}
