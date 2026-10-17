/** Browser-safe Deepgram keyterm prompting for hosted hands-free voice. Imports only the browser-safe speech contract. */
import { deepgramDirectListenUrl } from './contracts';

/** Common medicine and condition names for a weight-management and metabolic clinic intake. Alphabetized. */
export const commonClinicKeyterms: readonly string[] = Object.freeze([
  'amlodipine', 'atorvastatin', 'bupropion', 'Contrave', 'dapagliflozin', 'dulaglutide', 'empagliflozin', 'Farxiga',
  'glipizide', 'hypertension', 'hypothyroidism', 'insulin glargine', 'Jardiance', 'levothyroxine', 'liraglutide',
  'lisinopril', 'losartan', 'metformin', 'Mounjaro', 'naltrexone', 'orlistat', 'Ozempic', 'PCOS', 'phentermine',
  'prediabetes', 'Qsymia', 'rosuvastatin', 'Saxenda', 'semaglutide', 'sitagliptin', 'sleep apnea', 'tirzepatide',
  'topiramate', 'Trulicity', 'Wegovy', 'Zepbound',
]);

/** Deepgram accepts at most 500 tokens across keyterms; we keep a conservative estimate under that. */
const maxKeyterms = 50;
const maxKeytermTokens = 400;
const tokensPerWord = 3;
const maxWords = 3;
const termPattern = /^[A-Za-z][A-Za-z0-9' -]{1,39}$/;

/** Structural subset of a session view that carries reference-coded names; avoids importing clinic-contract types. */
export interface ReferenceCodedView {
  topics: readonly { details?: readonly { specificity?: { code?: { display: string } } }[] }[];
}

/** Reference-coded names from `topics[].details[].specificity.code.display`, first-seen order, case-insensitively deduped.
 * The contract attaches a code only to exact, synonym or patient-confirmed names, so these are the patient's own terms. */
export function sessionKeyterms(view: ReferenceCodedView | undefined): string[] {
  const names: string[] = [];
  for (const topic of view?.topics ?? []) {
    for (const detail of topic.details ?? []) {
      const display = detail.specificity?.code?.display;
      if (typeof display === 'string') names.push(display);
    }
  }
  return uniqueKeyterms(names);
}

/** Listen URL with keyterm prompts: patient terms first (they matter most), then the common list.
 * Invalid terms are dropped, duplicates collapse case-insensitively, and the list stops at the first term that would exceed the term or token cap. */
export function directListenUrl(extra: readonly string[] = []): string {
  const seen = new Set<string>();
  const selected: string[] = [];
  let tokens = 0;
  for (const raw of [...extra, ...commonClinicKeyterms]) {
    const term = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (!termPattern.test(term)) continue;
    const words = term.split(' ').length;
    if (words > maxWords) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    if (selected.length >= maxKeyterms || tokens + words * tokensPerWord > maxKeytermTokens) break;
    seen.add(key);
    selected.push(term);
    tokens += words * tokensPerWord;
  }
  return deepgramDirectListenUrl + selected.map(term => `&keyterm=${encodeURIComponent(term)}`).join('');
}

function uniqueKeyterms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    const key = term.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(term);
  }
  return unique;
}
