import { createHash } from 'node:crypto';
import { canonicalJson, digest } from '../../clinical-core/src/domain.js';
import { DigitalOceanStreamFailure, type DigitalOceanStreamReceipt } from '../../clinical-core/src/digitalocean-stream.js';
import { AdaptiveError, type AdaptiveContext } from './adaptive-validation.js';
import { createReplyDraftManifest, validateReplyAdvance, validateReplyDraft } from './adaptive-reply.js';
import { createCompactReplyManifest, type CompactReplyManifest } from './adaptive-reply-compact.js';
import { createFullReplyManifest, prepareFullCapture, prepareFullNavigation, validateFullAdvance, type FullReplyManifest } from './adaptive-reply-full.js';
import { eligibleAdaptiveProbes } from './dialogue.js';
import { prepareProvisionalCapture } from './provisional-draft.js';
import { selectUsefulAdvance } from './reply-usefulness.js';
import { ApiFailure, type AdaptiveOperation, type Draft, type StoredDraft } from './types.js';
import type { AdaptiveDraftStore } from './adaptive-session.js';

/** Injection boundary only. No provider factory, credentials or activation. */
export interface AdaptiveStreamProposer {
  propose(context: AdaptiveContext, manifest: CompactReplyManifest | FullReplyManifest, options: {
    onAdvance(raw: unknown): Promise<void>; signal: AbortSignal;
  }): Promise<{ draft: unknown; receipt?: DigitalOceanStreamReceipt }>;
}
export const targetKey = (topicId: string, path: string) => `${topicId}:${path}`;
/** Exact semantic scope; operation bookkeeping/provisional tail/revision are
 * excluded. Any words, direct answers, prompt, mode or safety change revokes it. */
export function streamSpeechScopeDigest(draft: Draft): string {
  return createHash('sha256').update(canonicalJson({ id: draft.id, patient: draft.patient, scenario: draft.scenario,
    turns: draft.turns, topics: draft.topics, phase: draft.phase, safety: draft.safety ?? null, version: draft.version,
    confirmed: draft.confirmed ?? null, prior: draft.prior ?? null, activeTopic: draft.activeTopic ?? null, activeSlot: draft.activeSlot ?? null,
    mode: draft.adaptive?.mode ?? null, exchange: draft.adaptive?.exchange ?? null,
    generations: draft.adaptive?.targetGenerations ?? {},
  })).digest('hex');
}
/** Called for direct patient edits, never an interpretation result. */
export function trackDirectAdaptiveEdits(previous: Draft, next: Draft): Draft {
  if (!next.adaptive) return next;
  const generations = { ...previous.adaptive?.targetGenerations };
  for (const topicId of new Set([...Object.keys(previous.topics), ...Object.keys(next.topics)])) {
    const before = previous.topics[topicId]?.answers ?? {}, after = next.topics[topicId]?.answers ?? {};
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (canonicalJson(before[path] ?? null) !== canonicalJson(after[path] ?? null)) {
        const key = targetKey(topicId, path); generations[key] = (generations[key] ?? 0) + 1;
      }
    }
  }
  return { ...next, adaptive: { ...next.adaptive, targetGenerations: generations } };
}
const sameAttempt = (op: AdaptiveOperation | undefined, expected: AdaptiveOperation) => !!op
  && op.id === expected.id && op.attemptId === expected.attemptId && op.sourceId === expected.sourceId
  && op.fingerprint === expected.fingerprint && canonicalJson(op.binding) === canonicalJson(expected.binding);

/** The attempt has already been durably claimed by adaptiveSession. Reply is
 * saved before notification; a tail may only add provisional evidence. */
