/** Tier 1 (S1-0.1): a deliberately liberal, cheap lexical screen over every patient message.
 * A match never pauses the intake and never replaces the authored E-0.1 interruption; it only
 * queues a tier-2 model review. Negated, historical and family mentions are flagged on purpose:
 * the reviewer, not this list, decides. Synthetic demo only; not a validated triage classifier. */
export const safetyScreenVersion = 'S1-0.1';
export const safetyCategories = ['self-harm', 'medical-urgent', 'medication-substance', 'eating', 'abuse-safety', 'mental-distress'] as const;
export type SafetyCategory = typeof safetyCategories[number];

const lexicon: Record<SafetyCategory, RegExp> = {
  'self-harm': /\b(suicid\w*|kill(?:ing)? myself|end(?:ing)? (?:it all|my life|things)|(?:hurt|harm|cut|cutting|hurting|harming) myself|self[- ]?harm\w*|no (?:reason|point) (?:to|in) (?:live|living|going on)|better off (?:dead|without me)|(?:don't|do not) want to (?:live|be alive|be here|wake up)|wish i (?:was|were) dead|not (?:want|wanting) to be (?:alive|here)|take my (?:own )?life)/,
  'medical-urgent': /\b(chest (?:pain|pressure|tightness|hurts)|short(?:ness)? of breath|out of breath|can't (?:breathe|catch my breath)|cannot breathe|trouble breathing|(?:faint|fainted|fainting|passed out|passing out|blacked out)|seizure\w*|stroke|numb(?:ness)?|slurred|(?:vomit\w*|throwing up|coughing up) blood|blood in (?:my )?(?:stool|urine|pee|vomit)|black (?:stool|poop)|severe (?:pain|headache|bleeding|cramp\w*)|worst headache|heart (?:racing|pounding|attack)|palpitation\w*|high fever|can't (?:keep|hold) (?:food|anything|liquids|fluids|water) down|dehydrat\w*|confus(?:ed|ion)|swollen (?:throat|tongue|face)|throat (?:closing|swelling)|allergic reaction|anaphyla\w*|low blood sugar|hypoglyc\w*|sugar (?:is |was )?(?:over|above) [3-9]\d\d|ketoacidosis|emergency|911|urgent care)/,
  'medication-substance': /\b(overdos\w*|too many (?:pills|tablets|doses)|extra (?:dose|pill|shot|injection)|double(?:d)? (?:dose|up)|took (?:the )?wrong (?:pill|medicine|medication|dose)|poison\w*|drink(?:ing)? (?:a lot|heavily|every (?:day|night))|drunk|blackout drunk|high on|cocaine|meth\b|heroin|opioid\w*|fentanyl|pills? to (?:sleep|cope|forget)|stopped taking (?:my )?(?:medication|medicine|meds|insulin)|ran out of (?:my )?(?:medication|medicine|meds|insulin)|skip(?:ping|ped)? (?:my )?(?:insulin|medication|meds))/,
  eating: /\b((?:make|made|making) myself (?:sick|throw up|vomit)|throw(?:ing)? up after|purg\w*|binge\w*|laxative\w*|diet pills|starv\w*|(?:not|stopped|barely) eating|skip(?:ping)? (?:all )?meals|restrict\w*|fast(?:ing)? for days|afraid (?:of|to) eat|hate my body|disgusted (?:with|by) (?:myself|my body)|(?:lose|lost|losing) control (?:of|over|around) (?:food|eating)|compensat\w*|ate nothing)/,
  'abuse-safety': /\b((?:hits?|hurts?|beats?|chokes?|kicks?|pushes|slaps?) me|abus\w*|afraid of (?:my (?:partner|husband|wife|boyfriend|girlfriend|parent|family)|him|her|them)|not safe at home|unsafe at home|threaten\w*|domestic violence|forced me|controls? my (?:money|food|phone|medication))/,
  'mental-distress': /\b(hopeless\w*|worthless|can't (?:go on|cope|take (?:it|this) anymore)|panic attack\w*|depress\w*|overwhelm\w*|nothing (?:matters|to live for)|trapped|(?:a|such a) burden|desperate|crying all the time|can't stop crying|give up|giving up)/,
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
