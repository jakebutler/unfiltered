/** Answer specificity (SP-0.1): one authored mechanism for every field where a patient can give a real but
 * non-specific answer ("a couple of pills for my heart", "heart stuff runs in my family", "a while ago").
 * Contracts say what each field needs; assessment is deterministic over the patient's own words (an optional
 * reference lookup only attaches a code or offers a spelling question); follow-ups are authored templates that quote the patient.
 * Nothing here diagnoses, suggests a drug, or replaces the patient's words. */

export type SpecificityKind = "entity" | "category" | "quantity" | "frequency" | "time" | "relation";
export type SpecificityDomain = "medication" | "condition" | "procedure" | "allergen" | "program" | "clinician" | "symptom" | "food" | "drink" | "sleep" | "substance" | "activity" | "relative" | "date";
/** "specific" is enough; every other level is a visible "needs detail" gap until the patient adds detail. */
export type SpecificityLevel = "specific" | "descriptive" | "category" | "approximate" | "unanchored";
export interface SpecificityContract {
  /** Collection fields use "list.field" (any item); scalars use the slot id. */
  readonly topicId: string;
  readonly path: string;
  readonly kind: SpecificityKind;
  readonly domain: SpecificityDomain;
  readonly template: keyof typeof specificityTemplates;
  /** Shown to staff and in review when the detail is still missing. */
  readonly missing: string;
}

export const specificityContracts: readonly SpecificityContract[] = [
  { topicId: "Q02", path: "concern", kind: "category", domain: "symptom", template: "detail-symptom", missing: "What the symptom is" },
  { topicId: "Q02", path: "onset", kind: "time", domain: "date", template: "time", missing: "When it started" },
  { topicId: "Q03", path: "majorChanges.timing", kind: "time", domain: "date", template: "time", missing: "When the change happened" },
  { topicId: "Q04", path: "lastMeasuredWeight.measuredWhen", kind: "time", domain: "date", template: "time", missing: "When the weight was measured" },
  { topicId: "Q05", path: "approaches.approach", kind: "entity", domain: "program", template: "identity-program", missing: "Name of the program, diet or medicine" },
  { topicId: "Q05", path: "approaches.period", kind: "time", domain: "date", template: "time", missing: "When and for how long" },
  { topicId: "Q06", path: "reportedConditions.term", kind: "entity", domain: "condition", template: "identity-condition", missing: "Which condition" },
  { topicId: "Q07", path: "events.event", kind: "entity", domain: "procedure", template: "identity-procedure", missing: "Which procedure or reason for the stay" },
  { topicId: "Q07", path: "events.when", kind: "time", domain: "date", template: "time", missing: "When it happened" },
  { topicId: "Q08", path: "medicines.name", kind: "entity", domain: "medication", template: "identity-medication", missing: "Name of the medicine" },
  { topicId: "Q08", path: "medicines.actualUse", kind: "frequency", domain: "medication", template: "frequency-medication", missing: "How often it is taken" },
  { topicId: "Q09", path: "reactions.substance", kind: "entity", domain: "allergen", template: "identity-allergen", missing: "Name of the medicine or substance" },
  { topicId: "Q10", path: "familyHistory.condition", kind: "entity", domain: "condition", template: "identity-family-condition", missing: "Which condition" },
  { topicId: "Q10", path: "familyHistory.relationship", kind: "relation", domain: "relative", template: "relation", missing: "Which relative" },
  { topicId: "Q11", path: "occasions.foods", kind: "category", domain: "food", template: "detail-food", missing: "What the food was" },
  { topicId: "Q11", path: "occasions.drinks", kind: "category", domain: "drink", template: "detail-drink", missing: "What the drink was" },
  { topicId: "Q11", path: "occasions.foodAmounts", kind: "quantity", domain: "food", template: "quantity", missing: "About how much" },
  { topicId: "Q11", path: "occasions.drinkAmounts", kind: "quantity", domain: "drink", template: "quantity", missing: "About how much" },
  { topicId: "Q14", path: "frequency", kind: "frequency", domain: "activity", template: "frequency-activity", missing: "How often and for how long" },
  { topicId: "Q15", path: "quality", kind: "category", domain: "sleep", template: "detail-sleep", missing: "What happens with sleep" },
  { topicId: "Q17", path: "substances.frequencyAmount", kind: "frequency", domain: "substance", template: "frequency-substance", missing: "How often and how much" },
  { topicId: "Q19", path: "clinicians.owner", kind: "entity", domain: "clinician", template: "identity-clinician", missing: "Name of the clinician or practice" },
];

