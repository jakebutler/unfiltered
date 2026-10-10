import { createClinicContent, type ScenarioId, type TopicResponse } from '../../../clinic-content/src/index.js';
import type { AdaptiveContext, AdaptiveFact, AdaptiveProposal, AdaptiveSource } from '../../src/adaptive-validation.js';

export const register = createClinicContent({ mentalHealth: 'phq4' });
const definitions = [...register.topics, ...Object.values(register.branches).map(branch => branch.topic), ...Object.values(register.scenarios).flatMap(scenario => scenario.additionalTopics)];
export const source = (text: string, id = 'turn-current'): AdaptiveSource => ({ id, role: 'patient', text, at: '2026-10-09T12:00:00.000Z' });
export function context(text: string, ids = ['Q04'], scenario: ScenarioId = 'first-intake'): AdaptiveContext {
  const current = source(text);
  return { binding: { operationId: 'operation-secret', sessionId: 'session-secret', patient: 'Patient/secret', scenario, revision: 2, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'snapshot-secret' }, source: current, sources: [current], topics: ids.map(id => definitions.find(definition => definition.id === id)!), responses: {}, displayed: { topicId: ids[0], promptId: definitions.find(definition => definition.id === ids[0])!.openingPromptId, targetPaths: [] } };
}
export function evidence(ctx: AdaptiveContext, quote: string, occurrence = 0) {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = ctx.source.text.indexOf(quote, start + 1);
  if (start < 0) throw new Error(`Missing fixture quote: ${quote}`);
  return [{ sourceId: ctx.source.id, start, end: start + quote.length }];
}
export function fact(ctx: AdaptiveContext, topicId: string, path: string, quote: string, transform: AdaptiveFact['transform'] = 'verbatim', state: AdaptiveFact['state'] = 'known', occurrence = 0): AdaptiveFact {
  return { topicId, path, state, transform, evidence: evidence(ctx, quote, occurrence) };
}
export function proposal(facts: AdaptiveProposal['facts'] = [], rest: Partial<AdaptiveProposal> = {}): AdaptiveProposal {
  return { schema: 1, facts, newItems: [], completedLists: [], acts: [], ...rest };
}
export function withPrior(ctx: AdaptiveContext, topicId: string, answers: TopicResponse['answers'], text = 'Earlier patient answers') {
  ctx.sources = [source(text, 'prior'), ...ctx.sources];
  ctx.responses = { ...ctx.responses, [topicId]: { presented: true, answers } };
  return ctx;
}
