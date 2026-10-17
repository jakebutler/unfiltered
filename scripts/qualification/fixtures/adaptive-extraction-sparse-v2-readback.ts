import {
  createFullReplyManifest,
  prepareFullCapture,
  type FullReplyDraft,
} from "../../../packages/clinic-api/src/adaptive-reply-full.js";
import { runGroupedExtractionOperation } from "../../../packages/clinic-api/src/adaptive-extraction-grouped-session-v2.js";
import { conversation } from "../../../packages/clinic-api/src/conversation.js";
import {
  document,
  readDraft,
  DRAFT_SYSTEM,
} from "../../../packages/clinic-api/src/store.js";
import {
  ApiFailure,
  type AdaptiveOperation,
  type ClinicApiConfig,
  type Draft,
  type StoredDraft,
} from "../../../packages/clinic-api/src/types.js";
import type { DigitalOceanStreamReceipt } from "../../../packages/clinical-core/src/digitalocean-stream.js";
import { DigitalOceanStreamFailure } from "../../../packages/clinical-core/src/digitalocean-stream.js";
import type { MedplumClient } from "../../../packages/clinical-core/src/medplum.js";
import { developmentUuid } from "./adaptive-full-cases.js";
import { groupedCaseContext } from "./adaptive-extraction-grouped-v2-cases.js";
import { createSparseManifest, decodeSparseExtraction } from "../extraction-sparse-v2-manifest.js";
import { getNativeQuestionnaireDefinition } from "../../../packages/clinic-content/src/native-questionnaire.js";
export function sparseCaseContext(id: string) {
  const context = groupedCaseContext(id);
  return { ...context, nativeRouting: {} };
}

/** Replay the one already-observed response through real settlement and document
 * readback. This does not dispatch, qualify the policy or claim live durability. */
