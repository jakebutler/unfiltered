/** Offline reference lookup for answer specificity (retrieve-then-interpret, D5). Exact names only become matches;
 * a close spelling is only ever offered back to the patient as a question. No text leaves the process. */
import { medicationRelease, medicationRows } from './medications.generated.js';
import { conditionRelease, conditionTerms } from './conditions.generated.js';

export const referenceRelease = { medications: medicationRelease, conditions: conditionRelease } as const;
export interface ReferenceConcept { system: string; code: string; display: string; }
export interface ReferenceMatch extends ReferenceConcept { kind: 'exact' | 'synonym'; }
export type ReferenceDomain = 'medication' | 'condition';
export interface ReferenceResult { match?: ReferenceMatch; spelling?: ReferenceConcept; }

export const rxnormSystem = 'http://www.nlm.nih.gov/research/umls/rxnorm';
export const icd10cmSystem = 'http://hl7.org/fhir/sid/icd-10-cm';

export const normalizeReference = (text: string) => text.toLowerCase().replace(/[’‘`´]/g, "'").replace(/'s\b/g, 's').replace(/[^a-z0-9']+/g, ' ').replace(/'/g, '').trim();
/** Drug and product names that are also everyday words; they never match on their own. */
const everyday = new Set('air align amber bran dragon halls julie kirsty nikita perform pronto react rid silver soma sojourn tandem thrive water oxygen helium propane butane ethanol acetone glucose sucrose lactose starch talc gelatin pectin beeswax shellac pumice sodium mica urea inova prax pretz tobi ella dotti muse compro propel sps vizz twilite dok ery dilt agar indigo rosin naphtha perlite silicon cocaine opium hemp heptane styrene tylosin pinene nerol citral menthol camphor phenol cresol creosol iodine lindane'.split(' '));
/** Lay names for common products that RxNorm lists under another name. */
const medicationSynonyms: Record<string, string> = { b12: 'vitamin b12', 'vit d': 'vitamin d', 'vitamin d3': 'cholecalciferol', d3: 'cholecalciferol', 'baby aspirin': 'aspirin', paracetamol: 'acetaminophen', 'fish oil': 'omega-3 fatty acids', 'omega 3': 'omega-3 fatty acids', 'omega 3s': 'omega-3 fatty acids', 'apple cider vinegar': 'apple cider vinegar' };

interface Entry { concept: ReferenceConcept; kind: 'exact' | 'synonym'; plain?: boolean; }
interface Index { names: Map<string, Entry>; tokens: Map<string, Set<string>>; maxWords: number; ambiguous: Set<string>; }
let indexes: Record<ReferenceDomain, Index> | undefined;

function add(index: Index, name: string, entry: Entry) {
  const key = normalizeReference(name); if (!key || index.ambiguous.has(key)) return;
  entry = { ...entry, plain: name.toLowerCase() === key };
  const existing = index.names.get(key);
  // Names that normalize alike ("limonene, (-)-", "limonene, (+)-") keep the plain-name row; with none, the name is ambiguous and never coded.
  if (existing?.kind === 'exact') {
    if (existing.plain || entry.kind !== 'exact' || existing.concept.code === entry.concept.code) return;
    if (!entry.plain) { index.names.delete(key); index.ambiguous.add(key); for (const token of key.split(' ')) index.tokens.get(token)?.delete(key); return; }
  }
  index.names.set(key, entry);
  index.maxWords = Math.max(index.maxWords, key.split(' ').length);
  for (const token of key.split(' ')) if (token.length >= 5) (index.tokens.get(token) ?? index.tokens.set(token, new Set()).get(token)!).add(key);
}
function build(): Record<ReferenceDomain, Index> {
  const medication: Index = { names: new Map(), tokens: new Map(), maxWords: 1, ambiguous: new Set() }, condition: Index = { names: new Map(), tokens: new Map(), maxWords: 1, ambiguous: new Set() };
  const byName = new Map<string, ReferenceConcept>();
  for (const row of medicationRows.split('\n')) {
    const [name, rxcui, tty] = row.split('\t');
    const concept = { system: rxnormSystem, code: rxcui, display: name };
    if (tty !== 'BN') byName.set(normalizeReference(name), concept);
    add(medication, name, { concept, kind: 'exact' });
  }
  for (const [lay, name] of Object.entries(medicationSynonyms)) { const concept = byName.get(normalizeReference(name)); if (concept) add(medication, lay, { concept, kind: 'synonym' }); }
  for (const term of conditionTerms) {
    const concept = { system: icd10cmSystem, code: term.icd10, display: term.display };
    add(condition, term.name, { concept, kind: 'exact' });
    for (const synonym of term.synonyms) add(condition, synonym, { concept, kind: 'synonym' });
  }
  return { medication, condition };
}
const index = (domain: ReferenceDomain) => (indexes ??= build())[domain];

/** Optimal string alignment distance, stopping early above max. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous2: number[] = [], previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, previous2[j - 2]! + 1);
      current[j] = value; best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    previous2 = previous; previous = current;
  }
  return previous[b.length]!;
}

/** Longest name in the text that contains at least one of the patient's identifying words. */
function exact(domain: ReferenceDomain, text: string, identity: ReadonlySet<string>): Entry | undefined {
  const { names, maxWords } = index(domain), tokens = normalizeReference(text).split(' ').filter(Boolean), whole = tokens.join(' ');
  for (let size = Math.min(maxWords, tokens.length); size >= 1; size--) {
    for (let start = 0; start + size <= tokens.length; start++) {
      const words = tokens.slice(start, start + size), key = words.join(' '), entry = names.get(key);
      if (!entry || !words.some(word => identity.has(word))) continue;
      if (size === 1 && (everyday.has(key) || key.length <= 3 && key !== whole)) continue;
      return entry;
    }
  }
  return undefined;
}
/** A single unknown identifying word that is one or two edits from exactly one known name (same first letter). */
function spelling(domain: ReferenceDomain, identity: readonly string[]): ReferenceConcept | undefined {
  const { names, tokens } = index(domain);
  for (const word of identity) {
    if (word.length < 5 || tokens.has(word) || names.has(word)) continue;
    const max = word.length >= 8 ? 2 : 1;
    let best = max + 1, found = new Set<string>();
    for (const [token, keys] of tokens) {
      if (token[0] !== word[0]) continue;
      const d = distance(word, token, max);
      if (d < best) { best = d; found = new Set(keys); } else if (d === best) for (const key of keys) found.add(key);
    }
    if (best > max) continue;
    // Prefer the name that is just the corrected word; otherwise only a unique candidate.
    const corrected = [...found].find(key => !key.includes(' ')), keys = corrected ? [corrected] : [...found];
    const concepts = new Map(keys.map(key => [`${names.get(key)!.concept.code}`, { ...names.get(key)!.concept, display: corrected ?? key }]));
    if (concepts.size === 1) return [...concepts.values()][0];
  }
  return undefined;
}

/** Lookup for one field value. identity: the patient's identifying words (generic and purpose words removed). */
export function lookupReference(domain: string, text: string, identity: readonly string[]): ReferenceResult | undefined {
  const target: ReferenceDomain | undefined = domain === 'medication' || domain === 'allergen' ? 'medication' : domain === 'condition' ? 'condition' : undefined;
  if (!target || !identity.length) return undefined;
  const ids = new Set(identity.map(normalizeReference).flatMap(word => word.split(' ')));
  const found = exact(target, text, ids);
  if (found) return { match: { ...found.concept, kind: found.kind } };
  const suggestion = spelling(target, [...ids]);
  return suggestion ? { spelling: suggestion } : undefined;
}

/** Known medicine and condition names mentioned anywhere in a message, for the interpreter's REFERENCE block. */
export function scanReference(text: string, limit = 8): { domain: ReferenceDomain; mention: string; display: string }[] {
  const tokens = normalizeReference(text).split(' ').filter(Boolean), whole = tokens.join(' '), found: { domain: ReferenceDomain; mention: string; display: string }[] = [], seen = new Set<string>();
  for (const domain of ['medication', 'condition'] as const) {
    const { names, maxWords } = index(domain);
    for (let start = 0; start < tokens.length; start++) {
      for (let size = Math.min(maxWords, tokens.length - start); size >= 1; size--) {
        const key = tokens.slice(start, start + size).join(' '), entry = names.get(key);
        // Short names ("MS", "IBS") count only as the whole message, as in exact().
        if (!entry || size === 1 && (everyday.has(key) || key.length <= 3 && key !== whole) || seen.has(key)) continue;
        seen.add(key); found.push({ domain, mention: key, display: entry.concept.display }); start += size - 1; break;
      }
    }
  }
  return found.slice(0, limit);
}
