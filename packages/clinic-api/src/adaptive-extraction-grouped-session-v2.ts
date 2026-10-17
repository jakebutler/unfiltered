import { canonicalJson, digest } from "../../clinical-core/src/domain.js";
import { createHash } from 'node:crypto';
import {
  DigitalOceanStreamFailure,
  type DigitalOceanStreamReceipt,
} from "../../clinical-core/src/digitalocean-stream.js";
import { AdaptiveError, type AdaptiveContext } from "./adaptive-validation.js";
import {
  ApiFailure,
  type AdaptiveOperation,
  type Draft,
  type StoredDraft,
} from "./types.js";
import {
  fitAdaptiveRawAudit,
  auditAdaptiveRawProposal,
  type AdaptiveDraftStore,
} from "./adaptive-session.js";
import {
  targetKey,
  streamSpeechScopeDigest,
} from "./adaptive-stream-session.js";
import {
  createGroupedExtractionManifest,
  compileGroupedExtraction,
  planGroupedExtraction,
  groupedNavigationAudit,
  type GroupedExtractionManifest,
} from "./adaptive-extraction-grouped-v2.js";
import type { FullReplyDraft } from "./adaptive-reply-full.js";
import type { ProvisionalCapture } from "./provisional-draft.js";
import { admitFocusedResult, focusedResultInventory, FocusedOutputFailure, type FocusedResult, type SourceFirstInventory } from './adaptive-extraction-focused.js';
import { policyQualified, typedPolicyRevision } from './provisional-projection.js';
import { admitTypedTurnResult, typedTurnRaw, type TypedTurnResult } from './adaptive-extraction-typed.js';
const sameAttempt = (
  op: AdaptiveOperation | undefined,
  expected: AdaptiveOperation,
) =>
  !!op &&
  op.id === expected.id &&
  op.attemptId === expected.attemptId &&
  op.sourceId === expected.sourceId &&
  op.fingerprint === expected.fingerprint &&
  canonicalJson(op.binding) === canonicalJson(expected.binding);
const inventoryBytes = (value: unknown) => Buffer.byteLength(canonicalJson(value));
/** Isolated injection experiment: completed extraction then atomic provisional capture/local question save. No provider factory or production mount. */
export interface GroupedExtractionProposer {
  extract(context: AdaptiveContext, manifest: GroupedExtractionManifest, options: { signal: AbortSignal; onReceipt?: (receipt: DigitalOceanStreamReceipt, raw?: string) => Promise<void>; onStage?: (inventory: SourceFirstInventory) => Promise<void> }): Promise<{ raw: unknown; receipt?: DigitalOceanStreamReceipt; focused?: FocusedResult; typed?: TypedTurnResult }>;
}
/** Completed provider output rejected by the opt-in codec. Retain evidence;
 * this error never grants capture or question authority. */
