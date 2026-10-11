import { canonicalJson, digest } from "../../clinical-core/src/domain.js";
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
} from "./adaptive-extraction-grouped.js";
import type { FullReplyDraft } from "./adaptive-reply-full.js";
import type { ProvisionalCapture } from "./provisional-draft.js";
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
/** Isolated injection experiment: completed extraction then atomic provisional capture/local question save. No provider factory or production mount. */
export async function runGroupedExtractionOperation(
  store: AdaptiveDraftStore,
  claimed: StoredDraft,
  context: AdaptiveContext,
  proposer: {
    extract(
      context: AdaptiveContext,
      manifest: GroupedExtractionManifest,
      options: { signal: AbortSignal },
    ): Promise<{ raw: unknown; receipt?: DigitalOceanStreamReceipt }>;
  },
  options: {
    now: () => number;
    timeoutMs: number;
    signal?: AbortSignal;
    onReplySaved?: (draft: Draft) => void;
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
        turn.at === context.source.at,
    ) ||
    context.sources.some(
      (source) =>
        !claimed.draft.turns.some(
          (turn) =>
            turn.id === source.id &&
            turn.role === source.role &&
            turn.text === source.text &&
            turn.at === source.at,
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
      const compiled = compileGroupedExtraction(rawWire, manifest);
      compiledDraft = compiled.draft;
      capture = compiled.capture;
      captureValidatedMs = options.now() - started;
    } catch {
      tailRejected = true;
      throw new AdaptiveError("invalid-grouped-extraction");
    }
  } catch (error) {
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
      if (receipt && op!.stream && !op!.stream.receipt) {
        const audit = structuredClone(current.draft);
        audit.adaptive!.operations[expected.id].stream!.receipt = receipt;
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
          turn.at === context.source.at,
      ) &&
      context.sources.every((source) =>
        current.draft.turns.some(
          (turn) =>
            turn.id === source.id &&
            turn.role === source.role &&
            turn.text === source.text &&
            turn.at === source.at,
        ),
      );
    let settledCapture =
      capture && !cancelled && options.now() < deadline && sourceStillCurrent
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
    if (receipt) target.stream!.receipt = receipt;
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
      const audit = groupedNavigationAudit(rawWire, manifest, settledCapture);
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
        ? planGroupedExtraction(rawWire, manifest, next)
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