export async function sparseCaseReadback(
  id: string,
  observed: {
    raw?: unknown;
    receipt?: DigitalOceanStreamReceipt;
    errorCode?: string;
  },
) {
  const context = sparseCaseContext(id),
    patient = {
      reference: context.binding.patient,
      displayName: "Synthetic development",
      description: "No real patient",
      careTeams: {
        medical: "CareTeam/md",
        nutrition: "CareTeam/rd",
        administrative: "CareTeam/admin",
      },
    };
  const content = conversation({
      mentalHealth: "phq4",
      patients: { [context.binding.scenario]: patient },
    } as ClinicApiConfig),
    at = context.source.at;
  const operation = (
    opId: string,
    sourceId: string,
    revision: number,
  ): AdaptiveOperation => ({
    id: opId,
    requestId: opId,
    sourceId,
    fingerprint: "synthetic-response-replay",
    status: "processing",
    acceptedAt: at,
    updatedAt: at,
    binding: { ...context.binding, operationId: opId, revision },
    attemptId: opId,
    processingRevision: revision + 1,
    deadlineAt: new Date(Date.now() + 35000).toISOString(),
    stream: {
      protocol: "durable-provisional-stream-v1",
      reply: "pending",
      capture: "pending",
      targetGenerations: {},
    },
  });
  const op = operation(
      context.binding.operationId,
      context.source.id,
      context.binding.revision,
    ),
    operations: Record<string, AdaptiveOperation> = { [op.id]: op };
  if (id === "G7") {
    const prior = context.sources[0],
      oldId = developmentUuid(999),
      old = operation(oldId, prior.id, 1),
      priorContext = {
        ...context,
        source: prior,
        sources: [prior],
        captureResponses: undefined,
        binding: { ...context.binding, operationId: oldId, revision: 1 },
      };
    const manifest = createFullReplyManifest(priorContext),
      payload = JSON.parse(String(manifest.messages[1].content));
    const target = (path: string) =>
      manifest.targets.find((t) => t.topicId === "Q08" && t.path === path)!.id;
    const raw: FullReplyDraft = {
      manifestId: manifest.id,
      claims: [],
      items: [],
      closures: [],
      acts: [],
      residual: [],
      sourceDisposition: "represented",
    };
    for (const [key, entity, strength] of [
      ["met", "Metformin", "850 mg"],
      ["vit", "Vitamin D", "1000 IU"],
    ]) {
      const statement = payload.statements.find((s: { text: string }) =>
          s.text.includes(entity),
        ),
        ev = { statementId: statement.id, quote: statement.text };
      raw.items.push({
        collectionId: target("medicines"),
        key,
        entity,
        evidence: [ev],
      });
      for (const [path, value] of [
        ["name", entity],
        ["strength", strength],
      ])
        raw.claims.push({
          targetId: target(`medicines[new].${path}`),
          itemKey: key,
          state: "known",
          value,
          valueEvidence: ev,
          evidence: [ev],
          scope: { subject: "patient", entity, period: null, predicate: ev },
          correctsSourceIds: [],
        });
    }
    old.status = "applied";
    old.resultDigest = "a".repeat(64);
    old.stream!.reply = "withheld";
    old.stream!.capture = "saved";
    old.stream!.provisional = prepareFullCapture(raw, manifest);
    operations[oldId] = old;
  }
  const draft: Draft = {
    schema: 1,
    id: context.binding.sessionId,
    patient: context.binding.patient,
    scenario: context.binding.scenario,
    revision: op.processingRevision!,
    createdAt: at,
    savedAt: at,
    phase: "conversation",
    turns: context.sources.map((source) => ({ ...source, channel: "text" })),
    topics: context.responses as Draft["topics"],
    requests: Object.fromEntries(
      Object.values(operations).map((item) => [
        item.requestId,
        {
          operationId: item.id,
          revision: item.binding.revision,
          fingerprint: item.fingerprint,
        },
      ]),
    ),
    version: 1,
    adaptive: {
      mode: "adaptive",
      operations,
      activeOperationId: op.id,
      targetGenerations: {},
    },
  };
  let stored: StoredDraft = {
    draft,
    versionId: "1",
    resource: {
      ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft),
      id: "offline",
      meta: { versionId: "1" },
    },
  };
  const client = {
    request: async () => ({
      body: {
        resourceType: "Bundle",
        type: "searchset",
        total: 1,
        entry: [{ resource: structuredClone(stored.resource) }],
      },
    }),
  } as unknown as MedplumClient;
  const store = {
    read: () => readDraft(client, draft.id, draft.patient),
    save: async (previous: StoredDraft, next: Draft) => {
      if (previous.versionId !== stored.versionId)
        throw new ApiFailure("stale-session", 409);
      const versionId = String(Number(stored.versionId) + 1);
      stored = {
        draft: structuredClone(next),
        versionId,
        resource: {
          ...document(DRAFT_SYSTEM, draft.id, draft.patient, next),
          id: "offline",
          meta: { versionId },
        },
      };
      return store.read();
    },
  };
  const settled = await runGroupedExtractionOperation(
    store,
    await store.read(),
    context,
    {
      extract: async (_context, groupedManifest) => {
        if (observed.raw === undefined)
          throw new DigitalOceanStreamFailure(
            observed.errorCode ?? "synthetic-no-extraction",
            observed.receipt ?? {
              model: "qwen3.8-max",
              requestBytes: 0,
              outcome: "unknown",
              providerExecution: "unknown",
              usage: "unknown",
              timings: { dispatchMs: 0 },
              contentBytes: 0,
            },
          );
        const manifest = await createSparseManifest(context, groupedManifest);
        return { raw: decodeSparseExtraction(observed.raw, manifest).groupedWire, receipt: observed.receipt };
      },
    },
    { now: () => Date.now(), timeoutMs: 35000 },
  );
  const saved = (await store.read()).draft,
    projection = content.effective(saved),
    view = content.view(saved, true, true),
    preview = await content.preview(saved);
  return {
    offlineResponseReplay: true,
    nativeDefinition: (await getNativeQuestionnaireDefinition()).binding,
    nativeMappingQualified: false,
    localQuestionOrigin: settled.localQuestionOrigin,
    timings: settled.timings,
    notificationStatus: settled.notificationStatus,
    liveReplyDurabilityQualified: false,
    policyQualified: false,
    defaultEnabled: false,
    savedDraft: saved,
    projection: {
      ...projection,
      creditedSourceIds: [...projection.creditedSourceIds],
    },
    view,
    preview,
  };
}