/** Authored follow-up wording. {quote} is the patient's own words for that field, never model text. */
export const specificityTemplates = {
  "identity-medication": "You mentioned “{quote}”. Do you know the name of that medicine? It's printed on the label. It's fine to say you don't know, or that you'll bring it to your visit.",
  "identity-condition": "You mentioned “{quote}”. Do you know what the condition is called, or what you were told about it? It's fine to say you don't know.",
  "identity-family-condition": "You mentioned “{quote}”. Do you know what condition it was, as best you know? It's fine to say you don't know.",
  "identity-procedure": "You mentioned “{quote}”. Do you know what the procedure was called, or what it was for? It's fine to say you don't know.",
  "identity-allergen": "You mentioned “{quote}”. Do you know the name of the medicine or substance? It's fine to say you don't know.",
  "identity-program": "You mentioned “{quote}”. Do you remember the name of the program, diet or medicine? It's fine to say you don't know.",
  "identity-clinician": "You mentioned “{quote}”. What is their name, or the name of the practice? It's fine to say you don't know.",
  "detail-symptom": "You mentioned “{quote}”. Could you describe what you notice? It's fine to say you're not sure.",
  "detail-food": "You mentioned “{quote}”. What did you have? An everyday description is fine.",
  "detail-drink": "You mentioned “{quote}”. What did you drink? An everyday description is fine.",
  "detail-sleep": "You mentioned “{quote}”. What happens with your sleep? For example, trouble falling asleep, waking in the night, or something else.",
  relation: "You mentioned “{quote}”. Which relative was that, as best you know?",
  time: "You mentioned “{quote}”. Roughly when was that? A year, or how old you were, is fine.",
  "frequency-medication": "You mentioned “{quote}”. About how often do you take it? It's fine to say it varies.",
  "frequency-activity": "You mentioned “{quote}”. About how many days a week, and for how long each time?",
  "frequency-substance": "You mentioned “{quote}”. About how often, and how much at a time? Your own units are fine.",
  quantity: "You mentioned “{quote}”. About how much was that? An everyday description, like a cup or a handful, is fine.",
  "spelling-medication": "Did you mean “{candidate}”? If not, please spell the name as it appears on the label.",
  "spelling-condition": "Did you mean “{candidate}”? If not, that's fine; tell me in your own words.",
} as const;

/** At most this many follow-ups per field on one item, and per topic; one per turn. */
export const specificityBudget = { perField: 2, perTopic: 4, perTurn: 1 } as const;

