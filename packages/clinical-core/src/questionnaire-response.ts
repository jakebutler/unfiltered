import { z } from "zod";
import {
  getNativeQuestionnaireDefinition,
  nativeCanonicalJson,
  nativeCaptureComplete,
  nativeCrossTopicReuses,
  nativeSourceFactValid,
  nativeResolveSlot,
  nativeRoutingDecisions,
  nativeRoutingRules,
  nativeSlotEntries,
  nativeTopics,
  NATIVE_EXTENSION,
  NATIVE_QUESTIONNAIRE_CANONICAL,
  NATIVE_QUESTIONNAIRE_VERSION,
  type NativeQuestionnaireCapture,
  type NativeInactiveAnswer,
  type NativeRoutingContext,
  type NativeRoutingDecision,
  type NativeRepresentationAuthority,
} from "../../clinic-content/src/native-questionnaire.js";
import type {
  SlotAnswer,
  SlotAnswers,
  SlotDefinition,
  TopicResponse,
} from "../../clinic-content/src/types.js";

const sourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const sources = z.array(sourceId).max(600);
const instanceId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const bounded = z.string().min(1).max(12000);
const states = [
  "known",
  "negative",
  "unknown",
  "declined",
  "uncertain",
  "skipped",
  "not-asked",
  "not-applicable",
  "conflicting",
] as const;
const nonValue = [
  "negative",
  "unknown",
  "declined",
  "uncertain",
  "skipped",
  "not-applicable",
  "conflicting",
] as const;
const scalar = z.union([
  bounded,
  z.number().finite(),
  z.boolean(),
  z
    .object({
      feet: z.number().int().nonnegative(),
      inches: z.number().min(0).lt(12),
    })
    .strict(),
]);
export const nativeSlotAnswerSchema: z.ZodType<SlotAnswer> = z.lazy(() =>
  z.union([
    z
      .object({
        state: z.literal("known"),
        value: scalar,
        sourceIds: sources,
        reusedFrom: z
          .union([
            z
              .object({
                topicId: z.literal("Q06"),
                path: z.literal("conditions.sleepApnea"),
              })
              .strict(),
            z
              .object({
                topicId: z.literal("Q07"),
                path: z.string().regex(/^events\[[A-Za-z0-9_-]+\]\.effects$/),
              })
              .strict(),
          ])
          .optional(),
      })
      .strict(),
    z
      .object({
        state: z.literal("known"),
        items: z
          .array(
            z
              .object({
                id: instanceId,
                answers: z.record(nativeSlotAnswerSchema),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        complete: z.boolean(),
        sourceIds: sources,
      })
      .strict(),
    z
      .object({
        state: z.enum(nonValue),
        note: bounded.optional(),
        sourceIds: sources,
      })
      .strict(),
    z
      .object({
        state: z.literal("not-asked"),
        sourceIds: z.tuple([]).optional(),
      })
      .strict(),
  ]),
);
const topicSchema = z
  .object({
    presented: z.boolean(),
    answers: z.record(nativeSlotAnswerSchema),
    stopped: z
      .enum([
        "not-applicable",
        "patient-declines",
        "patient-moves-on",
        "resistance-after-purpose",
        "safety-interruption",
      ])
      .optional(),
    applicability: z
      .enum(["applicable", "not-applicable", "unknown"])
      .optional(),
    applicabilitySourceIds: sources.optional(),
  })
  .strict();
const sourceFact = z
  .object({
    topicId: sourceId,
    path: z.string().min(1).max(300),
    sourceIds: sources,
  })
  .strict();
export const nativeRoutingContextSchema = z
  .object({
    appointment: z
      .object({
        reference: z.string().regex(/^Appointment\/[A-Za-z0-9.-]+$/),
        version: sourceId,
        startsAt: z.string().datetime(),
        timezone: bounded,
        priorUpdateAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    plan: z
      .object({
        reference: z
          .string()
          .regex(/^(CarePlan|DocumentReference)\/[A-Za-z0-9.-]+$/),
        version: sourceId,
        author: bounded,
        recordedAt: z.string().datetime(),
        text: bounded,
      })
      .strict()
      .optional(),
    sleepApnea: sourceFact.optional(),
    surgeryEatingEffect: sourceFact.optional(),
    reproductive: sourceFact.optional(),
    preparation: z.array(sourceFact).max(100).optional(),
    administrationUnclear: z
      .union([sourceFact, z.array(sourceFact).max(100)])
      .optional(),
    immediateSignsUnclear: sourceFact.optional(),
    gainAfterSchool: sourceFact.optional(),
    engagementUnclear: sourceFact
      .extend({
        purposeExplained: z.literal(true),
        unsuccessfulAttempts: z.number().int().min(2).max(1000),
      })
      .strict()
      .optional(),
  })
  .strict();
const decisionSchema = z
  .object({
    ruleId: z.string().min(1).max(300),
    outcome: z.enum(["applicable", "not-applicable", "unknown"]),
    sourceIds: sources,
    instanceId: instanceId.optional(),
  })
  .strict();
const inactiveSchema = z
  .object({
    topicId: sourceId,
    path: z.string().min(1).max(300),
    answer: nativeSlotAnswerSchema,
    reason: z.enum([
      "disabled-by-correction",
      "applicability-unknown",
      "unreviewed-recognition",
    ]),
    ruleId: z.string().min(1).max(300),
  })
  .strict();
/** This strict schema can be inserted in the intrinsic Submission parser before digesting. */
export const nativeQuestionnaireCaptureSchema: z.ZodType<NativeQuestionnaireCapture> =
  z
    .object({
      schemaVersion: z.literal(1),
      definition: z
        .object({
          canonical: z.literal(NATIVE_QUESTIONNAIRE_CANONICAL),
          version: z.literal(NATIVE_QUESTIONNAIRE_VERSION),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      scenario: z.enum([
        "first-intake",
        "pre-visit",
        "non-visit",
        "post-visit",
        "billing",
        "scheduling",
        "refill",
      ]),
      relevantTopicIds: z
        .array(
          z.enum([
            "Q01",
            "Q02",
            "Q03",
            "Q04",
            "Q05",
            "Q06",
            "Q07",
            "Q08",
            "Q09",
            "Q10",
            "Q11",
            "Q12",
            "Q13",
            "Q14",
            "Q15",
            "Q16",
            "Q17",
            "Q18",
            "Q19",
            "Q20",
            "Q21",
            "Q22",
          ]),
        )
        .max(22),
      topics: z.record(topicSchema),
      routingDecisions: z.array(decisionSchema).max(1500),
      unreviewedSourceIds: sources,
      reviewBinding: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      context: nativeRoutingContextSchema.optional(),
      inactiveHistory: z.array(inactiveSchema).max(1500).optional(),
    })
    .strict();
export class NativeQuestionnaireError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "NativeQuestionnaireError";
  }
}
const ensure = (condition: unknown, code: string): void => {
  if (!condition) throw new NativeQuestionnaireError(code);
};
const evidenceOf = (
  validSourceIds: ReadonlySet<string>,
  unreviewed: readonly string[],
  authority?: NativeRepresentationAuthority,
) => ({
  validSourceIds: new Set(
    [...validSourceIds].filter((id) => !unreviewed.includes(id)),
  ),
  ...(authority ? { reviewedFact: authority.reviewedFact, reviewedSourceAccountedFor: authority.reviewedSourceAccountedFor } : {}),
});
function validateAnswers(
  slots: readonly SlotDefinition[],
  answers: SlotAnswers,
  validSourceIds: ReadonlySet<string>,
  prefix = "",
): void {
  ensure(
    Object.keys(answers).every((id) => slots.some((slot) => slot.id === id)),
    "unknown-questionnaire-slot",
  );
  for (const slot of slots) {
    const answer = answers[slot.id];
    if (!answer) continue;
    ensure(
      (answer.sourceIds ?? []).every((id) => validSourceIds.has(id)),
      "questionnaire-source-out-of-scope",
    );
    ensure(
      new Set(answer.sourceIds).size === (answer.sourceIds?.length ?? 0),
      "duplicate-questionnaire-source",
    );
    if (answer.state === "not-asked") continue;
    ensure(!!answer.sourceIds.length, "questionnaire-answer-without-source");
    if (answer.state !== "known") {
      if (answer.state === "negative")
        ensure(slot.acceptsNegative, "questionnaire-negative-not-allowed");
      if (answer.state === "not-applicable")
        ensure(
          slot.acceptsNotApplicable,
          "questionnaire-not-applicable-not-allowed",
        );
      continue;
    }
    if (slot.kind === "collection") {
      ensure(
        !!answer.items?.length && answer.value === undefined,
        "questionnaire-collection-shape",
      );
      const ids = answer.items!.map((item) => item.id);
      ensure(
        new Set(ids).size === ids.length,
        "duplicate-questionnaire-instance",
      );
      for (const item of answer.items!)
        validateAnswers(
          slot.fields ?? [],
          item.answers,
          validSourceIds,
          `${prefix}${slot.id}[${item.id}].`,
        );
      continue;
    }
    ensure(!answer.items, "questionnaire-scalar-shape");
    const value = answer.value;
    const valid =
      slot.kind === "text"
        ? typeof value === "string" && !!value.trim()
        : slot.kind === "positive-number"
          ? typeof value === "number" && Number.isFinite(value) && value > 0
          : slot.kind === "height-value"
            ? typeof value === "number"
              ? value > 0
              : typeof value === "object" && value.feet * 12 + value.inches > 0
            : slot.kind === "presence"
              ? value === true
              : slot.kind === "choice"
                ? slot.choices?.includes(value as string | number | boolean)
                : false;
    ensure(valid, "invalid-questionnaire-value");
    if (slot.id === "serviceDate" || slot.id === "requestedDate")
      ensure(
        typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value,
        "invalid-questionnaire-date",
      );
    if (slot.id === "statedAt" || slot.id.endsWith(".statedAt"))
      ensure(
        typeof value === "string" && Number.isFinite(Date.parse(value)),
        "invalid-questionnaire-timestamp",
      );
  }
}
function parseNativeQuestionnaireCaptureShape(
  input: unknown,
  validSourceIds?: ReadonlySet<string>,
  allowStaleReuse = false,
  authority?: NativeRepresentationAuthority,
): NativeQuestionnaireCapture {
  const parsed = nativeQuestionnaireCaptureSchema.safeParse(input);
  ensure(parsed.success, "invalid-questionnaire-capture");
  const capture = parsed.data!;
  ensure(!capture.reviewBinding || capture.reviewBinding === authority?.binding, "questionnaire-review-authority-mismatch");
  ensure(
    new TextEncoder().encode(nativeCanonicalJson(capture)).byteLength <= 400000,
    "questionnaire-capture-too-large",
  );
  const topics = nativeTopics();
  ensure(
    Object.keys(capture.topics).every((id) => topics.some((t) => t.id === id)),
    "unknown-questionnaire-topic",
  );
  ensure(
    new Set(capture.relevantTopicIds).size === capture.relevantTopicIds.length,
    "duplicate-relevant-topic",
  );
  if (validSourceIds) {
    for (const [name, value] of Object.entries(capture.context ?? {})) {
      if (name === "appointment" || name === "plan") continue;
      const facts = Array.isArray(value) ? value : [value];
      for (const fact of facts) {
        ensure(
          fact.sourceIds.length > 0 &&
            fact.sourceIds.every((id: string) => validSourceIds.has(id)),
          "questionnaire-context-source-out-of-scope",
        );
        const definition = topics.find((topic) => topic.id === fact.topicId);
        ensure(definition, "questionnaire-context-topic-unknown");
        let resolved: ReturnType<typeof nativeResolveSlot>;
        try {
          resolved = nativeResolveSlot(
            definition!,
            capture.topics[fact.topicId] ?? { presented: false, answers: {} },
            fact.path,
          );
        } catch {
          throw new NativeQuestionnaireError(
            "questionnaire-context-slot-unknown",
          );
        }
        if (name === "engagementUnclear") continue;
        ensure(
          resolved.answer &&
            fact.sourceIds.every((id: string) =>
              (
                resolved.answer!.sourceIds as readonly string[] | undefined
              )?.includes(id),
            ),
          "questionnaire-context-evidence-mismatch",
        );
        if (name === "sleepApnea")
          ensure(
            fact.topicId === "Q15" && fact.path === "condition",
            "questionnaire-context-anchor-mismatch",
          );
        if (name === "surgeryEatingEffect")
          ensure(
            fact.topicId === "Q07" &&
              /^events\[[A-Za-z0-9_-]+\]\.effects$/.test(fact.path),
            "questionnaire-context-anchor-mismatch",
          );
        if (name === "preparation")
          ensure(
            fact.topicId === "Q11" &&
              /^occasions\[[A-Za-z0-9_-]+\]\.(foods|drinks)$/.test(fact.path),
            "questionnaire-context-anchor-mismatch",
          );
        if (name === "administrationUnclear")
          ensure(
            (fact.topicId === "Q08" &&
              /^medicines\[[A-Za-z0-9_-]+\]\.(actualUse|concerns)$/.test(
                fact.path,
              )) ||
              (fact.topicId === "W07" &&
                ["actualUse", "symptomsChanges"].includes(fact.path)),
            "questionnaire-context-anchor-mismatch",
          );
        if (name === "immediateSignsUnclear")
          ensure(
            fact.topicId === "Q02" && ["concern", "impact"].includes(fact.path),
            "questionnaire-context-anchor-mismatch",
          );
        if (name === "gainAfterSchool")
          ensure(
            fact.topicId === "Q03" && fact.path === "afterSchool",
            "questionnaire-context-anchor-mismatch",
          );
      }
    }
    ensure(
      capture.unreviewedSourceIds.every((id) => validSourceIds.has(id)),
      "unreviewed-source-out-of-scope",
    );
    for (const [id, response] of Object.entries(capture.topics)) {
      validateAnswers(
        topics.find((t) => t.id === id)!.slots,
        response.answers,
        validSourceIds,
      );
      ensure(
        (response.applicabilitySourceIds ?? []).every((id) =>
          validSourceIds.has(id),
        ),
        "questionnaire-applicability-source-out-of-scope",
      );
    }
    const reuseProposals = nativeCrossTopicReuses(
      { topics: capture.topics, context: capture.context },
      evidenceOf(validSourceIds, capture.unreviewedSourceIds, authority),
    );
    for (const [topicId, response] of Object.entries(capture.topics)) {
      const checkReuse = (answers: SlotAnswers, prefix = "") => {
        for (const [slotId, answer] of Object.entries(answers)) {
          if (answer?.state !== "known") continue;
          if (answer.items) {
            for (const item of answer.items)
              checkReuse(item.answers, `${prefix}${slotId}[${item.id}].`);
            continue;
          }
          if (answer.reusedFrom) {
            if (!allowStaleReuse)
              ensure(
                nativeCanonicalJson(answer) ===
                  nativeCanonicalJson(
                    reuseProposals.find(
                      (entry) =>
                        entry.topicId === topicId &&
                        entry.path === prefix + slotId,
                    )?.answer,
                  ),
                "questionnaire-reuse-source-mismatch",
              );
            ensure(
              (topicId === "GI" &&
                prefix + slotId === "effect" &&
                answer.reusedFrom.topicId === "Q07") ||
                (topicId === "Q15" &&
                  prefix + slotId === "condition" &&
                  answer.reusedFrom.topicId === "Q06"),
              "questionnaire-reuse-target-mismatch",
            );
          }
        }
      };
      checkReuse(response.answers);
    }
    for (const entry of capture.inactiveHistory ?? []) {
      const topic = topics.find((t) => t.id === entry.topicId);
      ensure(topic, "unknown-questionnaire-history-topic");
      // Resolve using active collection ownership; inactive collection snapshots keep their own children.
      const slotPath = entry.path.replace(/\[[^\]]+\]/g, "[*]"),
        definition = nativeSlotEntries([topic!]).find(
          (s) => s.path === slotPath,
        );
      ensure(definition, "unknown-questionnaire-history-slot");
      validateAnswers(
        [definition!.slot],
        { [definition!.slot.id]: entry.answer },
        validSourceIds,
      );
    }
  }
  return capture;
}
/** Public intrinsic boundary always validates marked active reuse against its current origin. */
export function validateNativeQuestionnaireCaptureShape(
  input: unknown,
  validSourceIds?: ReadonlySet<string>,
  authority?: NativeRepresentationAuthority,
): NativeQuestionnaireCapture {
  return parseNativeQuestionnaireCaptureShape(input, validSourceIds, false, authority);
}
function decisionFor(
  decisions: NativeRoutingDecision[],
  topicId: string,
  path: string,
): NativeRoutingDecision | undefined {
  const template = `slot.${topicId}.${path.replace(/\[[^\]]+\]/g, "[*]")}`,
    instanceId = /\[([^\]]+)\]/.exec(path)?.[1];
  return decisions.find(
    (d) => d.ruleId === template && d.instanceId === instanceId,
  );
}
/** Move inactive values into explicit history; never silently revive a value from history. */
function projectActive(
  capture: NativeQuestionnaireCapture,
  validSourceIds: ReadonlySet<string>,
  authority?: NativeRepresentationAuthority,
): NativeQuestionnaireCapture {
  const projected = structuredClone(capture),
    evidence = evidenceOf(validSourceIds, capture.unreviewedSourceIds, authority),
    history = [...(capture.inactiveHistory ?? [])];
  const inactive = (
    topicId: string,
    path: string,
    answer: SlotAnswer,
    reason: NativeInactiveAnswer["reason"],
    ruleId: string,
  ) => {
    const entry = {
      topicId,
      path,
      answer: structuredClone(answer),
      reason,
      ruleId,
    };
    if (
      !history.some(
        (old) => nativeCanonicalJson(old) === nativeCanonicalJson(entry),
      )
    )
      history.push(entry);
  };
  const proposals = nativeCrossTopicReuses(
    { topics: projected.topics, context: projected.context },
    evidence,
  );
  for (const [topicId, path] of [
    ["GI", "effect"],
    ["Q15", "condition"],
  ] as const) {
    const response = projected.topics[topicId];
    const current = response?.answers[path];
    const proposal = proposals.find(
      (entry) => entry.topicId === topicId && entry.path === path,
    );
    let replaceable = !current || current.state === "not-asked";
    if (
      current?.state === "known" &&
      !current.items &&
      current.reusedFrom &&
      nativeCanonicalJson(current) !== nativeCanonicalJson(proposal?.answer)
    ) {
      inactive(
        topicId,
        path,
        current,
        "disabled-by-correction",
        "reuse.origin-correction",
      );
      if (response) {
        const answers = { ...response.answers };
        delete answers[path];
        projected.topics[topicId] = { ...response, answers };
      }
      replaceable = true;
    }
    if (replaceable && proposal) {
      const existing = projected.topics[topicId] ?? {
        presented: false,
        answers: {},
      };
      projected.topics[topicId] = {
        ...existing,
        answers: { ...existing.answers, [path]: proposal.answer },
      };
    }
  }
  const decisions = nativeRoutingDecisions(
    { topics: projected.topics, context: projected.context },
    evidence,
  );
  const walk = (
    topicId: string,
    slots: readonly SlotDefinition[],
    answers: SlotAnswers,
    prefix = "",
  ): SlotAnswers => {
    const result: Record<string, SlotAnswer> = {};
    for (const slot of slots) {
      const answer = answers[slot.id];
      if (!answer) continue;
      const path = prefix + slot.id,
        decision = decisionFor(decisions, topicId, path);
      const unreviewed =
        (answer.state === "known" || !!authority && answer.state !== "not-asked") &&
        (answer.sourceIds ?? []).some((id) => capture.unreviewedSourceIds.includes(id)) && !authority?.reviewedFact(topicId, path, answer);
      if (unreviewed || (decision && decision.outcome !== "applicable")) {
        if (answer.state !== "not-asked")
          inactive(
            topicId,
            path,
            answer,
            unreviewed
              ? "unreviewed-recognition"
              : decision?.outcome === "not-applicable"
                ? "disabled-by-correction"
                : "applicability-unknown",
            unreviewed ? "recognition.review" : decision!.ruleId,
          );
        continue;
      }
      result[slot.id] =
        answer.state === "known" && answer.items
          ? {
              ...answer,
              items: answer.items.map((item) => ({
                ...item,
                answers: walk(
                  topicId,
                  slot.fields ?? [],
                  item.answers,
                  `${path}[${item.id}].`,
                ),
              })),
            }
          : answer;
    }
    return result;
  };
  for (const topic of nativeTopics()) {
    const response = projected.topics[topic.id];
    if (!response) continue;
    const rule = decisions.find(
      (d) =>
        [
          "branch.diabetes",
          "branch.sleep-apnea",
          "branch.digestive",
          "branch.reproductive",
        ].includes(d.ruleId) &&
        {
          "branch.diabetes": "DM",
          "branch.sleep-apnea": "SLEEP",
          "branch.digestive": "GI",
          "branch.reproductive": "Q18",
        }[d.ruleId] === topic.id,
    );
    let answers = walk(topic.id, topic.slots, response.answers);
    if (rule) {
      if (rule.outcome !== "applicable") {
        for (const [path, answer] of Object.entries(answers))
          if (answer)
            inactive(
              topic.id,
              path,
              answer,
              rule.outcome === "not-applicable"
                ? "disabled-by-correction"
                : "applicability-unknown",
              rule.ruleId,
            );
        answers = {};
      }
      projected.topics[topic.id] = {
        ...response,
        answers,
        applicability: rule.outcome,
        applicabilitySourceIds: rule.sourceIds,
      };
    } else projected.topics[topic.id] = { ...response, answers };
  }
  const measurements = projected.topics.Q04;
  const height = measurements?.answers["height.value"];
  const unit = measurements?.answers["height.unit"];
  if (
    height?.state === "known" &&
    !height.items &&
    unit?.state === "known" &&
    !unit.items &&
    (typeof height.value === "object") !== (unit.value === "ft-in")
  ) {
    inactive(
      "Q04",
      "height.value",
      height,
      "applicability-unknown",
      "measurement.height-unit",
    );
    projected.topics.Q04 = {
      ...measurements,
      answers: {
        ...measurements.answers,
        "height.value": {
          state: "conflicting",
          sourceIds: [...new Set([...height.sourceIds, ...unit.sourceIds])],
        },
      },
    };
  }
  if (projected.context) {
    // Facts whose original ownership was removed cannot remain dangling routing anchors.
    for (const key of [
      "sleepApnea",
      "surgeryEatingEffect",
      "reproductive",
      "preparation",
      "administrationUnclear",
      "immediateSignsUnclear",
      "gainAfterSchool",
    ] as const) {
      const value = projected.context[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        const active = value.filter((fact) =>
          nativeSourceFactValid(fact, projected.topics, evidence),
        );
        if (active.length)
          (projected.context as Record<string, unknown>)[key] = active;
        else delete projected.context[key];
      } else if (!nativeSourceFactValid(value, projected.topics, evidence))
        delete projected.context[key];
    }
  }
  projected.inactiveHistory = history;
  projected.routingDecisions = nativeRoutingDecisions(
    { topics: projected.topics, context: projected.context },
    evidence,
  );
  return projected;
}
export async function buildNativeQuestionnaireCapture(input: {
  scenario: NativeQuestionnaireCapture["scenario"];
  relevantTopicIds?: readonly NativeQuestionnaireCapture["relevantTopicIds"][number][];
  topics: Readonly<Record<string, TopicResponse | undefined>>;
  validSourceIds: ReadonlySet<string>;
  unreviewedSourceIds?: readonly string[];
  context?: NativeRoutingContext;
  inactiveHistory?: readonly NativeInactiveAnswer[];
  representationAuthority?: NativeRepresentationAuthority;
}): Promise<NativeQuestionnaireCapture> {
  const definition = await getNativeQuestionnaireDefinition();
  const capture: NativeQuestionnaireCapture = {
    schemaVersion: 1,
    definition: definition.binding,
    scenario: input.scenario,
    relevantTopicIds: [...(input.relevantTopicIds ?? [])],
    topics: Object.fromEntries(
      Object.entries(input.topics).filter(
        (entry): entry is [string, TopicResponse] => !!entry[1],
      ),
    ),
    routingDecisions: [],
    unreviewedSourceIds: [...(input.unreviewedSourceIds ?? [])],
    ...(input.representationAuthority ? { reviewBinding: input.representationAuthority.binding } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.inactiveHistory
      ? { inactiveHistory: [...input.inactiveHistory] }
      : {}),
  };
  parseNativeQuestionnaireCaptureShape(capture, input.validSourceIds, true, input.representationAuthority);
  const projected = projectActive(capture, input.validSourceIds, input.representationAuthority);
  await validateNativeQuestionnaireCapture(projected, input.validSourceIds, input.representationAuthority);
  return projected;
}
export async function validateNativeQuestionnaireCapture(
  input: unknown,
  validSourceIds: ReadonlySet<string>,
  authority?: NativeRepresentationAuthority,
): Promise<NativeQuestionnaireCapture> {
  const capture = validateNativeQuestionnaireCaptureShape(
      input,
      validSourceIds,
      authority,
    ),
    definition = await getNativeQuestionnaireDefinition();
  ensure(
    nativeCanonicalJson(capture.definition) ===
      nativeCanonicalJson(definition.binding),
    "questionnaire-definition-mismatch",
  );
  const decisions = nativeRoutingDecisions(
    { topics: capture.topics, context: capture.context },
    evidenceOf(validSourceIds, capture.unreviewedSourceIds, authority),
  );
  ensure(
    nativeCanonicalJson(capture.routingDecisions) ===
      nativeCanonicalJson(decisions),
    "questionnaire-routing-mismatch",
  );
  for (const historical of capture.inactiveHistory ?? []) {
    const topic = nativeTopics().find(
      (topic) => topic.id === historical.topicId,
    );
    let active: SlotAnswer | undefined;
    try {
      active = nativeResolveSlot(
        topic!,
        capture.topics[historical.topicId] ?? { presented: false, answers: {} },
        historical.path,
      ).answer;
    } catch {
      continue;
    }
    if (active?.state === "known" && !authority?.reviewedFact(historical.topicId, historical.path, active))
      ensure(
        active.sourceIds.some(
          (id) =>
            !(
              historical.answer.sourceIds as readonly string[] | undefined
            )?.includes(id),
        ),
        "questionnaire-history-reuse-requires-confirmation",
      );
  }
  const projected = projectActive(capture, validSourceIds, authority);
  ensure(
    nativeCanonicalJson(projected.topics) ===
      nativeCanonicalJson(capture.topics),
    "questionnaire-inactive-answer-is-active",
  );
  return capture;
}
interface ResponseExtension {
  url: string;
  valueString?: string;
  valueCode?: string;
  valueBoolean?: boolean;
  valueReference?: { reference: string };
}
interface ResponseAnswer {
  valueString?: string;
  valueDecimal?: number;
  valueInteger?: number;
  valueBoolean?: boolean;
  valueDate?: string;
  valueDateTime?: string;
  valueCoding?: { system: string; code: string; display: string };
}
export interface NativeResponseItem {
  linkId: string;
  id?: string;
  extension?: ResponseExtension[];
  answer?: ResponseAnswer[];
  item?: NativeResponseItem[];
}
export interface NativeQuestionnaireResponse {
  resourceType: "QuestionnaireResponse";
  questionnaire: string;
  status: "in-progress" | "stopped" | "completed";
  subject: { reference: string };
  source: { reference: string };
  authored: string;
  extension: ResponseExtension[];
  item: NativeResponseItem[];
}
const ext = (name: string, value: string): ResponseExtension => ({
  url: `${NATIVE_EXTENSION}${name}`,
  valueString: value,
});
const readExt = (extensions: ResponseExtension[] | undefined, name: string) =>
  extensions?.find((e) => e.url === `${NATIVE_EXTENSION}${name}`)?.valueString;
function stateItem(
  linkId: string,
  answer: SlotAnswer | undefined,
): NativeResponseItem {
  return {
    linkId: `${linkId}.__state`,
    answer: [{ valueString: answer?.state ?? "not-asked" }],
    extension: [
      { url: `${NATIVE_EXTENSION}slot-present`, valueBoolean: !!answer },
      ...(answer?.state === "not-asked" && answer.sourceIds
        ? [
            {
              url: `${NATIVE_EXTENSION}not-asked-source-list-present`,
              valueBoolean: true,
            },
          ]
        : []),
      ...(answer?.sourceIds ?? []).map((id) => ext("source-turn", id)),
      ...(answer?.state === "known" && !answer.items && answer.reusedFrom
        ? [ext("reused-from", nativeCanonicalJson(answer.reusedFrom))]
        : []),
      ...("note" in (answer ?? {}) && (answer as { note?: string }).note
        ? [ext("answer-note", (answer as { note: string }).note)]
        : []),
    ],
  };
}
function scalarAnswer(slot: SlotDefinition, value: unknown): ResponseAnswer {
  if (typeof value === "boolean") return { valueBoolean: value };
  if (typeof value === "number")
    return slot.kind === "choice"
      ? {
          valueCoding: {
            system: "urn:corvo:phq4-response",
            code: String(value),
            display: [
              "Not at all",
              "Several days",
              "More than half the days",
              "Nearly every day",
            ][value],
          },
        }
      : { valueDecimal: value };
  if (slot.id === "statedAt" || slot.id.endsWith(".statedAt"))
    return { valueDateTime: value as string };
  if (["serviceDate", "requestedDate"].includes(slot.id))
    return { valueDate: value as string };
  return { valueString: value as string };
}
function serializeSlots(
  topicId: string,
  slots: readonly SlotDefinition[],
  answers: SlotAnswers,
  decisions: NativeRoutingDecision[],
  prefix = "",
  instanceId?: string,
): NativeResponseItem[] {
  return slots.flatMap((slot) => {
    const path = prefix + slot.id,
      linkId = `${topicId}.${path}`,
      answer = answers[slot.id],
      state = stateItem(linkId, answer),
      matchingPath = path.replace(/\.__entry\./g, `[${instanceId}].`),
      decision = decisionFor(decisions, topicId, matchingPath);
    const control: NativeResponseItem[] =
      decision || slot.when
        ? [
            {
              linkId: `${linkId}.__applicability`,
              answer: [{ valueString: decision?.outcome ?? "unknown" }],
            },
          ]
        : [];
    const boolean =
      slot.kind === "presence" ||
      (slot.kind === "choice" &&
        slot.choices?.every((choice) => typeof choice === "boolean"));
    if (boolean && slot.acceptsNegative)
      control.push({
        linkId: `${linkId}.__valueEnabled`,
        answer: [
          {
            valueBoolean:
              answer?.state === "known" || answer?.state === "negative",
          },
        ],
      });
    if (slot.kind === "collection") {
      const entries = answer?.state === "known" ? (answer.items ?? []) : [];
      return [
        ...control,
        {
          linkId: `${linkId}.__container`,
          item: [
            state,
            ...(answer?.state === "known" && answer.items
              ? [
                  {
                    linkId: `${linkId}.__complete`,
                    answer: [{ valueBoolean: answer.complete }],
                  },
                ]
              : []),
            ...entries.map((item) => ({
              linkId: `${linkId}.__entry`,
              id: item.id,
              item: serializeSlots(
                topicId,
                slot.fields ?? [],
                item.answers,
                decisions,
                `${path}.__entry.`,
                item.id,
              ),
            })),
          ],
        },
      ];
    }
    if (slot.kind === "height-value") {
      const value = answer?.state === "known" ? answer.value : undefined;
      const children: NativeResponseItem[] =
        typeof value === "number"
          ? [
              {
                linkId: `${linkId}.__scalar`,
                answer: [{ valueDecimal: value }],
              },
            ]
          : value && typeof value === "object"
            ? [
                {
                  linkId: `${linkId}.__feet`,
                  answer: [{ valueInteger: value.feet }],
                },
                {
                  linkId: `${linkId}.__inches`,
                  answer: [{ valueDecimal: value.inches }],
                },
              ]
            : [];
      return [...control, { linkId, item: [state, ...children] }];
    }
    const known = answer?.state === "known" && !answer.items,
      negative = answer?.state === "negative" && slot.kind === "presence";
    return [
      ...control,
      state,
      ...(known || negative
        ? [
            {
              linkId,
              answer: [
                negative
                  ? { valueBoolean: false }
                  : scalarAnswer(
                      slot,
                      answer!.state === "known" ? answer!.value : undefined,
                    ),
              ],
            },
          ]
        : []),
    ];
  });
}
export async function toNativeQuestionnaireResponse(input: {
  capture: NativeQuestionnaireCapture;
  validSourceIds: ReadonlySet<string>;
  patient: string;
  authored: string;
  confirmed: boolean;
  sourceDocumentReference?: string;
  questionnaireReference?: string;
  representationAuthority?: NativeRepresentationAuthority;
}): Promise<NativeQuestionnaireResponse> {
  const capture = await validateNativeQuestionnaireCapture(
    input.capture,
    input.validSourceIds,
    input.representationAuthority,
  );
  ensure(
    /^Patient\/[A-Za-z0-9.-]+$/.test(input.patient),
    "invalid-questionnaire-patient",
  );
  ensure(
    Number.isFinite(Date.parse(input.authored)),
    "invalid-questionnaire-authored",
  );
  const complete = nativeCaptureComplete(
    capture,
    evidenceOf(input.validSourceIds, capture.unreviewedSourceIds, input.representationAuthority),
  );
  const header = {
    schemaVersion: capture.schemaVersion,
    definition: capture.definition,
    scenario: capture.scenario,
    relevantTopicIds: capture.relevantTopicIds,
    routingDecisions: capture.routingDecisions,
    unreviewedSourceIds: capture.unreviewedSourceIds,
    ...(capture.reviewBinding ? { reviewBinding: capture.reviewBinding } : {}),
    ...(capture.context ? { context: capture.context } : {}),
    ...(capture.inactiveHistory
      ? { inactiveHistory: capture.inactiveHistory }
      : {}),
  };
  const item = nativeTopics()
    .filter((topic) => capture.topics[topic.id])
    .flatMap(({ id: topicId }) => {
      const response = capture.topics[topicId];
      const topic = nativeTopics().find((topic) => topic.id === topicId)!;
      const { answers, ...metadata } = response;
      return [
        {
          linkId: `${topicId}.__applicability`,
          answer: [{ valueString: response.applicability ?? "applicable" }],
        },
        {
          linkId: topicId,
          extension: [ext("topic-state", nativeCanonicalJson(metadata))],
          item: serializeSlots(
            topicId,
            topic.slots,
            answers,
            capture.routingDecisions,
          ),
        },
      ];
    });
  return {
    resourceType: "QuestionnaireResponse",
    questionnaire: `${capture.definition.canonical}|${capture.definition.version}`,
    status: input.confirmed
      ? complete
        ? "completed"
        : "stopped"
      : "in-progress",
    subject: { reference: input.patient },
    source: { reference: input.patient },
    authored: input.authored,
    extension: [
      ext("definition-digest", capture.definition.digest),
      ext("capture-header", nativeCanonicalJson(header)),
      ...(input.questionnaireReference
        ? [
            {
              url: `${NATIVE_EXTENSION}questionnaire-resource`,
              valueReference: { reference: input.questionnaireReference },
            },
          ]
        : []),
      ...(input.sourceDocumentReference
        ? [
            {
              url: `${NATIVE_EXTENSION}source-document`,
              valueReference: { reference: input.sourceDocumentReference },
            },
          ]
        : []),
    ],
    item,
  };
}
function deserializeSlots(
  topicId: string,
  slots: readonly SlotDefinition[],
  items: NativeResponseItem[],
  prefix = "",
): SlotAnswers {
  const result: Record<string, SlotAnswer> = {},
    expected = new Set<string>();
  const one = (linkId: string) => {
    expected.add(linkId);
    const found = items.filter((item) => item.linkId === linkId);
    ensure(found.length <= 1, "duplicate-response-item");
    return found[0];
  };
  for (const slot of slots) {
    const path = prefix + slot.id,
      linkId = `${topicId}.${path}`;
    if (
      slot.when ||
      nativeRoutingRules().some(
        (rule) =>
          rule.kind === "slot" &&
          rule.target === `${topicId}.${path.replace(/\.__entry\./g, "[*].")}`,
      )
    )
      one(`${linkId}.__applicability`);
    if (
      (slot.kind === "presence" ||
        (slot.kind === "choice" &&
          slot.choices?.every((choice) => typeof choice === "boolean"))) &&
      slot.acceptsNegative
    )
      one(`${linkId}.__valueEnabled`);
    const container =
      slot.kind === "collection"
        ? one(`${linkId}.__container`)
        : slot.kind === "height-value"
          ? one(linkId)
          : undefined;
    const state = container
      ? container.item?.find((item) => item.linkId === `${linkId}.__state`)
      : one(`${linkId}.__state`);
    ensure(state, "missing-response-state");
    const value = state!.answer?.[0]?.valueString;
    ensure(
      states.includes(value as (typeof states)[number]),
      "invalid-response-state",
    );
    const present = state!.extension?.find(
      (e) => e.url === `${NATIVE_EXTENSION}slot-present`,
    )?.valueBoolean;
    const sourceIds =
      state!.extension
        ?.filter((e) => e.url === `${NATIVE_EXTENSION}source-turn`)
        .map((e) => e.valueString!) ?? [];
    const note = readExt(state!.extension, "answer-note");
    const reusedFrom = readExt(state!.extension, "reused-from");
    const scalarItem = container ? undefined : one(linkId);
    if (!present) {
      ensure(
        value === "not-asked" &&
          !scalarItem &&
          !container?.item?.some((i) => i.linkId !== `${linkId}.__state`),
        "absent-slot-has-value",
      );
      continue;
    }
    if (value === "known") {
      if (slot.kind === "collection") {
        ensure(container, "missing-response-collection");
        const entries =
            container!.item?.filter((i) => i.linkId === `${linkId}.__entry`) ??
            [],
          complete = container!.item?.find(
            (i) => i.linkId === `${linkId}.__complete`,
          )?.answer?.[0]?.valueBoolean;
        ensure(
          entries.length > 0 && typeof complete === "boolean",
          "invalid-response-collection",
        );
        ensure(
          container!.item?.every((i) =>
            [
              `${linkId}.__state`,
              `${linkId}.__entry`,
              `${linkId}.__complete`,
            ].includes(i.linkId),
          ),
          "unknown-response-item",
        );
        result[slot.id] = {
          state: "known",
          items: entries.map((entry) => {
            ensure(
              !!entry.id && /^[A-Za-z0-9_-]{1,64}$/.test(entry.id),
              "invalid-response-instance",
            );
            return {
              id: entry.id!,
              answers: deserializeSlots(
                topicId,
                slot.fields ?? [],
                entry.item ?? [],
                `${path}.__entry.`,
              ),
            };
          }),
          complete: complete!,
          sourceIds,
        };
      } else if (slot.kind === "height-value") {
        const children = container?.item ?? [],
          scalar = children.find((i) => i.linkId === `${linkId}.__scalar`)
            ?.answer?.[0]?.valueDecimal,
          feet = children.find((i) => i.linkId === `${linkId}.__feet`)
            ?.answer?.[0]?.valueInteger,
          inches = children.find((i) => i.linkId === `${linkId}.__inches`)
            ?.answer?.[0]?.valueDecimal;
        ensure(
          children.every((i) =>
            [
              `${linkId}.__state`,
              `${linkId}.__scalar`,
              `${linkId}.__feet`,
              `${linkId}.__inches`,
            ].includes(i.linkId),
          ),
          "unknown-response-item",
        );
        ensure(
          typeof scalar === "number"
            ? feet === undefined && inches === undefined
            : typeof feet === "number" && typeof inches === "number",
          "invalid-response-height",
        );
        result[slot.id] = {
          state: "known",
          value:
            typeof scalar === "number"
              ? scalar
              : { feet: feet!, inches: inches! },
          sourceIds,
        };
      } else {
        const a = scalarItem?.answer;
        ensure(a?.length === 1, "missing-response-value");
        const keys = Object.keys(a![0]);
        ensure(keys.length === 1, "ambiguous-response-value");
        const native = a![0];
        let decoded: unknown;
        if (native.valueCoding) {
          ensure(
            slot.kind === "choice" &&
              native.valueCoding.system === "urn:corvo:phq4-response" &&
              /^[0-3]$/.test(native.valueCoding.code),
            "invalid-response-coding",
          );
          decoded = Number(native.valueCoding.code);
          ensure(
            native.valueCoding.display ===
              [
                "Not at all",
                "Several days",
                "More than half the days",
                "Nearly every day",
              ][decoded as number],
            "invalid-response-choice-label",
          );
        } else
          decoded =
            native.valueString ??
            native.valueDecimal ??
            native.valueBoolean ??
            native.valueDate ??
            native.valueDateTime;
        const expectedType =
          slot.kind === "positive-number"
            ? "valueDecimal"
            : slot.kind === "presence" ||
                (slot.kind === "choice" &&
                  slot.choices?.every((c) => typeof c === "boolean"))
              ? "valueBoolean"
              : slot.kind === "choice" &&
                  slot.choices?.every((c) => typeof c === "number")
                ? "valueCoding"
                : slot.id === "statedAt" || slot.id.endsWith(".statedAt")
                  ? "valueDateTime"
                  : ["serviceDate", "requestedDate"].includes(slot.id)
                    ? "valueDate"
                    : "valueString";
        ensure(keys[0] === expectedType, "response-value-type-mismatch");
        result[slot.id] = {
          state: "known",
          value: decoded as never,
          sourceIds,
          ...(reusedFrom ? { reusedFrom: JSON.parse(reusedFrom) } : {}),
        };
      }
    } else {
      ensure(
        !scalarItem ||
          (value === "negative" &&
            slot.kind === "presence" &&
            scalarItem.answer?.length === 1 &&
            scalarItem.answer[0].valueBoolean === false),
        "nonvalue-response-has-value",
      );
      result[slot.id] =
        value === "not-asked"
          ? {
              state: "not-asked",
              ...(state!.extension?.some(
                (e) =>
                  e.url ===
                    `${NATIVE_EXTENSION}not-asked-source-list-present` &&
                  e.valueBoolean,
              )
                ? { sourceIds: [] }
                : {}),
            }
          : {
              state: value as (typeof nonValue)[number],
              sourceIds,
              ...(note ? { note } : {}),
            };
    }
  }
  ensure(
    items.every((item) => expected.has(item.linkId)),
    "unknown-response-item",
  );
  return result;
}
/** Decode native typed values and independently validate scope, routing and exact binding. */
export async function fromNativeQuestionnaireResponse(
  response: NativeQuestionnaireResponse,
  validSourceIds: ReadonlySet<string>,
  authority?: NativeRepresentationAuthority,
): Promise<NativeQuestionnaireCapture> {
  ensure(
    response.resourceType === "QuestionnaireResponse",
    "invalid-response-resource",
  );
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(readExt(response.extension, "capture-header") ?? "");
  } catch {
    throw new NativeQuestionnaireError("invalid-response-header");
  }
  const topics: Record<string, TopicResponse> = {};
  const definitions = nativeTopics();
  for (const item of response.item) {
    if (item.linkId.endsWith(".__applicability")) continue;
    const topic = definitions.find((t) => t.id === item.linkId);
    ensure(
      topic && !topics[item.linkId],
      "unknown-or-duplicate-response-topic",
    );
    let metadata: Omit<TopicResponse, "answers">;
    try {
      metadata = JSON.parse(readExt(item.extension, "topic-state") ?? "");
    } catch {
      throw new NativeQuestionnaireError("invalid-response-topic-state");
    }
    topics[item.linkId] = {
      ...metadata,
      answers: deserializeSlots(
        item.linkId,
        topic!.slots,
        (item.item ?? []).filter(
          (i) => i.linkId !== `${item.linkId}.__applicability`,
        ),
      ),
    };
  }
  const capture = await validateNativeQuestionnaireCapture(
    { ...header, topics },
    validSourceIds,
    authority,
  );
  ensure(
    response.questionnaire ===
      `${capture.definition.canonical}|${capture.definition.version}` &&
      readExt(response.extension, "definition-digest") ===
        capture.definition.digest,
    "response-definition-mismatch",
  );
  const expected = await toNativeQuestionnaireResponse({
    capture,
    validSourceIds,
    patient: response.subject.reference,
    authored: response.authored,
    confirmed: response.status !== "in-progress",
    representationAuthority: authority,
  });
  ensure(response.status === expected.status, "response-completeness-mismatch");
  ensure(
    response.source.reference === response.subject.reference,
    "response-patient-mismatch",
  );
  ensure(
    nativeCanonicalJson(response.item) === nativeCanonicalJson(expected.item),
    "response-tree-mismatch",
  );
  return capture;
}

/** Immediate trusted-server projection after each turn; no definition/digest/confirmation is asserted. */
export function projectNativeQuestionnaireState(
  input: {
    topics: Readonly<Record<string, TopicResponse | undefined>>;
    context?: NativeRoutingContext;
    inactiveHistory?: readonly NativeInactiveAnswer[];
    unreviewedSourceIds?: readonly string[];
  },
  validSourceIds: ReadonlySet<string>,
): {
  topics: Record<string, TopicResponse>;
  inactiveHistory: NativeInactiveAnswer[];
  routingDecisions: NativeRoutingDecision[];
} {
  const snapshot: NativeQuestionnaireCapture = {
    schemaVersion: 1,
    // Internal shape marker only, intentionally never returned by this state-only helper.
    definition: {
      canonical: NATIVE_QUESTIONNAIRE_CANONICAL,
      version: NATIVE_QUESTIONNAIRE_VERSION,
      digest: "0".repeat(64),
    },
    scenario: "first-intake",
    relevantTopicIds: [],
    topics: Object.fromEntries(
      Object.entries(input.topics).filter(
        (entry): entry is [string, TopicResponse] => !!entry[1],
      ),
    ),
    routingDecisions: [],
    unreviewedSourceIds: [...(input.unreviewedSourceIds ?? [])],
    ...(input.context ? { context: input.context } : {}),
    ...(input.inactiveHistory
      ? { inactiveHistory: [...input.inactiveHistory] }
      : {}),
  };
  parseNativeQuestionnaireCaptureShape(snapshot, validSourceIds, true);
  const projected = projectActive(snapshot, validSourceIds);
  return {
    topics: projected.topics,
    inactiveHistory: projected.inactiveHistory ?? [],
    routingDecisions: projected.routingDecisions,
  };
}