export async function runAdaptiveStreamOperation(store: AdaptiveDraftStore, claimed: StoredDraft,
  context: AdaptiveContext, proposer: AdaptiveStreamProposer,
  options: { now: () => number; timeoutMs: number; onReplySaved?: (draft: Draft) => void; fullCapture?: boolean }) {
  const expected = claimed.draft.adaptive!.operations[context.binding.operationId];
  if (expected.status !== 'processing' || !expected.attemptId || expected.processingRevision !== claimed.draft.revision)
    throw new ApiFailure('processing-claim-unverified', 503);
  const fullManifest = options.fullCapture ? createFullReplyManifest(context) : undefined;
  const validationManifest = fullManifest ? undefined : createReplyDraftManifest(context, { replyPolicy: 'supplied-response-v1' });
  const wireManifest = fullManifest ?? createCompactReplyManifest(context, { replyPolicy: 'supplied-response-v1' });
  const probes = fullManifest?.actions ?? eligibleAdaptiveProbes(context).slice(0, 32);
  const actions = probes.map((probe, index) => ({ ...probe, id: `a${index}` }));
  const controller = new AbortController(); let active = true, advanceSeen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = (previous: StoredDraft, draft: Draft) => store.save(previous, { ...draft, revision: previous.draft.revision + 1, savedAt: new Date(options.now()).toISOString() });
  const onAdvance = async (raw: unknown) => {
    if (!active || advanceSeen) throw new AdaptiveError('late-or-duplicate-advance');
    advanceSeen = true;
    const advance = fullManifest ? validateFullAdvance(raw, fullManifest) : validateReplyAdvance(raw, validationManifest!);
    const navigation = fullManifest && (advance.supplied?.length || advance.suppliedDraft || advance.controls.length) ? prepareFullNavigation(advance, fullManifest) : undefined;
    if (navigation && Buffer.byteLength(canonicalJson(navigation), 'utf8') > 8192) throw new AdaptiveError('navigation-capacity');
    const useful = selectUsefulAdvance(context, advance, actions, fullManifest?.targets, navigation);
    const current = await store.read(), op = current.draft.adaptive?.operations[expected.id];
    if (!active || !sameAttempt(op, expected) || op!.status !== 'processing' || current.draft.revision !== expected.processingRevision
      || current.draft.phase !== 'conversation' || current.draft.safety?.paused) throw new AdaptiveError('stale-early-reply');
    const next = structuredClone(current.draft), target = next.adaptive!.operations[expected.id];
    target.stream!.reply = useful ? 'saved' : 'withheld';
    if (navigation) target.stream!.navigation = navigation;
    if (useful) {
      const probe = probes[Number(useful.action.id.slice(1))], replyId = `${expected.id}:${probe.promptId}`;
      target.stream!.replyId = replyId;
      next.adaptive!.exchange = { state: { activeTopicId: probe.topicId }, prompt: structuredClone(probe), status: 'question' };
      delete next.activeTopic; delete next.activeSlot; delete next.preview;
      target.stream!.replyScope = { revision: current.draft.revision + 1, sha256: streamSpeechScopeDigest(next) };
    }
    const saved = await save(current, next);
    // A bounded provider callback cannot make an unconfirmed save audible.
    // An in-flight store write may settle after cancellation; no notification follows.
    if (active && useful && saved.draft.adaptive?.operations[expected.id]?.stream?.replyId === target.stream!.replyId)
      options.onReplySaved?.(saved.draft);
  };
  let rawDraft: unknown, receipt: DigitalOceanStreamReceipt | undefined, errorCode: string | undefined, proposalResolved = false;
  const proposal = Promise.resolve().then(() => proposer.propose(context, wireManifest, { onAdvance, signal: controller.signal }));
  try {
    const result = await Promise.race([proposal, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { active = false; controller.abort(); reject(new AdaptiveError('stream-outcome-unknown')); }, options.timeoutMs);
    })]);
    proposalResolved = true; rawDraft = result.draft; receipt = result.receipt;
  } catch (error) {
    if (error instanceof DigitalOceanStreamFailure) receipt = error.receipt;
    errorCode = error instanceof AdaptiveError ? error.code : 'stream-outcome-unknown';
  } finally { active = false; controller.abort(); if (timer) clearTimeout(timer); }
  let capture: ReturnType<typeof prepareProvisionalCapture> | undefined, tailRejected = false;
  if (rawDraft !== undefined && advanceSeen && !errorCode) {
    try { capture = fullManifest ? prepareFullCapture(rawDraft, fullManifest) : prepareProvisionalCapture(context, validateReplyDraft(rawDraft, validationManifest!).draft); }
    catch (error) { tailRejected = true; errorCode = error instanceof AdaptiveError ? error.code : 'invalid-provisional-tail'; }
  } else if (!errorCode) errorCode = 'missing-advance-or-tail';
  const settle = async (current: StoredDraft, rereadAllowed: boolean): Promise<StoredDraft> => {
    const op = current.draft.adaptive?.operations[expected.id];
    if (!sameAttempt(op, expected)) return current;
    if (op!.status !== 'processing' || current.draft.phase !== 'conversation' || current.draft.confirmed) {
      // Retain an actual late billing/termination receipt without changing
      // revision, eligibility, sources, question, capture or frozen review.
      if (receipt && op!.stream && !op!.stream.receipt) {
        const audit = structuredClone(current.draft); audit.adaptive!.operations[expected.id].stream!.receipt = receipt;
        try { return await store.save(current, audit); } catch { return store.read(); }
      }
      return current; // Discard/review/confirmation defeats semantic application.
    }
    const next = structuredClone(current.draft), target = next.adaptive!.operations[expected.id];
    let settledCapture = capture && structuredClone(capture);
    if (settledCapture && target.stream?.navigation) {
      for (const claim of target.stream.navigation.claims) {
        if (!settledCapture.claims.some(tail => tail.status === 'proposed' && tail.topicId === claim.topicId && tail.path === claim.path && tail.state === claim.state && canonicalJson(tail.value) === canonicalJson(claim.value)))
          settledCapture.gaps.push({ evidence: claim.evidence, reason: 'conflict' });
      }
      for (const closure of target.stream.navigation.closures ?? []) {
        if (!settledCapture.closures?.some(tail => tail.topicId === closure.topicId && tail.collection === closure.collection))
          settledCapture.gaps.push({ evidence: closure.evidence, reason: 'conflict' });
      }
      settledCapture.gaps.push(...target.stream.navigation.gaps.filter(gap => gap.reason !== 'unaddressed-source'));
    }
    if (settledCapture) for (const claim of settledCapture.claims) {
      const path = claim.path.includes('[') ? claim.path.slice(0, claim.path.indexOf('[')) : claim.path;
      const key = targetKey(claim.topicId, path);
      const edited = (next.adaptive!.targetGenerations?.[key] ?? 0) !== (target.stream!.targetGenerations[key] ?? 0)
        || canonicalJson(next.topics[claim.topicId]?.answers[path] ?? null) !== canonicalJson(claimed.draft.topics[claim.topicId]?.answers[path] ?? null);
      if (edited) { claim.status = 'superseded'; settledCapture.gaps.push({ evidence: claim.evidence, reason: 'conflict' }); }
    }
    const bytes = (value: unknown) => Buffer.byteLength(canonicalJson(value), 'utf8');
    const otherCaptureBytes = Object.values(next.adaptive!.operations).filter(item => item.id !== expected.id)
      .reduce((sum, item) => sum + (item.stream?.provisional ? bytes(item.stream.provisional) : 0) + (item.stream?.navigation ? bytes(item.stream.navigation) : 0), target.stream?.navigation ? bytes(target.stream.navigation) : 0);
    let capacityLimited = !!settledCapture && (bytes(settledCapture) > 32768 || otherCaptureBytes + bytes(settledCapture) > 131072);
    const minimalCapture = () => ({ sourceId: context.source.id, policy: capture?.policy ?? 'provisional-context-v1', claims: [],
      gaps: [{ reason: 'capacity' as const, evidence: [{ sourceId: context.source.id, start: 0, end: context.source.text.length }] }],
      accounting: { addressed: [], remaining: [{ sourceId: context.source.id, start: 0, end: context.source.text.length }], semanticReview: 'qualification-required' as const } });
    if (capacityLimited) settledCapture = minimalCapture();
    target.stream!.capture = settledCapture && !capacityLimited ? 'saved' : 'partial';
    if (target.stream!.reply === 'pending') target.stream!.reply = 'withheld';
    if (settledCapture) target.stream!.provisional = settledCapture;
    if (receipt) target.stream!.receipt = receipt;
    target.status = settledCapture && !capacityLimited ? 'applied' : capacityLimited || tailRejected || receipt?.outcome === 'rejected' ? 'failed' : 'unresolved';
    target.updatedAt = new Date(options.now()).toISOString();
    target.hasUnresolvedInterpretation = true;
    if (errorCode) target.errorCode = errorCode;
    if ((proposalResolved || receipt?.providerExecution === 'completed') && !next.safety?.paused) {
      for (const queued of Object.values(next.adaptive!.operations)) {
        if (queued.status === 'accepted' && queued.queuedAfter === expected.id) queued.queuedWaiting = false;
      }
    }
    if (bytes(next) > 491808 && settledCapture) {
      capacityLimited = true; settledCapture = minimalCapture(); target.stream!.provisional = settledCapture;
      target.stream!.capture = 'partial'; target.status = 'failed';
    }
    if (capacityLimited) target.errorCode = 'provisional-capacity';
    if (settledCapture) target.resultDigest = await digest(settledCapture);
    // No exchange, question, audio or topic answers change in this tail commit.
    try { return await save(current, next); }
    catch (error) {
      if (error instanceof ApiFailure && error.code === 'stale-session') {
        const fresh = await store.read();
        // One metadata-only recompute closes the ordinary queued/edit CAS race.
        // Provider work is never replayed; a second race remains visible pending.
        return rereadAllowed ? settle(fresh, false) : fresh;
      }
      throw error;
    }
  };
  return settle(await store.read(), true);
}