const words = (text: string) => text.toLowerCase().replace(/[’‘`´]/g, "'").match(/[a-z0-9']+/g) ?? [];
/** Generic nouns that name a kind of thing without saying which one. */
const genericNouns = new Set("pill pills med meds medicine medicines medication medications tablet tablets capsule capsules drug drugs shot shots injection injections jab jabs stuff thing things something someone somebody product products vitamin vitamins supplement supplements cream creams drop drops spray sprays inhaler patch patches problem problems issue issues trouble troubles condition conditions illness sickness disorder procedure procedures surgery surgeries operation operations op test tests diet diets program programs plan plans app apps food foods snack snacks drink drinks beverage beverages juice treat treats junk meal meals doctor doctors doc specialist specialists clinic practice nurse provider kind kinds type types sort sorts one ones bit hospital hospitals stay stays visit visits admission er emergency".split(" "));
/** Body and system words: they say what a thing is ABOUT, not which condition or procedure it is. */
const bodyWords = new Set("heart cardiac blood sugar cholesterol thyroid joint joints stomach tummy belly gut skin lung lungs breathing chest kidney kidneys liver bladder bowel bowels back knee knees hip hips head eye eyes ear ears hormone hormones nerve nerves female women's mental weight bone bones foot feet leg legs arm arms shoulder neck spine prostate colon pressure muscle muscles stool memory".split(" "));
/** Purpose, class and timing words for medicines and other products: what it is FOR, not which one it is. */
const purposeWords = new Set([...bodyWords, ..."pressure bp diabetes diabetic arthritis pain pains ache aches sleep sleeping water acid reflux heartburn allergy allergies anxiety depression mood weight diet appetite infection antibiotic antibiotics painkiller painkillers steroid steroids statin statins diuretic diuretics thinner thinners beta blocker blockers inhibitor inhibitors birth control contraceptive insulin antidepressant antidepressants antihistamine antihistamines antacid antacids laxative laxatives sedative sedatives stimulant stimulants anticoagulant anticoagulants nsaid nsaids opioid opioids probiotic probiotics prebiotic prebiotics migraine migraines headache headaches nausea cold colds flu cough constipation diarrhea cramps period periods menopause acne gout asthma adhd hot flashes loss relief reliever relievers lowering otc counter prescription prescribed generic brand herbal natural over morning evening night nighttime bedtime daily day weekly".split(" ")]);
/** Broad condition families: named alone ("cancer stuff") they say which kind of thing, not which condition. A body
 * site or other qualifier makes them specific ("breast cancer"). */
const broadConditionWords = new Set("cancer cancers tumor tumors tumour tumours growth growths lump lumps mass disease diseases infection infections".split(" "));
/** How a product looks or comes: description, not identity ("the little white one", "gummies"). */
const descriptorWords = new Set("white pink blue yellow orange red green purple brown clear round oval square tiny chalky chewable chewy liquid powder powdered lozenge lozenges gummy gummies softgel softgels gel gels cap caps tab tabs coated nasal oral topical inhaled injectable eye ear".split(" "));
/** Grammar and quantity words that carry no identity. */
const fillerWords = new Set("a an the my his her their our your some any couple few several many lots lot of for to with and or in on at from by about it its that this these those i i'm i've me take took taking use used using have had has got been be is are was were done did do try tried trying just like kind sort little small big two three one four five also too other another kinda sorta while ago back minor major quick simple routine outpatient elective regular usual old new said says told tells think thinks thought called mentioned believe guess maybe probably possibly".split(" "));
/** Evaluative words: how the patient feels about something, never which condition it is ("my heart is bad"). */
const evaluativeWords = new Set("bad worse weak off funny weird wrong right good great fine okay ok poor not acting up playing up".split(" "));
/** About a clinician rather than naming them ("my doctor is great", "my GP handles that"). */
const clinicianTalk = new Set("great good nice fine wonderful amazing helpful kind lovely awesome handles handle manages manage sees see treats treat takes care looks after deals mostly usually does".split(" "));
const vagueQuantity = /\b(?:some|a (?:bit|little|lot|few|couple)|lots|plenty|a bunch|several|not (?:much|a lot|a whole lot)|a whole lot|loads?|tons?|too much|enough|(?:a )?(?:small|large|big|good|fair|decent|normal|huge|tiny) (?:amount|portion|serving|helping)s?)\b/i;
const measuredQuantity = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|half|quarter|a (?:cup|glass|mug|bowl|plate|slice|piece|handful|can|bottle|pint|serving|spoonful|tablespoon|teaspoon|sandwich|bar|bag|box|scoop)|cups?|glass(?:es)?|mugs?|bowls?|plates?|slices?|pieces?|handfuls?|cans?|bottles?|pints?|servings?|spoons?|ounces?|oz|grams?|g|ml|liters?|litres?|portion|small|medium|large|whole|double|single)\b/i;
const vagueFrequency = /\b(?:sometimes|occasionally|now and (?:then|again)|here and there|on and off|off and on|every so often|(?:every )?once in a (?:while|blue moon)|every now and (?:then|again)|whenever i feel like it|from time to time|when(?:ever)? i (?:can|remember|feel like it|get (?:a )?chance)|not (?:very |that )?often|rarely|a lot|socially|regularly|irregularly|depends|it varies|varies|on occasion)\b/i;
/** A number counts for frequency only with a unit of time ("2 times a day", "every 8 hours", "3 days a week", "at 9 pm"). */
const definiteFrequency = /\b\d+\s*(?:x|times?)\b|\b\d+\s*(?:days?|nights?|mornings?|evenings?)\s*(?:a|per|each|every)\s*(?:week|month)\b|\bevery\s+\d+\s*(?:hours?|hrs?|days?|weeks?)\b|\b\d+\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:once|twice|three times|daily|every ?day|each day|every (?:morning|night|evening|other day|week|weekend|day)|nightly|weekly|monthly|weekdays|weekends|(?:in the |each |every )?(?:morning|evening|night)s?|at (?:night|bedtime|breakfast|lunch|dinner)|with (?:breakfast|lunch|dinner|meals?)|before bed|bedtime|as needed|when needed|prn|(?:one|two|three|four|five|six|seven) (?:days?|times|nights?)|never|none|most days|most nights|(?:a|an|per|each|every) (?:day|week|month)|(?:on |every )?(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|weekends?|weeknights?))\b/i;
const vagueTime = /\b(?:lately|these days|nowadays|for (?:a while|some time|years|ages)|over the years|the other day|a while(?: ago| back)?|some time ago|a long time ago|long ago|ages ago|years ago|way back|back then|in the past|a few years(?: ago)?|a couple (?:of )?years(?: ago)?|at some point|once|before|previously|recently|not long ago|i forget when|sometime)\b/i;
/** A number anchors a time only as a year, an age, a date or a span ago ("2019", "at 30", "3/2021", "2 years ago"). */
const anchoredTime = /\b(?:19|20)\d{2}\b|\b(?:at|age|aged|when i was)\s+\d{1,3}\b|\b\d{1,2}\/\d{1,4}\b|\b\d+\s*(?:days?|weeks?|months?|years?)\s+ago\b|\b(?:last|this|next) (?:week|month|year|spring|summer|fall|autumn|winter|january|february|march|april|may|june|july|august|september|october|november|december)|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:yesterday|today|this morning|in (?:high school|college|my (?:teens|twenties|thirties|forties|fifties|sixties)))\b|\b(?:when i was|at age|aged|as a (?:kid|child|teen|teenager))\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty) (?:days?|weeks?|months?|years?) ago\b|\bsince (?:birth|childhood|the|my|i)\b/i;
/** Some reference to time or an event; an answer with none ("lost 20 pounds") does not say when. */
const timeReference = /\b(?:after|before|when|during|since|until|around|while|ago|then|last|first|days?|weeks?|months?|years?|spring|summer|winter|fall|autumn|christmas|thanksgiving|easter|holidays?|birthday|wedding|pregnan\w*|born|birth|retire\w*|graduat\w*|school|college|covid|pandemic|teens?|twenties|thirties|forties|fifties|kid|child|baby)\b/i;
const specificRelation = /\b(?:mom|mum|mother|dad|father|parents?|sister|brother|siblings?|son|daughter|kids?|children|grand(?:ma|pa|mother|father|parents?|mom|dad)|aunt|uncle|cousin|niece|nephew|half[- ](?:brother|sister)|twin|maternal|paternal)\b/i;
const vagueCategory = /\b(?:issues?|problems?|stuff|things?|trouble|not (?:feeling )?(?:great|good|well|right)|feeling (?:off|bad|lousy|crappy|unwell|rough|blah)|bad(?:ly)?|poor(?:ly)?|off|funny|weird|terrible|awful|rough|so-so|meh|something|whatever|junk|snacks?|food|drinks?|a drink|a meal|leftovers|takeout|take-out|don'?t (?:sleep|feel) (?:well|good|great))\b/i;
/** Words of a general description that add no detail of their own. */
const categoryNoise = new Set("issue issues problem problems stuff thing things trouble not great good well right bad badly poor poorly off funny weird terrible awful rough so meh something whatever junk snack snacks food drink drinks meal leftovers takeout don't dont doesn't feel feeling sleep sleeping really very kind of lately much".split(" "));
/** Roles and specialties: an answer made only of these points at someone (my doctor, a nurse practitioner) without naming them. */
const clinicianRoles = new Set("doctor doctors doc dr gp pcp specialist specialists nurse nurses practitioner practitioners np pa physician physicians assistant provider providers clinic clinics practice office team hospital center centre therapist counselor counsellor dietitian dietician nutritionist coach trainer cardiologist endocrinologist psychiatrist psychologist dermatologist gynecologist gynaecologist obgyn ob gyn gyno surgeon neurologist rheumatologist gastroenterologist pulmonologist nephrologist urologist podiatrist chiropractor someone somebody person people family primary care regular usual general heart foot eye skin lung kidney stomach bone sleep diabetes weight mental health".split(" "));
/** Hedge nouns: "memory issues", "heart stuff" name an area, not a condition, unless a known condition name is also present. */
const hedgeNouns = /\b(?:issues?|problems?|stuff|things?|trouble|troubles|concerns?|conditions?)\b/i;
/** Agent nouns after a purpose word describe what a product does ("acid reducer", "stool softener", "appetite suppressant"). */
const agentNoun = /(?:ers?|ants?|ives?)$/;

export interface ReferenceLookup {
  /** Exact or synonym match for a named entity in its domain, or a close spelling of one. identity: the patient's identifying words. */
  (domain: SpecificityDomain, text: string, identity: readonly string[]): { match?: { system: string; code: string; display: string; kind: "exact" | "synonym" }; spelling?: { system: string; code: string; display: string } } | undefined;
}
export interface SpecificityAssessment { level: SpecificityLevel; reason: string; match?: { system: string; code: string; display: string; kind: "exact" | "synonym" }; spelling?: { system: string; code: string; display: string }; }

/** Words left after removing generic nouns, purpose words and grammar, and any "for ..." purpose clause. */
function identityWords(value: string, domain: SpecificityDomain): string[] {
  const product = ["medication", "allergen", "program"].includes(domain), about = product ? purposeWords : bodyWords;
  // Purpose ("for my heart") and acquisition ("I got at CVS") clauses describe a product, they never name it.
  const text = product ? value.toLowerCase().replace(/\b(?:for|to help with|to treat|that helps with)\b[^;,.]*/g, " ").replace(/\b(?:i |that i |which i )?(?:got|get|gets|bought|buy|picked up|pick up|ordered|order|filled)\b[^;,.]*/g, " ").replace(/\b(?:from|at) (?:the )?(?:pharmacy|drugstore|drug store|store|cvs|walgreens|rite aid|costco|walmart|target|kroger|amazon|online)\b/g, " ") : value.toLowerCase();
  const all = words(text);
  return all.filter((word, index) => !genericNouns.has(word) && !about.has(word) && !fillerWords.has(word) && !(product && descriptorWords.has(word)) && !(product && agentNoun.test(word) && index > 0 && about.has(all[index - 1]!)) && !/^\d+(?:mg|mcg|ml|g|iu|units?)?$/.test(word) && !["mg", "mcg", "ml", "iu", "unit", "units"].includes(word));
}

/** Deterministic: the patient's words decide; a lookup can only confirm a named entity or offer its spelling. */
export function assessSpecificity(contract: Pick<SpecificityContract, "kind" | "domain">, value: string, lookup?: ReferenceLookup): SpecificityAssessment {
  const text = value.trim();
  switch (contract.kind) {
    case "entity": {
      if (contract.domain === "clinician") return words(text).every((word) => clinicianRoles.has(word) || fillerWords.has(word) || clinicianTalk.has(word)) ? { level: "category", reason: "points-at-role" } : { level: "specific", reason: "named" };
      // The patient's words decide the level; the lookup can only attach a code or offer a spelling question.
      const left = identityWords(text, contract.domain);
      if (!left.length) return { level: contract.domain === "condition" ? "category" : "descriptive", reason: "no-identifying-name" };
      if (contract.domain === "condition" && left.every((word) => broadConditionWords.has(word)) && !words(text).some((word) => bodyWords.has(word))) return { level: "category", reason: "broad-condition" };
      const found = lookup?.(contract.domain, text, left);
      if (found?.match) return { level: "specific", reason: "reference-match", match: found.match };
      if (contract.domain === "condition" && (hedgeNouns.test(text) || left.every((word) => evaluativeWords.has(word)))) return { level: "category", reason: "general-area" };
      if (found?.spelling) return { level: "specific", reason: "possible-spelling", spelling: found.spelling };
      return { level: "specific", reason: "named-unverified" };
    }
    case "category": {
      // General wording with at most one other content word left ("stomach issues", "I don't sleep well", "snacks").
      const left = identityWords(text, contract.domain).filter((word) => !categoryNoise.has(word));
      return vagueCategory.test(text) && left.length <= 1 && !measuredQuantity.test(text) ? { level: "category", reason: "general-description" } : { level: "specific", reason: "described" };
    }
    case "quantity": {
      // "A small amount", "not a whole lot": size words inside a vague phrase do not measure anything.
      const rest = text.replace(new RegExp(vagueQuantity.source, "gi"), " ");
      return measuredQuantity.test(rest) ? { level: "specific", reason: "measured" } : vagueQuantity.test(text) ? { level: "approximate", reason: "vague-amount" } : { level: "specific", reason: "described" };
    }
    case "frequency": {
      // Idioms such as "once in a while" contain a definite word; only what is left after them can be definite.
      const rest = text.replace(new RegExp(vagueFrequency.source, "gi"), " ");
      return definiteFrequency.test(rest) ? { level: "specific", reason: "definite-frequency" } : vagueFrequency.test(text) || vagueQuantity.test(text) || /^\W*whenever\W*$/i.test(text) ? { level: "approximate", reason: "vague-frequency" } : { level: "specific", reason: "described" };
    }
    case "time":
      return anchoredTime.test(text) ? { level: "specific", reason: "anchored" } : vagueTime.test(text) ? { level: "unanchored", reason: "unanchored-time" } : timeReference.test(text) ? { level: "specific", reason: "described" } : /^\W*(?:no(?! idea)\b|none|never|nothing|not applicable|n\/a|(?:it )?(?:doesn'?t|does not) apply)/i.test(text) ? { level: "specific", reason: "not-applicable" } : { level: "unanchored", reason: "no-time-reference" };
    case "relation":
      return specificRelation.test(text) ? { level: "specific", reason: "relative-named" } : { level: "category", reason: "relative-unnamed" };
  }
}

/** Contract for a concrete answer path ("medicines[x7].name" → "medicines.name"). */
export function specificityContract(topicId: string, path: string): SpecificityContract | undefined {
  const generic = path.replace(/\[[^\]]+\]/g, "");
  return specificityContracts.find((contract) => contract.topicId === topicId && contract.path === generic);
}
export function specificityQuote(value: string) {
  const clean = value.trim().replace(/\s+/g, " ").replace(/[“”"]/g, "'");
  return clean.length <= 60 ? clean : `${clean.slice(0, 57).replace(/\s+\S*$/, "")}…`;
}
export function specificityQuestion(contract: SpecificityContract, value: string, spelling?: string): string {
  if (spelling) return specificityTemplates[contract.domain === "medication" ? "spelling-medication" : "spelling-condition"].replace("{candidate}", spelling);
  return specificityTemplates[contract.template].replace("{quote}", specificityQuote(value));
}
/** Only a plain yes confirms a suggested spelling; "yes, but I'm not sure" does not. */
export const specificityPlainYes = /^\s*(?:yes|yeah|yep|yup|correct|right|exactly|uh[- ]?huh|mm[- ]?hmm)(?:[\s,.!]+(?:yes|that'?s (?:it|right|correct|the one)|that one|it is|correct|right))*[\s.!]*$/i;
const plainNo = /^\s*(?:no|nope|nah|not quite|wrong|that'?s not it)(?:[\s,.!]+(?:no|not that|that'?s not it|it'?s not))*[\s.!]*$/i;
/** Whether a reply only settles a follow-up (a plain yes or no to a spelling, or a short "I don't know"/"I'll bring it"),
 * so it is not an unplaced answer. Anything longer carries content the interpreter must place. */
export function specificityReplySettles(spelling: boolean, text: string): boolean {
  if (spelling) return specificityPlainYes.test(text) || plainNo.test(text);
  return (text.match(/\S+/g)?.length ?? 0) <= 12 && Object.values(specificityTerminal).some((pattern) => pattern.test(text));
}
/** A reply that ends the follow-ups for that field without adding detail. */
export const specificityTerminal = {
  "will-provide": /\b(?:(?:i'?ll|i will|i can|let me|i could|gonna|going to) (?:bring|check|look|find|get|send|grab|ask|photograph|take a (?:photo|picture))|bring (?:it|them|the (?:bottles?|box|label|list))|(?:on|at) (?:my|the) (?:visit|appointment)|look (?:it|them) up|check the (?:bottle|label|box))\b/i,
  unknown: /\b(?:(?:i )?(?:don'?t|do not|dont) (?:know|remember|recall)|not sure|no idea|can'?t (?:remember|recall)|no clue|forgot|i forget|unsure)\b/i,
  declined: /\b(?:rather not|prefer not|(?:don'?t|do not) want to (?:say|share|talk)|skip|pass|not comfortable)\b/i,
} as const;

/** Stable source text for the native definition binding (D1). */
export const specificityDefinition = {
  version: "SP-0.1",
  contracts: specificityContracts,
  templates: specificityTemplates,
  budget: specificityBudget,
  lexicons: {
    genericNouns: [...genericNouns].sort(),
    bodyWords: [...bodyWords].sort(),
    purposeWords: [...purposeWords].sort(),
    fillerWords: [...fillerWords].sort(),
    descriptorWords: [...descriptorWords].sort(),
    broadConditionWords: [...broadConditionWords].sort(),
    vagueQuantity: vagueQuantity.source, measuredQuantity: measuredQuantity.source,
    vagueFrequency: vagueFrequency.source, definiteFrequency: definiteFrequency.source,
    vagueTime: vagueTime.source, anchoredTime: anchoredTime.source,
    specificRelation: specificRelation.source, vagueCategory: vagueCategory.source, categoryNoise: [...categoryNoise].sort(), clinicianRoles: [...clinicianRoles].sort(), hedgeNouns: hedgeNouns.source, agentNoun: agentNoun.source,
  },
  terminal: Object.fromEntries(Object.entries(specificityTerminal).map(([key, pattern]) => [key, pattern.source])),
  policy: "patient words are kept verbatim; a reference match never replaces them; codes are attached only to exact matches or patient-confirmed spellings; a vague answer is a visible needs-detail gap and never complete",
} as const;
