import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessSpecificity, specificityContract, specificityContracts } from '../../clinic-content/src/specificity.js';
import { lookupReference } from '../../clinic-reference/src/index.js';

/** The specificity acceptance gate (SP-0.1). New vague-answer reports become corpus rows first; then lexicons or
 * contracts change. Assessment is deterministic, so this gate needs no model and no recording. */
interface Item { id: string; topicId: string; path: string; value: string; expect: 'specific' | 'gap'; }
const corpus = JSON.parse(readFileSync(new URL('./fixtures/specificity-corpus.json', import.meta.url), 'utf8')) as { version: string; items: Item[] };
const results = corpus.items.map(item => ({ item, gap: assessSpecificity(specificityContract(item.topicId, item.path)!, item.value, lookupReference).level !== 'specific' }));

describe('specificity corpus gate', () => {
  it('covers every contract with both specific and vague answers', () => {
    expect(new Set(corpus.items.map(item => item.id)).size).toBe(corpus.items.length);
    // Every row is scored: a mistyped label or path would otherwise drop out of both rates.
    expect(corpus.items.filter(item => !['gap', 'specific'].includes(item.expect) || !specificityContract(item.topicId, item.path)).map(item => item.id)).toEqual([]);
    // The rates mean something only over the full corpus; it may grow, never shrink.
    expect(corpus.items.length).toBeGreaterThanOrEqual(360);
    for (const contract of specificityContracts) {
      const rows = corpus.items.filter(item => item.topicId === contract.topicId && item.path === contract.path);
      expect(rows.some(row => row.expect === 'gap') && rows.some(row => row.expect === 'specific'), `${contract.topicId}:${contract.path}`).toBe(true);
    }
  });
  it('catches at least 95% of vague answers', () => {
    const vague = results.filter(({ item }) => item.expect === 'gap');
    const missed = vague.filter(({ gap }) => !gap).map(({ item }) => `${item.id} "${item.value}"`);
    expect(1 - missed.length / vague.length, `missed: ${missed.join('; ')}`).toBeGreaterThanOrEqual(0.95);
  });
  it('asks a needless follow-up for at most 5% of specific answers', () => {
    const specific = results.filter(({ item }) => item.expect === 'specific');
    const needless = specific.filter(({ gap }) => gap).map(({ item }) => `${item.id} "${item.value}"`);
    expect(needless.length / specific.length, `needless: ${needless.join('; ')}`).toBeLessThanOrEqual(0.05);
  });
});
