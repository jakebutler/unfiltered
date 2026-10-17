import { describe, expect, it } from 'vitest';
import { deepgramDirectListenUrl } from '../src/contracts';
import { commonClinicKeyterms, directListenUrl, sessionKeyterms } from '../src/keyterms';

const keytermsOf = (url: string) => new URL(url).searchParams.getAll('keyterm');

describe('commonClinicKeyterms', () => {
  it('is a frozen, duplicate-free list of about 35 clinic terms that includes the verified examples', () => {
    expect(Object.isFrozen(commonClinicKeyterms)).toBe(true);
    expect(commonClinicKeyterms.length).toBeGreaterThanOrEqual(35);
    expect(new Set(commonClinicKeyterms.map(term => term.toLowerCase())).size).toBe(commonClinicKeyterms.length);
    expect(commonClinicKeyterms).toEqual(expect.arrayContaining(['semaglutide', 'tirzepatide', 'insulin glargine', 'sleep apnea']));
  });
});

describe('directListenUrl', () => {
  it('keeps the base URL as an unchanged prefix and adds the common terms when there are no patient terms', () => {
    const url = directListenUrl();
    expect(url.startsWith(`${deepgramDirectListenUrl}&keyterm=`)).toBe(true);
    expect(keytermsOf(url)).toEqual([...commonClinicKeyterms]);
  });

  it('puts patient terms before common terms', () => {
    const terms = keytermsOf(directListenUrl(['Sertraline', 'Metoprolol succinate']));
    expect(terms.slice(0, 2)).toEqual(['Sertraline', 'Metoprolol succinate']);
    expect(terms.slice(2)).toEqual([...commonClinicKeyterms]);
  });

  it('encodes multi-word terms with %20 and repeats keyterm per term', () => {
    const url = directListenUrl(['Metoprolol succinate']);
    expect(url).toContain('&keyterm=Metoprolol%20succinate');
    expect(url).toContain('&keyterm=insulin%20glargine');
    expect(url).not.toContain(',');
    expect(url).not.toMatch(/keyterm=[^&]*,/);
  });

  it('trims and collapses whitespace before validating', () => {
    expect(keytermsOf(directListenUrl(['  Lorazepam  ', 'Crohn   disease']))).toEqual(['Lorazepam', 'Crohn disease', ...commonClinicKeyterms]);
  });

  it('rejects terms outside the Deepgram-safe pattern, with more than three words, or non-strings', () => {
    const url = directListenUrl(['a,b', 'x:0.5', 'DROP TABLE;', 'x', '1abc', 'one two three four', 'a'.repeat(41), 'Good term', 42 as unknown as string]);
    const terms = keytermsOf(url);
    expect(terms.slice(0, 1)).toEqual(['Good term']);
    expect(url).not.toContain('a%2Cb');
    expect(url).not.toContain('x%3A0.5');
    expect(url).not.toContain('DROP%20TABLE%3B');
    expect(terms).toHaveLength(1 + commonClinicKeyterms.length);
  });

  it('dedupes case-insensitively, keeping the first (patient) spelling', () => {
    const terms = keytermsOf(directListenUrl(['SEMAGLUTIDE', 'Ozempic', 'ozempic']));
    expect(terms.slice(0, 2)).toEqual(['SEMAGLUTIDE', 'Ozempic']);
    expect(terms.filter(term => term.toLowerCase() === 'semaglutide')).toEqual(['SEMAGLUTIDE']);
    expect(terms.filter(term => term.toLowerCase() === 'ozempic')).toEqual(['Ozempic']);
    expect(terms).toHaveLength(commonClinicKeyterms.length);
  });

  it('caps at 50 terms, keeping the highest-priority patient terms', () => {
    const patient = Array.from({ length: 60 }, (_, index) => `Drug${index}`);
    const terms = keytermsOf(directListenUrl(patient));
    expect(terms).toHaveLength(50);
    expect(terms).toEqual(patient.slice(0, 50));
  });

  it('caps the conservative token estimate at 400 (three per word), dropping lower-priority terms beyond it', () => {
    const patient = Array.from({ length: 60 }, (_, index) => `Term${index} Alpha Beta`);
    const terms = keytermsOf(directListenUrl(patient));
    // Nine tokens per three-word term: 44 terms cost 396, a 45th would reach 405.
    expect(terms).toEqual(patient.slice(0, 44));
    const cost = terms.reduce((sum, term) => sum + term.split(' ').length * 3, 0);
    expect(cost).toBeLessThanOrEqual(400);
  });

  it('drops common terms first when the token estimate is spent by patient terms', () => {
    const patient = Array.from({ length: 60 }, (_, index) => `Term${index} Alpha Beta`);
    expect(keytermsOf(directListenUrl(patient)).some(term => commonClinicKeyterms.includes(term))).toBe(false);
  });
});

describe('sessionKeyterms', () => {
  it('reads reference-coded display names from topic details, deduped and ignoring uncoded details', () => {
    const names = sessionKeyterms({
      topics: [
        { details: [{ specificity: { code: { display: 'Semaglutide' } } }, { specificity: {} }, {}] },
        { details: [{ specificity: { code: { display: 'semaglutide' } } }, { specificity: { code: { display: 'Hypertension' } } }] },
        {},
      ],
    });
    expect(names).toEqual(['Semaglutide', 'Hypertension']);
  });

  it('returns nothing for a missing view', () => {
    expect(sessionKeyterms(undefined)).toEqual([]);
  });
});
