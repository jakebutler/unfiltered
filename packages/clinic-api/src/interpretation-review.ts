import type { TopicView } from '../../clinic-contract/src/index.js';
import { ApiFailure, type Draft } from './types.js';
import { nativeTopics, nativeResolveSlot } from '../../clinic-content/src/native-questionnaire.js';
import type { EffectiveProjection } from './provisional-projection.js';

/** Project interpreter metadata into the same immutable topics the patient reviews. */
export function interpretationReview(draft: Draft, unresolved: { sourceId: string; reason: string }[] = [], projection?: EffectiveProjection): TopicView[] {
  const provisional: TopicView[] = Object.values(draft.adaptive?.operations ?? {}).flatMap(operation => {
    const capture = operation.stream?.provisional; if (!capture || capture.policy === 'provisional-intake-v2') return [];
    return [{ id: `provisional:${operation.id}`, title: 'Proposed interpretation of your words', required: false, status: 'stopped-with-gaps' as const,
      missingDetails: ['This interpretation remains provisional. Source wording and unresolved details remain available for clinical review.', ...capture.gaps.map(gap => `${gap.targetId ?? 'Saved wording'}: ${gap.reason.replaceAll('-', ' ')}`)],
      details: capture.claims.map(claim => ({ id: claim.id, label: `${claim.topicId} ${claim.path} (${claim.fidelity === 'model-interpreted' ? 'interpreted meaning' : 'source supported'}; ${claim.status})`,
        state: claim.state === 'known' ? 'answered' as const : claim.state === 'not-applicable' ? 'uncertain' as const : claim.state,
        text: claim.state === 'known' ? typeof claim.value === 'object' && claim.value ? `${claim.value.feet} ft ${claim.value.inches} in` : String(claim.value) : claim.state,
        sourceIds: [claim.sourceId], provenance: claim.evidence.map(span => ({ ...span, transform: 'provisional-patient-report' })), editable: false })),
    }];
  });
  const fullOperations = Object.values(draft.adaptive?.operations ?? {}).filter(operation => operation.stream?.provisional?.policy === 'provisional-intake-v2');
  const streamOperations = Object.values(draft.adaptive?.operations ?? {}).filter(operation => operation.stream);
  if (streamOperations.length) {
    const sources = draft.turns.filter(turn => turn.role === 'patient');
    const claims = fullOperations.flatMap(operation => operation.stream!.provisional!.claims)
      .map(claim => projection?.claims.find(projected => projected.id === claim.id) ?? claim);
    const definitions = nativeTopics();
    const details: NonNullable<TopicView['details']> = sources.flatMap(source => {
      const reports = claims.filter(claim => claim.sourceId === source.id);
      const sourceOperations = streamOperations.filter(operation => operation.sourceId === source.id);
      const captures = fullOperations.filter(operation => operation.sourceId === source.id).map(operation => operation.stream!.provisional!);
      const label = (claim: typeof claims[number]) => { try { return nativeResolveSlot(definitions.find(topic => topic.id === claim.topicId)!, projection?.responses[claim.topicId] ?? { presented: false, answers: {} }, claim.path).slot.label; } catch { return 'Proposed answer'; } };
      const status = (claim: typeof claims[number]) => {
        const operation = fullOperations.find(operation => operation.stream!.provisional!.claims.some(saved => saved.id === claim.id));
        return operation?.status !== 'applied' ? `${operation?.status ?? 'unsaved'} interpretation`
          : claim.status === 'superseded' ? 'earlier replaced answer' : claim.status === 'conflicting' ? 'needs clarification' : 'proposed answer';
      };
      return [{ id: `source:${source.id}`, label: 'Your full saved words', state: 'answered' as const, text: source.text, sourceIds: [source.id], editable: false },
        ...sourceOperations.map(operation => ({ id: `status:${operation.id}`, label: 'Interpretation status', state: 'uncertain' as const,
          text: operation.status === 'applied' ? 'Saved for review; this is not a completeness check.' : `Interpretation ${operation.status}; the original words remain saved.`, sourceIds: [source.id], editable: false })),
        ...sourceOperations.flatMap(operation => (operation.stream?.sourceInterpretation?.reports ?? []).map((report, index) => ({ id: `source-meaning:${operation.id}:${index}`, label: 'Proposed meaning of your saved words', state: 'uncertain' as const, text: report.meaning, sourceIds: [source.id], editable: false }))),
        ...sourceOperations.flatMap(operation => (operation.stream?.sourceInterpretation?.unresolved ?? []).map((report, index) => ({ id: `source-unresolved:${operation.id}:${index}`, label: 'Saved meaning awaiting review', state: 'uncertain' as const, text: `${report.quote}\n${report.reason}`, sourceIds: [source.id], editable: false }))),
        ...sourceOperations.flatMap(operation => (operation.stream?.sourceInterpretation?.unadmitted ?? []).map((report, index) => ({ id: `held:${operation.id}:${index}`, label: 'Detail awaiting an applicable authored topic', state: 'uncertain' as const, text: report.sourceQuote, sourceIds: [source.id], editable: false }))),
        ...reports.map(claim => ({ id: `report:${claim.id}`, label: `${label(claim)} (${status(claim)})`, state: 'answered' as const,
          text: claim.state === 'known' ? typeof claim.value === 'object' && claim.value ? `${claim.value.feet} ft ${claim.value.inches} in` : String(claim.value) : claim.state.replaceAll('-', ' '), sourceIds: [source.id], editable: false })),
        ...(!reports.length && sourceOperations.length ? [{ id: `unmapped:${source.id}`, label: 'Words without a proposed answer', state: 'uncertain' as const, text: 'These words remain saved for review. Add any missing answer before sending, or leave it as an unresolved detail in a partial handoff.', sourceIds: [source.id], editable: false }] : []),
        ...captures.flatMap(capture => (capture.diagnostics ?? []).map((diagnostic,index)=>({id:`highlight:${source.id}:${index}`,label:'Optional highlight omitted',state:'uncertain' as const,text:'The optional highlight did not match this patient statement. The full original statement remains linked to every proposed answer.',sourceIds:[source.id],editable:false}))),
        ...captures.flatMap(capture => capture.gaps.filter(g=>g.detail).map((gap,index)=>({id:`unresolved:${source.id}:${index}`,label:'Unresolved proposed detail',state:'uncertain' as const,text:gap.detail!,sourceIds:[source.id],editable:false}))),
        ...(captures.some(capture => capture.accounting.remaining.length) ? [{ id: `diagnostic:${source.id}`, label: 'Check the whole statement', state: 'uncertain' as const, text: captures.some(c=>c.interpretationProfile==='turn-bound-typed-v1')?'Check the full saved statement above against every proposed answer. Add or correct any missing or changed meaning before sending.':'Some wording falls outside the cited phrases. Check the full statement above against your answers; this does not by itself mean a clinical detail is missing.', sourceIds: [source.id], editable: false }] : [])];
    });
    provisional.push({ id: 'source-fact-review', title: 'Check your saved words against your answers', required: false, status: 'ready-for-review',
      missingDetails: ['Check every statement for missing or changed meaning. Use Change on an answer, or Back to conversation to add a detail. Unresolved details remain visible in a partial handoff.'], details });
  }
  const fullGaps = projection?.gaps ?? [];
  if (!unresolved.length && !fullGaps.length) return provisional;
  const gaps: NonNullable<TopicView['interpretationGaps']> = [];
  for (const [index, gap] of fullGaps.entries()) gaps.push({ id: `full:${gap.sourceId}:${index}`, reason: gap.reason, evidence: structuredClone(gap.evidence) });
  const patientSources = new Map(draft.turns.filter(turn => turn.role === 'patient').map(turn => [turn.id, turn.text]));
  for (const operation of Object.values(draft.adaptive?.operations ?? {})) {
    if (operation.status !== 'applied' || !operation.unmapped?.length) continue;
    if (!operation.hasUnresolvedInterpretation || operation.unmapped.length > 8) throw new ApiFailure('invalid-interpretation-evidence', 503);
    for (const [index, gap] of operation.unmapped.entries()) {
      if (!['ambiguous', 'unsupported-target', 'capacity'].includes(gap.reason) || !gap.evidence.length) throw new ApiFailure('invalid-interpretation-evidence', 503);
      for (const span of gap.evidence) {
        const text = patientSources.get(span.sourceId);
        const splitsCharacter = (offset: number) => text !== undefined && offset > 0 && offset < text.length
          && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
        if (span.sourceId !== operation.sourceId || text === undefined || !Number.isInteger(span.start) || !Number.isInteger(span.end)
          || span.start < 0 || span.end <= span.start || span.end > text.length || splitsCharacter(span.start) || splitsCharacter(span.end)) throw new ApiFailure('invalid-interpretation-evidence', 503);
      }
      gaps.push({ id: `${operation.id}:${index}`, reason: gap.reason, evidence: structuredClone(gap.evidence) });
    }
  }
  return [...provisional, { id: 'interpretation', title: 'Saved wording needs review', required: false, status: 'stopped-with-gaps',
    missingDetails: ['Some saved wording was not fully interpreted'],
    answer: { text: unresolved.map(item => item.reason).join('\n'), state: 'uncertain', sourceIds: [...new Set(unresolved.map(item => item.sourceId))] },
    ...(gaps.length ? { interpretationGaps: gaps } : {}),
  }];
}