export class GroupedExtractionOutputFailure extends AdaptiveError {
  constructor(code: string, readonly receipt: DigitalOceanStreamReceipt, readonly providerOutput: string) { super(code); }
}
export async function runGroupedExtractionOperation(
  store: AdaptiveDraftStore,
  claimed: StoredDraft,
  context: AdaptiveContext,
  proposer: GroupedExtractionProposer,
  options: {
    now: () => number;
    timeoutMs: number;
    signal?: AbortSignal;
    onReplySaved?: (draft: Draft) => void;
    recognitionContinuation?: boolean;
    /** Server conversation construction owns qualification and record context. */
    navigationContext?: (draft: Draft) => Pick<AdaptiveContext, "responses" | "nativeRouting"> & { qualification?: import("./provisional-projection.js").ProvisionalQualification };
  },
) {
  const expected =
    claimed.draft.adaptive!.operations[context.binding.operationId];
  if (
    !expected ||
    canonicalJson(expected.binding) !== canonicalJson(context.binding) ||
    expected.sourceId !== context.source.id ||
    claimed.draft.id !== context.binding.sessionId ||
    claimed.draft.patient !== context.binding.patient ||
    claimed.draft.scenario !== context.binding.scenario ||
    !claimed.draft.turns.some(
      (turn) =>
        turn.id === context.source.id &&
        turn.role === context.source.role &&
        turn.text === context.source.text &&
        turn.at === context.source.at &&
          turn.channel === context.source.channel,
    ) ||
    context.sources.some(
      (source) =>
        !claimed.draft.turns.some(
          (turn) =>
            turn.id === source.id &&
            turn.role === source.role &&
            turn.text === source.text &&
            turn.at === source.at &&
            turn.channel === source.channel,
        ),
    )
  )
    throw new ApiFailure("extraction-context-unverified", 503);
  if (
    expected.status !== "processing" ||
    !expected.attemptId ||
    expected.processingRevision !== claimed.draft.revision
  )
    throw new ApiFailure("processing-claim-unverified", 503);
  const started = options.now(),
    deadline = Math.min(
      started + options.timeoutMs,
      Date.parse(expected.deadlineAt ?? "") || Infinity,
    ),
    manifest = createGroupedExtractionManifest(context),
    controller = new AbortController();
  let cancelled = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    abortListener: (() => void) | undefined;
  let rejectedProviderOutput: string | undefined;
  let planningManifest = manifest;
  let sourceInventory: SourceFirstInventory | undefined;
  let typedResult: TypedTurnResult | undefined;
  let typedCompiled: ReturnType<typeof compileGroupedExtraction> | undefined;
  let rawWire: unknown,
    compiledDraft: FullReplyDraft | undefined,
    capture: ProvisionalCapture | undefined,
    receipt: DigitalOceanStreamReceipt | undefined,
    errorCode: string | undefined,
    proposalResolved = false,
    tailRejected = false,
    captureValidatedMs: number | null = null,
    captureSavedMs: number | null = null,
    nextQuestionSavedMs: number | null = null,
    notificationStatus:
      | "not-applicable"
      | "suppressed"
      | "not-configured"
      | "sent"
      | "failed"
      | "fresh-read-failed" = "not-applicable";
  const save = (previous: StoredDraft, draft: Draft) =>
    store.save(previous, {
      ...draft,
      revision: previous.draft.revision + 1,
      savedAt: new Date(options.now()).toISOString(),
    });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (cancelled || options.signal?.aborted)
          throw new AdaptiveError("extraction-cancelled");
        if (options.now() >= deadline)
          throw new AdaptiveError("extraction-outcome-unknown");
        return proposer.extract(context, manifest, {
          signal: controller.signal,
          onReceipt: async (providerReceipt, raw) => {
            receipt=structuredClone(providerReceipt); if(raw!==undefined)rejectedProviderOutput=raw;
            // Evidence-only CAS: late receipt cannot publish facts or change review.
            const persist = async (previous: StoredDraft, retry: boolean): Promise<void> => {
              const op=previous.draft.adaptive?.operations[expected.id]; if(!sameAttempt(op,expected))return;
              const audit=structuredClone(previous.draft),target=audit.adaptive!.operations[expected.id];
              target.stream!.receipt=structuredClone(providerReceipt);
              if(raw!==undefined){const retained=auditAdaptiveRawProposal(raw);if(retained)target.rawProposalAudit=fitAdaptiveRawAudit(audit,expected.id,retained);}
              try{await store.save(previous,audit);}catch(error){if(retry&&error instanceof ApiFailure&&error.code==='stale-session')await persist(await store.read(),false);else throw error;}
            };
            await persist(await store.read(),true);
          },
          onStage: async inventory => {
            if (inventory.sourceId !== context.source.id || inventory.protocol !== 'source-first-focused-v1') throw new AdaptiveError('foreign-stage-inventory');
            const current = await store.read(), op = current.draft.adaptive?.operations[expected.id];
            if (!sameAttempt(op, expected)) throw new AdaptiveError('stale-focused-dependencies');
            const active = !cancelled && options.now() < deadline && op!.status === 'processing' && streamSpeechScopeDigest(current.draft) === streamSpeechScopeDigest(claimed.draft);
            sourceInventory = structuredClone(inventory);
            const rawAudit = auditAdaptiveRawProposal({ source: inventory.sourceRaw, mapping: inventory.mappingRaw });
            if (inventoryBytes(sourceInventory) > 32768) {
              sourceInventory.sourceRaw = ''; sourceInventory.mappingRaw = '';
              const rawHash = (text: string) => createHash('sha256').update(text).digest('hex');
              sourceInventory.rawAudit = { source: { sha256: rawHash(inventory.sourceRaw), bytes: Buffer.byteLength(inventory.sourceRaw) }, mapping: { sha256: rawHash(inventory.mappingRaw), bytes: Buffer.byteLength(inventory.mappingRaw) }, retention: 'operation-audit' };
            }
            if (inventoryBytes(sourceInventory) > 32768) throw new AdaptiveError('source-interpretation-capacity');
            // A metadata-only receipt save never publishes core facts or branch
            // authority. Persist each newly completed provider independently.
            const persistAudit = async (previous: StoredDraft, retry: boolean): Promise<void> => {
              const savedOp = previous.draft.adaptive?.operations[expected.id];
              if (!sameAttempt(savedOp, expected) || inventory.receipts.length <= (savedOp!.stream?.sourceInterpretation?.receipts.length ?? 0)) return;
              const audit = structuredClone(previous.draft), target = audit.adaptive!.operations[expected.id];
              // After settlement retain only execution/raw metadata: a late
              // receipt cannot add reports, held detail, facts or navigation.
              const stillActive = active && target.status === 'processing' && !cancelled && options.now() < deadline;
              target.stream!.sourceInterpretation = stillActive ? structuredClone(sourceInventory!) : { ...(target.stream!.sourceInterpretation ?? sourceInventory!), sourceRaw: sourceInventory!.sourceRaw, mappingRaw: sourceInventory!.mappingRaw, rawAudit: sourceInventory!.rawAudit, stageExecutions: [...sourceInventory!.stageExecutions], receipts: structuredClone(sourceInventory!.receipts) };
              if (rawAudit) target.rawProposalAudit = fitAdaptiveRawAudit(audit, expected.id, rawAudit);
              try { await store.save(previous, audit); }
              catch (error) { if (retry && error instanceof ApiFailure && error.code === 'stale-session') await persistAudit(await store.read(), false); else throw error; }
            };
            await persistAudit(current, true);
            if (!active) throw new AdaptiveError(cancelled || options.now() >= deadline ? 'extraction-outcome-unknown' : 'stale-focused-dependencies');
          },
        });
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            cancelled = true;
            controller.abort();
            reject(new AdaptiveError("extraction-outcome-unknown"));
          },
          Math.max(1, deadline - options.now()),
        );
        abortListener = () => {
          cancelled = true;
          controller.abort();
          reject(new AdaptiveError("extraction-cancelled"));
        };
        if (options.signal?.aborted) abortListener();
        else
          options.signal?.addEventListener("abort", abortListener, {
            once: true,
          });
      }),
    ]);
    proposalResolved = true;
    rawWire = result.raw;
    receipt = result.receipt;
    if (cancelled || options.now() >= deadline)
      throw new AdaptiveError("extraction-outcome-unknown");
    try {
      let compiled: ReturnType<typeof compileGroupedExtraction>;
      if (result.typed) {
        typedResult = result.typed; rawWire = typedTurnRaw(typedResult);
        const audit = auditAdaptiveRawProposal(rawWire); if (audit?.retention === 'retained' && rejectedProviderOutput===undefined) rejectedProviderOutput = audit.content;
        compiled = admitTypedTurnResult(typedResult, context, manifest, claimed.draft, options.navigationContext); typedCompiled = compiled;
      } else if (result.focused) {
        sourceInventory = focusedResultInventory(result.focused);
        const admitted = await admitFocusedResult(result.focused, context, manifest, claimed.draft, options.navigationContext);
        sourceInventory = admitted.inventory; planningManifest = admitted.manifest; rawWire = admitted.raw; compiled = admitted;
      } else compiled = compileGroupedExtraction(rawWire, manifest);
      compiledDraft = compiled.draft;
      capture = compiled.capture;
      captureValidatedMs = options.now() - started;
    } catch (error) {
      tailRejected = true;
      if(typedResult&&error instanceof AdaptiveError)throw error;
      throw new AdaptiveError("invalid-grouped-extraction");
    }
  } catch (error) {
    if (error instanceof FocusedOutputFailure) {
      sourceInventory = error.inventory; receipt = sourceInventory.receipts.at(-1); rejectedProviderOutput = JSON.stringify({ source: sourceInventory.sourceRaw, mapping: sourceInventory.mappingRaw });
      proposalResolved = sourceInventory.stageExecutions.every(stage => stage !== 'unknown'); tailRejected = true;
    }
    if (error instanceof GroupedExtractionOutputFailure) {
      receipt = error.receipt;
      rejectedProviderOutput = error.providerOutput;
      proposalResolved = true;
      tailRejected = true;
    }
    if (error instanceof DigitalOceanStreamFailure) receipt = error.receipt;
    errorCode =
      error instanceof AdaptiveError
        ? error.code
        : "extraction-outcome-unknown";
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
  }
  const settle = async (
    current: StoredDraft,
    rereadAllowed: boolean,
  ): Promise<StoredDraft> => {
    const op = current.draft.adaptive?.operations[expected.id];
    if (!sameAttempt(op, expected)) return current;
    if (
      op!.status !== "processing" ||
      current.draft.phase !== "conversation" ||
      current.draft.confirmed ||
      current.draft.safety?.paused
    ) {
      // Retain an actual late billing/termination receipt without changing
      // revision, eligibility, sources, question, capture or frozen review.
      if (op!.stream && ((receipt && !op!.stream.receipt) || (rejectedProviderOutput !== undefined && !op!.rawProposalAudit))) {
        const audit = structuredClone(current.draft), target = audit.adaptive!.operations[expected.id];
        if (receipt && !target.stream!.receipt) target.stream!.receipt = receipt;
        if (rejectedProviderOutput !== undefined && !target.rawProposalAudit) {
          const rawAudit = auditAdaptiveRawProposal(rejectedProviderOutput);
          if (rawAudit) target.rawProposalAudit = fitAdaptiveRawAudit(audit, expected.id, rawAudit);
        }
        try {
          return await store.save(current, audit);
        } catch {
          return store.read();
        }
      }
      return current; // Discard/review/confirmation defeats semantic application.
    }
    const next = structuredClone(current.draft),
      target = next.adaptive!.operations[expected.id];
    const sourceStillCurrent =
      current.draft.turns.some(
        (turn) =>
          turn.id === context.source.id &&
          turn.role === context.source.role &&
          turn.text === context.source.text &&
          turn.at === context.source.at &&
          turn.channel === context.source.channel,
      ) &&
      context.sources.every((source) =>
        current.draft.turns.some(
          (turn) =>
            turn.id === source.id &&
            turn.role === source.role &&
            turn.text === source.text &&
            turn.at === source.at &&
            turn.channel === source.channel,
        ),
      );
    const staleFocusedDependencies = (!!sourceInventory || !!typedResult) && streamSpeechScopeDigest(current.draft) !== streamSpeechScopeDigest(claimed.draft);
    if (staleFocusedDependencies) { errorCode = 'stale-focused-dependencies'; tailRejected = true; }
    let settledCapture =
      capture && !cancelled && options.now() < deadline && sourceStillCurrent && !staleFocusedDependencies
        ? structuredClone(capture)
        : undefined;
    if (capture && !sourceStillCurrent) errorCode = "stale-extraction-source";
    if (settledCapture)
      for (const claim of settledCapture.claims) {
        const path = claim.path.includes("[")
          ? claim.path.slice(0, claim.path.indexOf("["))
          : claim.path;
        const key = targetKey(claim.topicId, path);
        const edited =
          (next.adaptive!.targetGenerations?.[key] ?? 0) !==
            (target.stream!.targetGenerations[key] ?? 0) ||
          canonicalJson(next.topics[claim.topicId]?.answers[path] ?? null) !==
            canonicalJson(
              claimed.draft.topics[claim.topicId]?.answers[path] ?? null,
            );
        if (edited) {
          claim.status = "superseded";
          settledCapture.gaps.push({
            evidence: claim.evidence,
            reason: "conflict",
          });
        }
      }
    const bytes = (value: unknown) =>
      Buffer.byteLength(canonicalJson(value), "utf8");
    const otherCaptureBytes = Object.values(next.adaptive!.operations)
      .filter((item) => item.id !== expected.id)
      .reduce(
        (sum, item) =>
          sum +
          (item.stream?.provisional ? bytes(item.stream.provisional) : 0) +
          (item.stream?.navigation ? bytes(item.stream.navigation) : 0),
        target.stream?.navigation ? bytes(target.stream.navigation) : 0,
      );
    let capacityLimited =
      !!settledCapture &&
      (bytes(settledCapture) > 32768 ||
        otherCaptureBytes + bytes(settledCapture) > 131072);
    const minimalCapture = () => ({
      sourceId: context.source.id,
      policy: capture?.policy ?? "provisional-context-v1",
      claims: [],
      gaps: [
        {
          reason: "capacity" as const,
          evidence: [
            {
              sourceId: context.source.id,
              start: 0,
              end: context.source.text.length,
            },
          ],
        },
      ],
      accounting: {
        addressed: [],
        remaining: [
          {
            sourceId: context.source.id,
            start: 0,
            end: context.source.text.length,
          },
        ],
        semanticReview: "qualification-required" as const,
      },
    });
    if (capacityLimited) settledCapture = minimalCapture();
    target.stream!.capture =
      settledCapture && !capacityLimited ? "saved" : "partial";
    if (target.stream!.reply === "pending") target.stream!.reply = "withheld";
    if (settledCapture) target.stream!.provisional = settledCapture;
    if (sourceInventory) target.stream!.sourceInterpretation = structuredClone(sourceInventory);
    if (receipt) target.stream!.receipt = receipt;
    if (rejectedProviderOutput !== undefined) {
      const audit = auditAdaptiveRawProposal(rejectedProviderOutput);
      if (audit) target.rawProposalAudit = fitAdaptiveRawAudit(next, expected.id, audit);
    }
    target.status =
      settledCapture && !capacityLimited
        ? "applied"
        : capacityLimited || tailRejected || receipt?.outcome === "rejected"
          ? "failed"
          : "unresolved";
    if (
      settledCapture &&
      target.status === "applied" &&
      !cancelled &&
      sourceStillCurrent &&
      streamSpeechScopeDigest(current.draft) ===
        streamSpeechScopeDigest(claimed.draft)
    ) {
      target.displayed = context.displayed;
      const audit = typedResult ? undefined : groupedNavigationAudit(rawWire, planningManifest, settledCapture);
      if (audit)
        target.rawProposalAudit = fitAdaptiveRawAudit(next, expected.id, audit);
    }
    target.updatedAt = new Date(options.now()).toISOString();
    target.hasUnresolvedInterpretation = true;
    if (errorCode) target.errorCode = errorCode;
    if (
      (proposalResolved || receipt?.providerExecution === "completed") &&
      !next.safety?.paused
    ) {
      for (const queued of Object.values(next.adaptive!.operations)) {
        if (queued.status === "accepted" && queued.queuedAfter === expected.id)
          queued.queuedWaiting = false;
      }
    }
    const unchangedScope =
      streamSpeechScopeDigest(current.draft) ===
      streamSpeechScopeDigest(claimed.draft);
    const noUnresolvedSource = !!settledCapture;
    const localPlan =
      settledCapture &&
      !capacityLimited &&
      noUnresolvedSource &&
      unchangedScope &&
      !cancelled &&
      options.now() < deadline
        ? planGroupedExtraction(rawWire, planningManifest, next, { recognitionContinuation: options.recognitionContinuation, navigationContext: options.navigationContext?.(next), previousNavigationContext: context, ...(typedCompiled ? { compiled: { ...typedCompiled, capture: settledCapture }, recordLocal: true, recordControlsQualified: policyQualified(options.navigationContext?.(next).qualification, typedPolicyRevision) } : {}) })
        : undefined;
    if (
      localPlan &&
      "humanRequests" in localPlan &&
      localPlan.humanRequests?.length
    )
      target.unresolvedQuestions = localPlan.humanRequests.flatMap(
        (request) => request.evidence,
      );
    const question =
      localPlan?.status === "question" ? localPlan.question : undefined;
    if (
      settledCapture &&
      !capacityLimited &&
      unchangedScope &&
      !cancelled &&
      options.now() < deadline
    ) {
      next.adaptive!.exchange = question
        ? {
            state: { activeTopicId: question.topicId },
            prompt: structuredClone(question),
            ...(localPlan?.reply ? { reply: localPlan.reply } : {}),
            status: "question",
          }
        : {
            state: {
              activeTopicId:
                context.displayed?.topicId ??
                next.adaptive!.exchange?.state.activeTopicId,
            },
            ...(localPlan?.reply ? { reply: localPlan.reply } : {}),
            status: localPlan?.reply
              ? "review-available"
              : "interpretation-review",
          };
      if (question) {
        target.stream!.reply = "saved";
        target.stream!.replyId = `${expected.id}:${question.promptId}`;
        delete next.activeTopic;
        delete next.activeSlot;
        delete next.preview;
        target.stream!.replyScope = {
          revision: current.draft.revision + 1,
          sha256: streamSpeechScopeDigest(next),
        };
      }
    }
    if (bytes(next) > 491808 && settledCapture) {
      capacityLimited = true;
      settledCapture = minimalCapture();
      target.stream!.provisional = settledCapture;
      target.stream!.capture = "partial";
      target.status = "failed";
      target.stream!.reply = "withheld";
      delete target.stream!.replyId;
      delete target.stream!.replyScope;
      next.adaptive!.exchange = current.draft.adaptive?.exchange;
    }
    if (capacityLimited) target.errorCode = "provisional-capacity";
    if (settledCapture) target.resultDigest = await digest(settledCapture);
    let saved: StoredDraft;
    try {
      saved = await save(current, next);
    } catch (error) {
      if (error instanceof ApiFailure && error.code === "stale-session") {
        const fresh = await store.read();
        // One metadata-only recompute closes the ordinary queued/edit CAS race.
        // Provider work is never replayed; a second race remains visible pending.
        return rereadAllowed ? settle(fresh, false) : fresh;
      }
      throw error;
    }
    if (settledCapture && !capacityLimited)
      captureSavedMs = options.now() - started;
    const committedQuestion =
      !!question &&
      !capacityLimited &&
      saved.draft.adaptive?.operations[expected.id].stream?.reply === "saved";
    if (committedQuestion) {
      nextQuestionSavedMs = options.now() - started;
      notificationStatus = "suppressed";
    }
    // A committed write remains known even if fresh read or notification fails.
    let fresh: StoredDraft;
    try {
      fresh = await store.read();
    } catch {
      if (committedQuestion) notificationStatus = "fresh-read-failed";
      return saved;
    }
    const freshOp = fresh.draft.adaptive?.operations[expected.id];
    if (
      committedQuestion &&
      !cancelled &&
      !options.signal?.aborted &&
      options.now() < deadline &&
      sameAttempt(freshOp, expected) &&
      freshOp!.status === "applied" &&
      fresh.draft.phase === "conversation" &&
      !fresh.draft.confirmed &&
      !fresh.draft.safety?.paused &&
      freshOp!.stream?.reply === "saved" &&
      freshOp!.stream.replyScope?.sha256 ===
        streamSpeechScopeDigest(fresh.draft)
    ) {
      if (!options.onReplySaved) notificationStatus = "not-configured";
      else
        try {
          options.onReplySaved(fresh.draft);
          notificationStatus = "sent";
        } catch {
          notificationStatus = "failed";
        }
    }
    return fresh;
  };

  try {
    const stored = await settle(await store.read(), true);
    return {
      stored,
      timings: { captureValidatedMs, captureSavedMs, nextQuestionSavedMs },
      notificationStatus,
      localQuestionOrigin:
        "issued-local-content-after-complete-capture" as const,
    };
  } finally {
    if (abortListener)
      options.signal?.removeEventListener("abort", abortListener);
  }
}
