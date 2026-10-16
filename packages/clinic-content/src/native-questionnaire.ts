import {
  createClinicContent,
  mentalHealthOptions,
  promptsById,
  stopSemantics,
  type ClinicContent,
} from "./register.js";
import { escalation, escalationCopy, safetyDefinition } from "./safety.js";
import { assessSpecificity, specificityContracts, specificityDefinition } from "./specificity.js";
import { lookupReference, referenceRelease } from "../../clinic-reference/src/index.js";
/** Answer specificity contracts with the exact offline reference releases they consult (D1). */
const specificityContract = { ...specificityDefinition, reference: referenceRelease };
import { scenarios, scenarioForWorkflowTopic } from "./scenarios.js";
import { conditionBranches } from "./branches.js";
import { branchRules } from "./pack-rules.js";
import {
  guidedFieldForPath,
  nextGuidedField,
  type GuidedField,
} from "./guided.js";
import { evaluateTopic, evaluateSlots, hasValidEvidence } from "./readiness.js";
import type {
  EvidenceContext,
  ScenarioId,
  SlotAnswer,
  SlotAnswers,
  SlotDefinition,
  TopicDefinition,
  TopicId,
  TopicResponse,
} from "./types.js";

export const NATIVE_QUESTIONNAIRE_CANONICAL =
  "https://corvo.example/Questionnaire/clinic";
export const NATIVE_QUESTIONNAIRE_VERSION = "CC-0.2.phq4.native-5";

/** Extraction-only interpretation hints are server policy, not questionnaire structure. */
const definitionSlot = ({ extractionNegativeScope: _hint, ...slot }: SlotDefinition): SlotDefinition =>
  ({ ...slot, ...(slot.fields ? { fields: slot.fields.map(definitionSlot) } : {}) });
/** Dialogue metadata is not part of the published native Questionnaire contract. */
const definitionTopic = ({ corvo: _dialogue, ...topic }: TopicDefinition) => topic;
export const NATIVE_EXTENSION =
  "https://corvo.example/fhir/StructureDefinition/";
export type NativeOutcome = "applicable" | "not-applicable" | "unknown";
export interface NativeBinding {
  canonical: string;
  version: string;
  digest: string;
}
export interface NativeRoutingDecision {
  ruleId: string;
  outcome: NativeOutcome;
  sourceIds: string[];
  instanceId?: string;
}
export interface NativeSourceFact {
  topicId: string;
  path: string;
  sourceIds: string[];
}
/** Server-verified record context and explicit, source-qualified relevance. Never model-generated gates. */
export interface NativeEngagementEvidence extends NativeSourceFact {
  purposeExplained: true;
  unsuccessfulAttempts: number;
}
export interface NativeRoutingContext {
  appointment?: {
    reference: string;
    version: string;
    startsAt: string;
    timezone: string;
    priorUpdateAt: string;
  };
  plan?: {
    reference: string;
    version: string;
    author: string;
    recordedAt: string;
    text: string;
  };
  sleepApnea?: NativeSourceFact;
  surgeryEatingEffect?: NativeSourceFact;
  reproductive?: NativeSourceFact;
  preparation?: NativeSourceFact[];
  administrationUnclear?: NativeSourceFact | NativeSourceFact[];
  immediateSignsUnclear?: NativeSourceFact;
  gainAfterSchool?: NativeSourceFact;
  engagementUnclear?: NativeEngagementEvidence;
}
export interface NativeInactiveAnswer {
  topicId: string;
  path: string;
  answer: SlotAnswer;
  reason:
    | "disabled-by-correction"
    | "applicability-unknown"
    | "unreviewed-recognition";
  ruleId: string;
}
export interface NativeRepresentationAuthority {
  /** Trusted server-owned final fact receipt, separately qualified from native Q4. */
  binding: string;
  reviewedFact: (topicId: string, path: string, answer: SlotAnswer) => boolean;
  reviewedSourceAccountedFor: (sourceId: string) => boolean;
}
export interface NativeQuestionnaireCapture {
  schemaVersion: 1;
  definition: NativeBinding;
  scenario: ScenarioId;
  relevantTopicIds: TopicId[];
  topics: Record<string, TopicResponse>;
  routingDecisions: NativeRoutingDecision[];
  unreviewedSourceIds: string[];
  /** Separate additive final representation policy; original recognition inventory remains. */
  reviewBinding?: string;
  context?: NativeRoutingContext;
  inactiveHistory?: NativeInactiveAnswer[];
}
export interface NativeRule {
  id: string;
  target: string;
  kind: "slot" | "topic" | "context" | "prompt";
  predicate:
    | "positive"
    | "estimate-needed"
    | "uncertain"
    | "diabetes"
    | "sleep-apnea"
    | "digestive"
    | "reproductive"
    | "other-condition"
    | "appointment"
    | "plan"
    | "source-fact";
  anchors: string[];
}
export interface NativePromptTarget {
  id: string;
  text: string;
  targets: string[];
  wording: "exact" | "bounded";
  kind: "opening" | "detail" | "clarification" | "display" | "stop";
  ruleId?: string;
}
export interface NativeItem {
  linkId: string;
  type:
    | "group"
    | "display"
    | "text"
    | "decimal"
    | "integer"
    | "choice"
    | "boolean"
    | "date"
    | "dateTime";
  text?: string;
  required?: boolean;
  readOnly?: boolean;
  repeats?: boolean;
  item?: NativeItem[];
  answerOption?: Array<
    | { valueCoding: { system: string; code: string; display: string } }
    | { valueString: string }
  >;
  enableWhen?: Array<{
    question: string;
    operator: "=";
    answerString?: string;
    answerBoolean?: boolean;
  }>;
  enableBehavior?: "any" | "all";
  extension?: Array<{
    url: string;
    valueString?: string;
    valueCode?: string;
    valueBoolean?: boolean;
  }>;
}
export interface NativeQuestionnaireDefinition {
  binding: NativeBinding;
  questionnaire: {
    resourceType: "Questionnaire";
    url: string;
    version: string;
    status: "active";
    item: NativeItem[];
    extension: Array<{ url: string; valueString: string }>;
  };
  topics: TopicDefinition[];
  promptTargets: Record<string, NativePromptTarget>;
  routingRules: NativeRule[];
  aliases: Record<string, string>;
  standaloneForm: { supported: false; missingCapabilities: string[] };
}
const outcome = (yes: boolean): NativeOutcome =>
  yes ? "applicable" : "not-applicable";
const emptyResponse = (): TopicResponse => ({ presented: false, answers: {} });
export function nativeCanonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(nativeCanonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${nativeCanonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function freezeAuthored<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeAuthored);
    Object.freeze(value);
  }
  return value;
}
let fixedRegister: ClinicContent | undefined;
const defaultNativeRegister = () =>
  (fixedRegister ??= createClinicContent({ mentalHealth: "phq4" }));
let authoredTopics: TopicDefinition[] | undefined;
let authoredRules: NativeRule[] | undefined;
let authoredCatalog: Record<string, NativePromptTarget> | undefined;
const boundedText = (
  id: string,
  label: string,
  promptId: string,
): SlotDefinition => ({
  id,
  label,
  kind: "text",
  promptIds: [promptId],
  optional: true,
});
/** COND is an alias, not a second list. These additions operationalize already-authored prompts only. */
export function nativeTopics(
  register: ClinicContent = defaultNativeRegister(),
): TopicDefinition[] {
  if (register.mentalHealth !== "phq4")
    throw new Error("native-definition-requires-fixed-phq4");
  if (authoredTopics) return [...authoredTopics];
  const core = register.topics.map((topic) => ({
    ...topic,
    slots: topic.slots
      .map((slot) => {
        if (topic.id === "Q06" && slot.id === "uncertainDiagnosis")
          return { ...slot, optional: true };
        if (topic.id === "Q06" && slot.id === "reportedConditions")
          return {
            ...slot,
            fields: [
              ...(slot.fields ?? []),
              {
                ...boundedText(
                  "uncertainDiagnosis",
                  "What was recalled about this condition",
                  "Q06.uncertain",
                ),
                when: { slotId: "term", condition: "uncertain" as const },
              },
            ],
          };
        if (topic.id === "Q11" && slot.id === "occasions")
          return {
            ...slot,
            fields: [
              ...(slot.fields ?? []),
              boundedText(
                "preparation",
                "Preparation and eating context",
                "Q11.preparation",
              ),
            ],
          };
        if (topic.id === "Q08" && slot.id === "medicines")
          return {
            ...slot,
            fields: [
              ...(slot.fields ?? []),
              boundedText(
                "administrationClarification",
                "Patient wording about uncertain administration",
                "B03",
              ),
            ],
          };
        return slot;
      })
      .concat(
        topic.id === "Q06"
          ? topic.slots
              .filter((s) => s.id.startsWith("conditions."))
              .map((s) => ({
                ...boundedText(
                  `${s.id}.uncertainDiagnosis`,
                  "What was recalled about this condition",
                  "Q06.uncertain",
                ),
                when: { slotId: s.id, condition: "uncertain" as const },
              }))
          : [],
      )
      .concat(
        topic.id === "Q02"
          ? [
              boundedText(
                "immediateSignsClarification",
                "Patient wording about immediate signs",
                "B04",
              ),
            ]
          : [],
      ),
  }));
  authoredTopics = freezeAuthored([
    ...core,
    ...Object.values(scenarios)
      .flatMap((s) => s.additionalTopics)
      .map((topic) =>
        topic.id === "W07"
          ? {
              ...topic,
              slots: [
                ...topic.slots,
                boundedText(
                  "administrationClarification",
                  "Patient wording about uncertain administration",
                  "B03",
                ),
              ],
            }
          : topic,
      ),
    ...Object.entries(conditionBranches)
      .filter(([key]) => key !== "otherCondition")
      .map(([key, branch]) =>
        key === "sleepApnea"
          ? {
              ...branch.topic,
              slots: branch.topic.slots.filter(
                (slot) => slot.id !== "treatment",
              ),
            }
          : branch.topic,
      ),
  ]);
  return [...authoredTopics];
}
export const nativeAliases = {
  "COND.termStatus": "Q06.reportedConditions[*].term",
  "COND.care": "Q06.reportedConditions[*].care",
  "COND.difficulty": "Q06.reportedConditions[*].concern",
  "COND.owner": "Q06.reportedConditions[*].owner",
  "SLEEP.treatment": "Q15.treatment",
} as const;
export function nativeResolveAlias(
  topicId: string,
  path: string,
  instanceId?: string,
): { topicId: string; path: string } {
  const alias =
    nativeAliases[`${topicId}.${path}` as keyof typeof nativeAliases];
  if (!alias) return { topicId, path };
  if (alias.includes("[*]") && !instanceId)
    throw new Error("condition-instance-required");
  const resolved = alias.replace("[*]", `[${instanceId}]`),
    dot = resolved.indexOf(".");
  return { topicId: resolved.slice(0, dot), path: resolved.slice(dot + 1) };
}
export function nativeSlotEntries(
  topics = nativeTopics(),
): Array<{ topicId: string; path: string; slot: SlotDefinition }> {
  const result: Array<{ topicId: string; path: string; slot: SlotDefinition }> =
    [];
  const visit = (
    topicId: string,
    slots: readonly SlotDefinition[],
    prefix = "",
  ) =>
    slots.forEach((slot) => {
      const path = prefix + slot.id;
      result.push({ topicId, path, slot });
      if (slot.fields) visit(topicId, slot.fields, `${path}[*].`);
    });
  topics.forEach((topic) => visit(topic.id, topic.slots));
  return result;
}
export function nativeRoutingRules(
  topics: TopicDefinition[] = nativeTopics(),
): NativeRule[] {
  if (authoredRules) return [...authoredRules];
  authoredRules = freezeAuthored([
    ...nativeSlotEntries(topics)
      .filter(({ slot }) => slot.when)
      .map(({ topicId, path, slot }) => ({
        id: `slot.${topicId}.${path}`,
        target: `${topicId}.${path}`,
        kind: "slot" as const,
        predicate: slot.when!.condition,
        anchors: [
          slot.when!.slotId,
          ...(slot.when!.orSlotIds ?? []),
          ...(slot.when!.alsoWhenTrue ? [slot.when!.alsoWhenTrue] : []),
        ],
      })),
    {
      id: "branch.diabetes",
      target: "DM",
      kind: "topic",
      predicate: "diabetes",
      anchors: ["Q06.conditions.diabetes", "Q06.conditions.prediabetes"],
    },
    {
      id: "branch.sleep-apnea",
      target: "SLEEP",
      kind: "topic",
      predicate: "sleep-apnea",
      anchors: ["Q06.conditions.sleepApnea", "Q15.condition"],
    },
    {
      id: "branch.digestive",
      target: "GI",
      kind: "topic",
      predicate: "digestive",
      anchors: ["Q06.conditions.digestive", "Q07.events[*].effects"],
    },
    {
      id: "branch.reproductive",
      target: "Q18",
      kind: "topic",
      predicate: "reproductive",
      anchors: ["Q18.context"],
    },
    {
      id: "branch.other-condition",
      target: "Q06.reportedConditions",
      kind: "context",
      predicate: "other-condition",
      anchors: ["Q06.reportedConditions"],
    },
    {
      id: "context.pre-visit",
      target: "S01",
      kind: "prompt",
      predicate: "appointment",
      anchors: [],
    },
    {
      id: "context.post-visit",
      target: "S03",
      kind: "prompt",
      predicate: "plan",
      anchors: [],
    },
    ...[
      ["branch.preparation", "Q11.preparation"],
      ["branch.B03", "B03"],
      ["branch.B04", "B04"],
      ["prompt.gain-after-school", "Q03.followup.1"],
      ["stop.detail", "stop-choice"],
    ].map(([id, target]) => ({
      id,
      target,
      kind: "prompt" as const,
      predicate: "source-fact" as const,
      anchors: [],
    })),
    {
      id: "slot.Q11.occasions[*].preparation",
      target: "Q11.occasions[*].preparation",
      kind: "slot",
      predicate: "source-fact",
      anchors: [],
    },
    {
      id: "slot.Q08.medicines[*].administrationClarification",
      target: "Q08.medicines[*].administrationClarification",
      kind: "slot",
      predicate: "source-fact",
      anchors: [],
    },
    {
      id: "slot.W07.administrationClarification",
      target: "W07.administrationClarification",
      kind: "slot",
      predicate: "source-fact",
      anchors: [],
    },
    {
      id: "slot.Q02.immediateSignsClarification",
      target: "Q02.immediateSignsClarification",
      kind: "slot",
      predicate: "source-fact",
      anchors: [],
    },
  ]);
  return [...authoredRules];
}
export function nativeResolveSlot(
  topic: TopicDefinition,
  response: TopicResponse,
  path: string,
): {
  slot: SlotDefinition;
  answer?: SlotAnswer;
  answers: SlotAnswers;
  ancestors: readonly SlotAnswer[];
} {
  const visit = (
    slots: readonly SlotDefinition[],
    answers: SlotAnswers,
    rest: string,
    ancestors: readonly SlotAnswer[] = [],
  ): {
    slot: SlotDefinition;
    answer?: SlotAnswer;
    answers: SlotAnswers;
    ancestors: readonly SlotAnswer[];
  } => {
    const exact = slots.find((slot) => slot.id === rest);
    if (exact)
      return { slot: exact, answer: answers[exact.id], answers, ancestors };
    for (const slot of slots) {
      const m = new RegExp(
        `^${slot.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[([A-Za-z0-9_-]+)\\]\\.(.+)$`,
      ).exec(rest);
      if (!m || slot.kind !== "collection") continue;
      const collection = answers[slot.id];
      const item =
        collection?.state === "known" &&
        collection.items?.find((item) => item.id === m[1]);
      if (item)
        return visit(slot.fields ?? [], item.answers, m[2], [
          ...ancestors,
          collection!,
        ]);
    }
    throw new Error("unknown-slot-path");
  };
  return visit(topic.slots, response.answers, path);
}
export function nativeSourceFactValid(
  fact: NativeSourceFact | undefined,
  topics: Readonly<Record<string, TopicResponse | undefined>>,
  evidence: EvidenceContext,
): boolean {
  if (
    !fact ||
    !fact.sourceIds.length ||
    !fact.sourceIds.every((id) => evidence.validSourceIds.has(id)) && !evidence.reviewedFact
  )
    return false;
  const topic = nativeTopics().find((topic) => topic.id === fact.topicId);
  if (!topic) return false;
  try {
    const { answer, ancestors } = nativeResolveSlot(
      topic,
      topics[topic.id] ?? emptyResponse(),
      fact.path,
    );
    return (
      !!answer &&
      answer.state === "known" &&
      ancestors.every(
        (ancestor) =>
          ancestor.state === "known" && hasValidEvidence(ancestor, { ...evidence, topicId: fact.topicId }, [...fact.path.matchAll(/\[/g)].map(m => fact.path.slice(0, m.index))[ancestors.indexOf(ancestor)]),
      ) &&
      hasValidEvidence(answer, { ...evidence, topicId: fact.topicId }, fact.path) &&
      fact.sourceIds.every((id) => answer.sourceIds?.includes(id))
    );
  } catch {
    return false;
  }
}
export function evaluateNativeRule(
  rule: NativeRule,
  snapshot: {
    topics: Record<string, TopicResponse>;
    context?: NativeRoutingContext;
  },
  evidence: EvidenceContext,
  instanceId?: string,
): NativeRoutingDecision {
  const context = snapshot.context ?? {},
    sources: string[] = [];
  const read = (topicId: string, path: string) =>
    snapshot.topics[topicId]?.answers[path];
  const valid = (answer: SlotAnswer | undefined) => {
    if (hasValidEvidence(answer, evidence)) return true;
    if (!answer || !evidence.reviewedFact) return false;
    const walk = (topicId: string, answers: SlotAnswers, prefix = ""): boolean => Object.entries(answers).some(([id, current]) => {
      const path = prefix + id;
      return current === answer && evidence.reviewedFact!(topicId, path, answer) || current?.state === "known" && !!current.items?.some(item => walk(topicId, item.answers, `${path}[${item.id}].`));
    });
    return Object.entries(snapshot.topics).some(([topicId, response]) => walk(topicId, response.answers));
  };
  const positive = (answer: SlotAnswer | undefined) =>
    valid(answer) &&
    answer?.state === "known" &&
    (answer.value === true ||
      (typeof answer.value === "string" && !!answer.value.trim()) ||
      (typeof answer.value === "number" && answer.value > 0));
  const negative = (answer: SlotAnswer | undefined) =>
    valid(answer) && answer?.state === "negative";
  let value: NativeOutcome = "unknown";
  const anchor = (topic: string, path: string) => {
    const a = read(topic, path);
    sources.push(...(a?.sourceIds ?? []));
    return a;
  };
  const fact = (f: NativeSourceFact | undefined) => {
    if (!nativeSourceFactValid(f, snapshot.topics, evidence)) return false;
    sources.push(...f!.sourceIds);
    return true;
  };
  if (rule.kind === "slot" && rule.predicate === "source-fact") {
    const f = rule.target.endsWith(".preparation")
      ? context.preparation?.find((f) => f.path.includes(`[${instanceId}]`))
      : rule.target.endsWith(".administrationClarification")
        ? administrationFacts(context).find(
            (f) =>
              f.topicId === rule.target.split(".")[0] &&
              (!instanceId || f.path.includes(`[${instanceId}]`)),
          )
        : context.immediateSignsUnclear;
    const instanceMatches =
      !instanceId || !!f?.path.includes(`[${instanceId}]`);
    const expectedTopic = rule.target.split(".")[0];
    value =
      instanceMatches && f?.topicId === expectedTopic && fact(f)
        ? "applicable"
        : f
          ? "unknown"
          : "not-applicable";
  } else if (rule.kind === "slot") {
    const dot = rule.target.indexOf("."),
      topicId = rule.target.slice(0, dot),
      path = rule.target.slice(dot + 1).replace("[*]", `[${instanceId}]`);
    const topic = nativeTopics().find((t) => t.id === topicId)!;
    try {
      const resolved = nativeResolveSlot(
          topic,
          snapshot.topics[topicId] ?? emptyResponse(),
          path,
        ),
        defs = path.includes("[")
          ? (nativeSlotEntries([topic]).find(
              (e) =>
                e.slot.kind === "collection" && path.startsWith(`${e.path}[`),
            )?.slot.fields ?? [])
          : topic.slots;
      const slot = resolved.slot,
        anchors = rule.anchors.map((id) => resolved.answers[id]);
      sources.push(...anchors.flatMap((a) => a?.sourceIds ?? []));
      if (rule.predicate === "uncertain")
        value = anchors.some((a) => valid(a) && a?.state === "uncertain")
          ? "applicable"
          : anchors.every(
                (a) =>
                  valid(a) && (a?.state === "known" || a?.state === "negative"),
              )
            ? "not-applicable"
            : "unknown";
      else if (rule.predicate === "estimate-needed") {
        const a = anchors[0],
          old = slot.when?.alsoWhenTrue
            ? resolved.answers[slot.when.alsoWhenTrue]
            : undefined;
        value =
          valid(old) && old?.state === "known" && old.value === true
            ? "applicable"
            : valid(a) && a?.state === "known" && a.value === true
              ? "not-applicable"
              : valid(a) &&
                  (a?.state === "unknown" ||
                    a?.state === "uncertain" ||
                    (a?.state === "known" && a.value === false))
                ? "applicable"
                : "unknown";
      } else {
        const a = anchors[0],
          anchorDef = defs.find((d) => d.id === slot.when?.slotId);
        const ready = anchorDef
          ? evaluateSlots(
              [{ ...anchorDef, when: undefined }],
              { [anchorDef.id]: a },
              { ...evidence, topicId },
              path.includes("]") ? path.slice(0, path.lastIndexOf(".") + 1) : "",
            )[0]
          : undefined;
        value =
          negative(a) && anchorDef?.acceptsNegative
            ? "not-applicable"
            : a?.state === "known" && ready?.state === "sufficient"
              ? "applicable"
              : "unknown";
      }
    } catch {
      value = "unknown";
    }
  } else
    switch (rule.predicate) {
      case "diabetes": {
        const inputs = [
          anchor("Q06", "conditions.diabetes"),
          anchor("Q06", "conditions.prediabetes"),
        ];
        value = inputs.some(positive)
          ? "applicable"
          : inputs.every(negative)
            ? "not-applicable"
            : "unknown";
        break;
      }
      case "sleep-apnea": {
        const a = anchor("Q06", "conditions.sleepApnea");
        value =
          positive(a) || fact(context.sleepApnea)
            ? "applicable"
            : (negative(a) && !context.sleepApnea) ||
                (negative(anchor("Q15", "condition")) && negative(a))
              ? "not-applicable"
              : "unknown";
        break;
      }
      case "digestive": {
        const a = anchor("Q06", "conditions.digestive");
        value =
          positive(a) || fact(context.surgeryEatingEffect)
            ? "applicable"
            : negative(a) && negative(anchor("Q07", "events"))
              ? "not-applicable"
              : "unknown";
        break;
      }
      case "reproductive": {
        const r = snapshot.topics.Q18;
        sources.push(...(r?.applicabilitySourceIds ?? []));
        value =
          r?.applicability === "not-applicable" &&
          !!r.applicabilitySourceIds?.length &&
          r.applicabilitySourceIds.every((id) =>
            evidence.validSourceIds.has(id),
          )
            ? "not-applicable"
            : fact(context.reproductive) ||
                (r?.applicability === "applicable" &&
                  !!r.applicabilitySourceIds?.length &&
                  r.applicabilitySourceIds.every((id) =>
                    evidence.validSourceIds.has(id),
                  ))
              ? "applicable"
              : r?.applicability === "not-applicable" &&
                  !!r.applicabilitySourceIds?.length &&
                  r.applicabilitySourceIds.every((id) =>
                    evidence.validSourceIds.has(id),
                  )
                ? "not-applicable"
                : "unknown";
        break;
      }
      case "other-condition": {
        const a = anchor("Q06", "reportedConditions");
        const common = nativeTopics()
          .find((t) => t.id === "Q06")!
          .slots.filter((s) => s.id.startsWith("conditions."))
          .map((s) => read("Q06", s.id));
        value =
          a?.state === "known" && !!a.items?.length && valid(a)
            ? "applicable"
            : negative(a) && !common.some(positive)
              ? "not-applicable"
              : "unknown";
        break;
      }
      case "appointment": {
        const a = context.appointment;
        value = outcome(
          !!a &&
            /^Appointment\/[A-Za-z0-9.-]+$/.test(a.reference) &&
            !!a.version &&
            !!a.timezone &&
            Number.isFinite(Date.parse(a.startsAt)) &&
            Number.isFinite(Date.parse(a.priorUpdateAt)),
        );
        break;
      }
      case "plan": {
        const p = context.plan;
        value = outcome(
          !!p &&
            /^(CarePlan|DocumentReference)\/[A-Za-z0-9.-]+$/.test(
              p.reference,
            ) &&
            !!p.version &&
            !!p.author &&
            !!p.text.trim() &&
            Number.isFinite(Date.parse(p.recordedAt)),
        );
        break;
      }
      case "source-fact": {
        const f =
          rule.id === "branch.B03"
            ? administrationFacts(context).find(
                (f) =>
                  (!instanceId || f.path.includes(`[${instanceId}]`)) &&
                  nativeSourceFactValid(f, snapshot.topics, evidence),
              )
            : rule.id === "branch.B04"
              ? context.immediateSignsUnclear
              : rule.id === "prompt.gain-after-school"
                ? context.gainAfterSchool
                : rule.id === "stop.detail"
                  ? context.engagementUnclear
                  : context.preparation?.find(
                      (f) => !instanceId || f.path.includes(`[${instanceId}]`),
                    );
        if (rule.id === "stop.detail") {
          const engagement = context.engagementUnclear;
          const topic =
            engagement &&
            nativeTopics().find((t) => t.id === engagement.topicId);
          let authored = false;
          try {
            if (topic && engagement)
              authored = !!nativeResolveSlot(
                topic,
                snapshot.topics[topic.id] ?? emptyResponse(),
                engagement.path,
              );
          } catch {}
          const valid =
            !!engagement &&
            engagement.purposeExplained &&
            engagement.unsuccessfulAttempts >= 2 &&
            authored &&
            engagement.sourceIds.length > 0 &&
            engagement.sourceIds.every((id) => evidence.validSourceIds.has(id));
          if (valid) sources.push(...engagement!.sourceIds);
          value = valid
            ? "applicable"
            : engagement
              ? "unknown"
              : "not-applicable";
        } else
          value = fact(f) ? "applicable" : f ? "unknown" : "not-applicable";
        break;
      }
    }
  return {
    ruleId: rule.id,
    outcome: value,
    sourceIds: [
      ...new Set(sources.filter((id) => evidence.validSourceIds.has(id))),
    ],
    ...(instanceId ? { instanceId } : {}),
  };
}
export function nativeRoutingDecisions(
  snapshot: {
    topics: Record<string, TopicResponse>;
    context?: NativeRoutingContext;
  },
  evidence: EvidenceContext,
): NativeRoutingDecision[] {
  return nativeRoutingRules(nativeTopics()).flatMap((rule) => {
    if (!rule.target.includes("[*]"))
      return [evaluateNativeRule(rule, snapshot, evidence)];
    const dot = rule.target.indexOf("."),
      topicId = rule.target.slice(0, dot),
      collectionId = rule.target.slice(dot + 1).split("[*]")[0],
      collection = snapshot.topics[topicId]?.answers[collectionId];
    const items = collection?.state === "known" ? (collection.items ?? []) : [];
    return items.map((item) =>
      evaluateNativeRule(rule, snapshot, evidence, item.id),
    );
  });
}
function catalog(
  topics: TopicDefinition[],
  rules: NativeRule[],
): Record<string, NativePromptTarget> {
  if (authoredCatalog) return authoredCatalog;
  const entries = nativeSlotEntries(topics),
    result: Record<string, NativePromptTarget> = {};
  for (const prompt of Object.values(promptsById)) {
    if (prompt.id === "MH.unscored") continue;
    const opening = topics
        .filter((t) => t.openingPromptId === prompt.id)
        .map((t) => t.id),
      targets = entries
        .filter((e) => e.slot.promptIds.includes(prompt.id))
        .map((e) => `${e.topicId}.${e.path}`);
    const specialTargets: Record<string, string[]> = {
      "Q02.followup.1": ["Q02.concern"],
      "Q03.followup.1": ["Q03.childhood", "Q03.teenage", "Q03.afterSchool"],
      "Q04.followup.1": [
        "Q04.lastMeasuredWeight.value",
        "Q04.currentWeightEstimate.value",
      ],
      "Q06.followup.3": ["Q06.reportedConditions[*].concern"],
      "Q16.followup.1": ["Q16.stress"],
      "Q16.followup.2": ["Q16.impact", "Q16.support"],
      Q15: ["Q15.schedule", "Q15.quality", "Q15.condition"],
      SLEEP01: ["Q15.treatment"],
      Q18: ["Q18.context"],
      S01a: ["W02"],
      S03a: ["W04"],
      "stop-choice": topics.map((t) => t.id),
    };
    const allTargets = [
      ...new Set([
        ...opening,
        ...targets,
        ...(specialTargets[prompt.id] ?? []),
      ]),
    ];
    const isDisplay =
      prompt.id.startsWith("COPY-") ||
      prompt.id.startsWith("E0") ||
      prompt.id === "MH.stem";
    if (!allTargets.length && !isDisplay)
      throw new Error(`unmapped-authored-prompt:${prompt.id}`);
    const gateByPrompt: Record<string, string> = {
      SLEEP01: "branch.sleep-apnea",
      GI01: "branch.digestive",
      COND01: "branch.other-condition",
      COND02: "branch.other-condition",
      "Q06.followup.3": "branch.other-condition",
      S01: "context.pre-visit",
      "W02.followup.1": "context.pre-visit",
      S03: "context.post-visit",
      "W04.followup.1": "context.post-visit",
    };
    const gateId = prompt.id.startsWith("DM0")
      ? "branch.diabetes"
      : gateByPrompt[prompt.id];
    const rule = rules.find((rule) =>
      gateId
        ? rule.id === gateId
        : rule.kind === "prompt" && rule.target === prompt.id,
    );
    result[prompt.id] = {
      id: prompt.id,
      text: prompt.text,
      targets: allTargets,
      wording: prompt.id.startsWith("MH") || isDisplay ? "exact" : "bounded",
      kind: isDisplay
        ? "display"
        : prompt.id === "stop-choice"
          ? "stop"
          : opening.length || prompt.id === "S01a" || prompt.id === "S03a"
            ? "opening"
            : prompt.origin === "bounded-clarification"
              ? "clarification"
              : "detail",
      ...(rule ? { ruleId: rule.id } : {}),
    };
  }
  for (const [id, text] of Object.entries(escalationCopy))
    result[id] = { id, text, targets: [], wording: "exact", kind: "display" };
  authoredCatalog = freezeAuthored(result);
  return authoredCatalog;
}
/** Every selected live prompt is resolved here. Exact instrument text cannot be paraphrased. */
export interface NativePromptAuthority {
  relevantTopicIds?: readonly TopicId[];
  topics: Record<string, TopicResponse>;
  /** Proposed repeat items may resolve a displayed path and its own sibling
   * slot condition. This projection never grants readiness/branch authority. */
  repeatResolutionTopics?: Record<string, TopicResponse>;
  context?: NativeRoutingContext;
}
export function guardNativePrompt(
  input: NativePromptAuthority & {
    promptId: string;
    topicId: string;
    path?: string;
    text?: string;
    instanceId?: string;
    scenario: ScenarioId;
  },
  evidence: EvidenceContext,
): NativePromptTarget {
  const topics = nativeTopics(),
    rules = nativeRoutingRules(topics),
    prompt = catalog(topics, rules)[input.promptId];
  if (!prompt) throw new Error("unauthored-prompt");
  const resolved = nativeResolveAlias(
      input.topicId,
      input.path ?? "",
      input.instanceId,
    ),
    topic = topics.find((t) => t.id === resolved.topicId);
  if (!topic && prompt.kind !== "display") throw new Error("unauthored-topic");
  if (
    topic &&
    !nativeScenarioTopics(defaultNativeRegister(), input.scenario, {
      relevantTopicIds: input.relevantTopicIds,
      responses: input.topics,
      evidence,
      context: input.context,
      includeUnresolvedBranches: true,
    }).some((t) => t.id === topic.id)
  )
    throw new Error("prompt-outside-scenario");
  const path = resolved.path.replace(/\[[A-Za-z0-9_-]+\]/g, "[*]"),
    target = path ? `${resolved.topicId}.${path}` : resolved.topicId;
  if (
    prompt.kind !== "display" &&
    !prompt.targets.includes(target) &&
    !(prompt.kind === "opening" && prompt.targets.includes(resolved.topicId))
  )
    throw new Error("prompt-target-mismatch");
  if (input.path && topic) {
    const resolutionResponse = resolved.path.includes('].')
      ? input.repeatResolutionTopics?.[topic.id] ?? input.topics[topic.id] ?? emptyResponse()
      : input.topics[topic.id] ?? emptyResponse();
    const slot = nativeResolveSlot(
      topic,
      resolutionResponse,
      resolved.path,
    ).slot;
    const slotRule = rules.find(
      (r) => r.target === target && r.kind === "slot",
    );
    // A missing child can be asked about an already proposed item before final
    // confirmation. Only that item's siblings may authorize its local condition.
    // Do not expose proposed scalar diagnoses or source-fact routing to rules.
    const repeat = /^(.*?)\[([A-Za-z0-9_-]+)\]\.([^\[\]]+)$/.exec(resolved.path);
    const collection = repeat ? resolutionResponse.answers[repeat[1]] : undefined;
    const repeatCollection = collection?.state === "known" && collection.items ? collection : undefined;
    const item = repeatCollection?.items.find(item => item.id === repeat?.[2]);
    const slotSnapshot = slotRule && ["positive", "uncertain", "estimate-needed"].includes(slotRule.predicate) && repeat && repeatCollection && item
      ? { ...input, topics: { ...input.topics, [topic.id]: {
        ...(input.topics[topic.id] ?? emptyResponse()),
        answers: { ...input.topics[topic.id]?.answers, [repeat[1]]: { ...repeatCollection, items: [item] } },
      } } }
      : input;
    if (
      slotRule &&
      evaluateNativeRule(
        slotRule,
        slotSnapshot,
        evidence,
        input.instanceId ?? /\[([^\]]+)\]/.exec(resolved.path)?.[1],
      ).outcome !== "applicable"
    )
      throw new Error("prompt-target-inactive");
    if (
      ["B03", "B04"].includes(input.promptId) &&
      nativeResolveSlot(
        topic,
        resolutionResponse,
        resolved.path,
      ).answer
    )
      throw new Error("bounded-clarification-already-answered");
  }
  if (prompt.ruleId) {
    const rule = rules.find((r) => r.id === prompt.ruleId)!;
    const applicable =
      evaluateNativeRule(rule, input, evidence, input.instanceId).outcome ===
      "applicable";
    if (!applicable) throw new Error("prompt-rule-inactive");
  }
  if (
    (input.promptId === "S01a" &&
      evaluateNativeRule(
        rules.find((r) => r.id === "context.pre-visit")!,
        input,
        evidence,
      ).outcome === "applicable") ||
    (["S03a", "W04.followup.2"].includes(input.promptId) &&
      evaluateNativeRule(
        rules.find((r) => r.id === "context.post-visit")!,
        input,
        evidence,
      ).outcome === "applicable")
  )
    throw new Error("context-fallback-inactive");
  if (input.text && prompt.wording === "exact" && input.text !== prompt.text)
    throw new Error("exact-prompt-wording-required");
  return prompt;
}
export function nativeScenarioTopics(
  register: ClinicContent,
  id: ScenarioId,
  context: {
    relevantTopicIds?: readonly TopicId[];
    responses?: Readonly<Record<string, TopicResponse | undefined>>;
    evidence?: EvidenceContext;
    context?: NativeRoutingContext;
    includeUnresolvedBranches?: boolean;
  } = {},
): TopicDefinition[] {
  const scenario = scenarios[id],
    selected =
      id === "first-intake"
        ? scenario.reusableTopicIds
        : (context.relevantTopicIds ?? []);
  if (selected.some((topicId) => !scenario.reusableTopicIds.includes(topicId)))
    throw new Error("topic-not-in-scenario");
  const all = nativeTopics(register),
    topics = [
      ...all.filter((t) =>
        scenario.additionalTopics.some((a) => a.id === t.id),
      ),
      ...all.filter((t) => selected.includes(t.id as TopicId)),
    ];
  const snapshot = {
    topics: Object.fromEntries(
      Object.entries(context.responses ?? {}).filter(
        (entry): entry is [string, TopicResponse] => !!entry[1],
      ),
    ),
    context: context.context,
  };
  const evidence = context.evidence ?? { validSourceIds: new Set<string>() };
  const routingRules = nativeRoutingRules(all);
  for (const branch of Object.values(register.branches)) {
    if (!("rule" in branch)) continue;
    const rule = routingRules.find((rule) => rule.kind === "topic" && rule.target === branch.topic.id);
    if (!rule) continue;
    const eligible = rule.anchors.some((anchor) =>
      topics.some((t) => anchor.startsWith(`${t.id}.`)),
    );
    const decision = evaluateNativeRule(rule, snapshot, evidence);
    const namedApplicable = branchRules[branch.rule.id](
      context.responses?.Q06?.answers ?? {}, evidence,
      "slot" in branch.rule ? branch.rule.slot : undefined,
    );
    // The native adapter additionally preserves source-qualified context, reviewed facts,
    // and unknown outcomes. Named rules alone do not replace these published semantics.
    if (
      eligible &&
      (namedApplicable || decision.outcome === "applicable" ||
        (context.includeUnresolvedBranches && decision.outcome === "unknown"))
    )
      topics.push(all.find((t) => t.id === rule.target)!);
  }
  return topics;
}
function compile(
  topics: TopicDefinition[],
  prompts: Record<string, NativePromptTarget>,
  rules: NativeRule[],
): NativeItem[] {
  const stateOptions = [
    "known",
    "negative",
    "unknown",
    "declined",
    "uncertain",
    "skipped",
    "not-asked",
    "not-applicable",
    "conflicting",
  ].map((valueString) => ({ valueString }));
  const compileSlots = (
    topicId: string,
    slots: readonly SlotDefinition[],
    prefix = "",
  ): NativeItem[] =>
    slots.flatMap((slot) => {
      const path = prefix + slot.id,
        linkId = `${topicId}.${path}`,
        stateId = `${linkId}.__state`,
        rule = rules.find(
          (r) =>
            r.target === linkId.replace(/\.__entry\./g, "[*].") &&
            r.kind === "slot",
        );
      const condition: NativeItem["enableWhen"] = rule
        ? [
            {
              question: `${linkId}.__applicability`,
              operator: "=",
              answerString: "applicable",
            },
          ]
        : undefined;
      const metadata = [
        {
          url: `${NATIVE_EXTENSION}slot-path`,
          valueString: path.replace(/\.__entry\./g, "[*]."),
        },
        {
          url: `${NATIVE_EXTENSION}prompt-targets`,
          valueString: nativeCanonicalJson(
            Object.values(prompts).filter((prompt) =>
              prompt.targets.includes(
                `${topicId}.${path.replace(/\.__entry\./g, "[*].")}`,
              ),
            ),
          ),
        },
      ];
      const state: NativeItem = {
        linkId: stateId,
        type: "choice",
        readOnly: true,
        answerOption: stateOptions,
        extension: [
          { url: `${NATIVE_EXTENSION}app-owned-state`, valueBoolean: true },
        ],
      };
      const controls: NativeItem[] = rule
        ? [
            {
              linkId: `${linkId}.__applicability`,
              type: "choice",
              readOnly: true,
              answerOption: ["applicable", "not-applicable", "unknown"].map(
                (valueString) => ({ valueString }),
              ),
              extension: [
                {
                  url: `${NATIVE_EXTENSION}app-owned-rule`,
                  valueString: rule.id,
                },
              ],
            },
          ]
        : [];
      const valueWhen: NonNullable<NativeItem["enableWhen"]> = [
        { question: stateId, operator: "=", answerString: "known" },
      ];
      const required = !slot.optional;
      const text = slot.promptIds.length
        ? prompts[slot.promptIds[0]].text
        : slot.label;
      if (slot.kind === "collection")
        return [
          ...controls,
          {
            linkId: `${linkId}.__container`,
            type: "group" as const,
            text: slot.label,
            enableWhen: condition,
            item: [
              state,
              {
                linkId: `${linkId}.__complete`,
                type: "boolean" as const,
                readOnly: true,
              },
              {
                linkId: `${linkId}.__entry`,
                type: "group" as const,
                repeats: true,
                required,
                enableWhen: valueWhen,
                item: compileSlots(
                  topicId,
                  slot.fields ?? [],
                  `${path}.__entry.`,
                ),
              },
            ],
            extension: metadata,
          },
        ];
      if (slot.kind === "height-value")
        return [
          ...controls,
          {
            linkId,
            type: "group" as const,
            text,
            enableWhen: condition,
            item: [
              state,
              {
                linkId: `${linkId}.__scalar`,
                type: "decimal" as const,
                required,
                enableWhen: [
                  {
                    question: `${topicId}.height.unit`,
                    operator: "=",
                    answerString: "cm",
                  },
                  {
                    question: `${topicId}.height.unit`,
                    operator: "=",
                    answerString: "m",
                  },
                  {
                    question: `${topicId}.height.unit`,
                    operator: "=",
                    answerString: "in",
                  },
                  {
                    question: `${topicId}.height.unit`,
                    operator: "=",
                    answerString: "ft",
                  },
                ],
                enableBehavior: "any" as const,
              },
              {
                linkId: `${linkId}.__feet`,
                type: "integer" as const,
                required,
                enableWhen: [
                  {
                    question: `${topicId}.height.unit`,
                    operator: "=",
                    answerString: "ft-in",
                  },
                ],
              },
              {
                linkId: `${linkId}.__inches`,
                type: "decimal" as const,
                required,
                enableWhen: [
                  {
                    question: `${topicId}.height.unit`,
                    operator: "=",
                    answerString: "ft-in",
                  },
                ],
              },
            ],
            extension: metadata,
          },
        ];
      const boolean =
        slot.kind === "presence" ||
        (slot.kind === "choice" &&
          slot.choices?.every((c) => typeof c === "boolean"));
      if (boolean && slot.acceptsNegative) {
        controls.push({
          linkId: `${linkId}.__valueEnabled`,
          type: "boolean",
          readOnly: true,
          extension: [
            {
              url: `${NATIVE_EXTENSION}state-predicate`,
              valueString: "known-or-explicit-negative",
            },
          ],
        });
        valueWhen.splice(0, valueWhen.length, {
          question: `${linkId}.__valueEnabled`,
          operator: "=",
          answerBoolean: true,
        });
      }
      if (condition) valueWhen.push(...condition);
      const type: NativeItem["type"] = boolean
        ? "boolean"
        : slot.kind === "positive-number"
          ? "decimal"
          : slot.kind === "choice"
            ? "choice"
            : slot.id === "statedAt" || slot.id.endsWith(".statedAt")
              ? "dateTime"
              : ["serviceDate", "requestedDate"].includes(slot.id)
                ? "date"
                : "text";
      const options =
        type === "choice"
          ? slot.choices?.map((value) =>
              typeof value === "number"
                ? {
                    valueCoding: {
                      system: "urn:corvo:phq4-response",
                      code: String(value),
                      display: mentalHealthOptions.phq4.choices.find(
                        (c) => c.value === value,
                      )!.label,
                    },
                  }
                : { valueString: String(value) },
            )
          : undefined;
      return [
        ...controls,
        state,
        {
          linkId,
          type,
          text,
          required,
          enableWhen: valueWhen,
          enableBehavior:
            valueWhen.length > 1 ? (condition ? "all" : "any") : undefined,
          answerOption: options,
          extension: metadata,
          ...(condition
            ? {
                extension: [
                  ...metadata,
                  {
                    url: `${NATIVE_EXTENSION}applicability-control`,
                    valueString: condition[0].question,
                  },
                ],
              }
            : {}),
        },
      ];
    });
  return [
    ...Object.values(prompts)
      .filter((p) => p.kind === "display" || p.kind === "stop")
      .map((p) => ({
        linkId: `prompt.${p.id}`,
        type: "display" as const,
        text: p.text,
        extension: [
          {
            url: `${NATIVE_EXTENSION}prompt-descriptor`,
            valueString: nativeCanonicalJson(p),
          },
        ],
      })),
    ...topics.flatMap((topic) => [
      {
        linkId: `${topic.id}.__applicability`,
        type: "choice" as const,
        readOnly: true,
        answerOption: ["applicable", "not-applicable", "unknown"].map(
          (valueString) => ({ valueString }),
        ),
      },
      {
        linkId: topic.id,
        type: "group" as const,
        extension: [
          {
            url: `${NATIVE_EXTENSION}topic-definition`,
            valueString: nativeCanonicalJson({ ...definitionTopic(topic), slots: undefined }),
          },
        ],
        item: [
          {
            linkId: `${topic.id}.__opening`,
            type: "display" as const,
            text: prompts[topic.openingPromptId].text,
          },
          ...compileSlots(topic.id, topic.slots),
        ],
        enableWhen: [
          {
            question: `${topic.id}.__applicability`,
            operator: "=" as const,
            answerString: "applicable",
          },
        ],
      },
    ]),
  ];
}
export function validateNativeDefinitionStructure(items: NativeItem[]): void {
  const entries: NativeItem[] = [];
  const visit = (list: NativeItem[]) =>
    list.forEach((item) => {
      entries.push(item);
      if (item.item) visit(item.item);
    });
  visit(items);
  const ids = new Set(entries.map((i) => i.linkId));
  if (ids.size !== entries.length) throw new Error("duplicate-native-link-id");
  const edges = new Map(
    entries.map((i) => [i.linkId, i.enableWhen?.map((c) => c.question) ?? []]),
  );
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) throw new Error("native-rule-cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of edges.get(id) ?? []) {
      if (!ids.has(next)) throw new Error("dangling-native-rule");
      walk(next);
    }
    visiting.delete(id);
    visited.add(id);
  };
  entries.forEach((item) => {
    if ((item.enableWhen?.length ?? 0) > 1 && !item.enableBehavior)
      throw new Error("missing-enable-behavior");
    walk(item.linkId);
  });
}
let cached: Promise<NativeQuestionnaireDefinition> | undefined;
export function getNativeQuestionnaireDefinition(): Promise<NativeQuestionnaireDefinition> {
  cached ??= (async () => {
    const topics = nativeTopics(),
      routingRules = nativeRoutingRules(topics),
      promptTargets = catalog(topics, routingRules),
      items = compile(topics, promptTargets, routingRules);
    validateNativeDefinitionStructure(items);
    const standaloneForm = {
      supported: false as const,
      missingCapabilities: [
        "source-qualified tri-state applicability adapter",
        "repeated instance identity and correction history",
        "recognition confirmation and exact PHQ-4 voice choice",
        "trusted completeness and server record provenance",
      ],
    };
    const payload = {
      canonical: NATIVE_QUESTIONNAIRE_CANONICAL,
      version: NATIVE_QUESTIONNAIRE_VERSION,
      // Scoped dialogue copy has never been part of the published native definition.
      topics: topics.map(topic => ({ ...definitionTopic(topic), slots: topic.slots.map(definitionSlot) })),
      promptTargets,
      routingRules,
      aliases: nativeAliases,
      stopSemantics,
      safetyDefinition,
      specificityContract,
      sourceRecognition: nativeSourceRecognition,
      items,
      mapperContract: "typed-state-repeats-history-v4",
      evaluatorContract: nativeEvaluatorContract,
      measurementContract: "height-representation-matches-explicit-unit",
      standaloneForm,
    };
    const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(nativeCanonicalJson(payload)),
      ),
      hash = Array.from(new Uint8Array(bytes), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const binding = {
      canonical: NATIVE_QUESTIONNAIRE_CANONICAL,
      version: NATIVE_QUESTIONNAIRE_VERSION,
      digest: hash,
    };
    return {
      binding,
      topics,
      promptTargets,
      routingRules,
      aliases: nativeAliases,
      standaloneForm,
      questionnaire: {
        resourceType: "Questionnaire",
        url: binding.canonical,
        version: binding.version,
        status: "active",
        item: items,
        extension: [
          { url: `${NATIVE_EXTENSION}definition-digest`, valueString: hash },
          {
            url: `${NATIVE_EXTENSION}routing-contract`,
            valueString: nativeCanonicalJson({
              routingRules,
              aliases: nativeAliases,
              standaloneForm,
              sourceRecognition: nativeSourceRecognition,
              evaluatorContract: nativeEvaluatorContract,
            }),
          },
          {
            url: `${NATIVE_EXTENSION}prompt-catalog`,
            valueString: nativeCanonicalJson(promptTargets),
          },
          {
            url: `${NATIVE_EXTENSION}safety-contract`,
            valueString: nativeCanonicalJson(safetyDefinition),
          },
          {
            url: `${NATIVE_EXTENSION}specificity-contract`,
            valueString: nativeCanonicalJson(specificityContract),
          },
        ],
      },
    };
  })();
  return cached.then((value) => structuredClone(value));
}
/** Uses authored sufficiency, including required measurements. Confirmation cannot supply missing detail. */
export function nativeCaptureComplete(
  capture: NativeQuestionnaireCapture,
  evidence: EvidenceContext,
): boolean {
  if (capture.unreviewedSourceIds.some(id => !evidence.reviewedSourceAccountedFor?.(id))) return false;
  const topics = nativeScenarioTopics(
    defaultNativeRegister(),
    capture.scenario,
    {
      relevantTopicIds: capture.relevantTopicIds,
      responses: capture.topics,
      evidence,
      context: capture.context,
      includeUnresolvedBranches: true,
    },
  );
  const reproductiveExplicit =
    capture.relevantTopicIds.includes("Q18") ||
    evaluateNativeRule(
      nativeRoutingRules(nativeTopics()).find(
        (rule) => rule.id === "branch.reproductive",
      )!,
      { topics: capture.topics, context: capture.context },
      evidence,
    ).outcome === "applicable";
  return topics
    .filter(
      (topic) =>
        topic.presentation !== "O" &&
        (topic.id !== "Q18" || reproductiveExplicit),
    )
    .every(
      (topic) =>
        evaluateTopic(
          topic,
          capture.topics[topic.id] ?? emptyResponse(),
          evidence,
        ).sufficient && !vagueAnswer(topic.id, capture.topics[topic.id]),
    );
}

/** Whether a recorded answer is still non-specific under its specificity contract (SP-0.1); then the capture is not complete. */
function vagueAnswer(topicId: string, response: TopicResponse | undefined): boolean {
  if (!response) return false;
  return specificityContracts.filter((contract) => contract.topicId === topicId).some((contract) => {
    const values: unknown[] = [];
    const scalar = response.answers[contract.path];
    if (scalar) { if (scalar.state === "known" && !scalar.items) values.push(scalar.value); }
    else {
      const [list, field] = contract.path.split(".");
      const collection = field ? response.answers[list!] : undefined;
      if (collection?.state === "known") for (const item of collection.items ?? []) { const answer = item.answers[field!]; if (answer?.state === "known") values.push(answer.value); }
    }
    return values.some((value) => typeof value === "string" && value.trim() && assessSpecificity(contract, value, lookupReference).level !== "specific");
  });
}

export interface NativeAnswerTreeItem {
  linkId: string;
  id?: string;
  answer?: Array<{
    valueString?: string;
    valueBoolean?: boolean;
    [key: string]: unknown;
  }>;
  item?: NativeAnswerTreeItem[];
}
/** Standard R4 enableWhen evaluation over controls produced by our trusted adapter. */
export function nativeCompiledActiveValues(
  definition: NativeQuestionnaireDefinition,
  response: readonly NativeAnswerTreeItem[],
): string[] {
  const result: string[] = [];
  const walk = (
    items: readonly NativeItem[],
    answers: readonly NativeAnswerTreeItem[],
    inherited: ReadonlyMap<string, string | boolean>,
    instanceIds: readonly string[],
  ) => {
    const scope = new Map(inherited);
    const collect = (list: readonly NativeAnswerTreeItem[]) =>
      list.forEach((item) => {
        const value = item.answer?.[0];
        if (value?.valueString !== undefined)
          scope.set(item.linkId, value.valueString);
        else if (value?.valueBoolean !== undefined)
          scope.set(item.linkId, value.valueBoolean);
        if (item.item && !item.id) collect(item.item);
      });
    collect(answers);
    const enabled = (item: NativeItem) => {
      if (!item.enableWhen) return true;
      const matches = item.enableWhen.map(
        (condition) =>
          scope.get(condition.question) ===
          (condition.answerString ?? condition.answerBoolean),
      );
      return item.enableBehavior === "any"
        ? matches.some(Boolean)
        : matches.every(Boolean);
    };
    for (const item of items) {
      if (!enabled(item)) continue;
      const occurrences = answers.filter(
        (answer) => answer.linkId === item.linkId,
      );
      for (const answer of occurrences) {
        const instances = answer.id ? [...instanceIds, answer.id] : instanceIds;
        if (item.item) walk(item.item, answer.item ?? [], scope, instances);
        else if (
          answer.answer?.length &&
          !item.readOnly &&
          item.type !== "display"
        ) {
          let index = 0;
          const path = item.linkId.replace(
            /\.__entry(?=\.|$)/g,
            () => `[${instances[index++]}]`,
          );
          result.push(path);
        }
      }
    }
  };
  walk(definition.questionnaire.item, response, new Map(), []);
  return result.sort();
}

export const nativeEvaluatorContract = {
  version: 4,
  sourceFactTrust:
    "leaf-and-every-containing-collection-must-be-known-and-source-qualified-before-branch-or-reuse; unreviewed-ancestors-never-enable-confirmed-descendants",
  crossTopicReuse:
    "GI.effect-from-detailed-source-qualified-Q07-event-effect; Q15.condition-from-known-true-Q06.sleepApnea; preserve-original-target-and-instance; explicit-target-wins; recompute-derived-values-on-origin-correction",
  administrationClarification:
    "source-facts-per-topic-and-repeated-instance; legacy-single-fact-accepted; each-explicit-answer-closes-only-own-target",
  reproductiveCompleteness:
    "required-only-with-explicit-Q18-relevance-or-source-qualified-applicable-reproductive-rule; absent-trigger-remains-unknown",
} as const;
function administrationFacts(
  context: NativeRoutingContext,
): NativeSourceFact[] {
  const value = context.administrationUnclear;
  return value ? (Array.isArray(value) ? value : [value]) : [];
}
/** Conservative, closed recognition of explicit facts in already-authored, source-qualified targets. */
export const nativeSourceRecognition = {
  sleepApnea:
    "^(?:I (?:have|was diagnosed with|have been told I have) )?(?:obstructive |central )?sleep apn(?:ea|oea)[.!]?$",
  surgeryEatingEffect: "\\b(eating|drinking|digestion)\\b",
  surgeryDetailedEffect:
    "\\b(cannot tolerate|can\'t tolerate|can only|cannot eat|can\'t eat|cannot drink|can\'t drink|difficulty (?:eating|drinking|digesting)|difficult to (?:eat|drink|digest)|fills? me|small meals|solid food|causes? (?:pain|nausea|vomiting|diarrh(?:ea|oea)))\\b",
  surgeryReuseUncertain:
    "\\b(may|might|could|possibly|maybe|possible|unsure|uncertain|not sure|don\'t know|do not know)\\b",
  surgeryCurrentEffect:
    "\\b(affects|changed|trouble|difficulty|difficult|makes|causes|now|currently|still)\\b",
  reproductiveMedicationPurpose:
    "\\b(weight management|weight loss|lose weight)\\b",
  reproductivePurposeNegatedOrUncertain:
    "\\b(?:not|never|isn't|is not)\\s+(?:for\\s+|to\\s+)?(?:weight management|weight loss|lose weight)\\b|\\b(?:unsure|uncertain|maybe|possibly|not sure|don't know|do not know)\\b[^,;.!?]{0,32}\\b(?:weight management|weight loss|lose weight)\\b",
  administrationUnclear:
    "\\b(not sure|unsure|uncertain|don't know|do not know)\\b.*\\b(took|taken|take|dose|dosing)\\b",
  immediateSignsUnclear: "\\b(feel(?:ing)? (?:ill|sick)|eating very little)\\b",
  preparationRelevant:
    "\\b(prepared differently|preparation matters|depends on (?:how|preparation)|depends how)\\b",
  preparationUnknown:
    "\\b(don't know|do not know|unsure|not sure|can't recall|cannot recall)\\b",
  explicitNegativeOrUncertain:
    "\\b(no|not|never|ruled out|maybe|possible|unsure|uncertain|don't know|do not know)\\b",
} as const;
/** Unmatched text leaves routing unknown. This never diagnoses from a name or infers a procedure's relevance. */
export function deriveNativeRoutingContext(
  topics: Readonly<Record<string, TopicResponse | undefined>>,
  evidence: EvidenceContext,
  serverContext: NativeRoutingContext = {},
): NativeRoutingContext {
  const result: NativeRoutingContext = { ...serverContext };
  const match = (key: keyof typeof nativeSourceRecognition, text: string) =>
    new RegExp(nativeSourceRecognition[key], "i").test(text);
  const asFact = (
    topicId: string,
    path: string,
    answer: SlotAnswer | undefined,
  ): NativeSourceFact | undefined =>
    answer?.state === "known" &&
    !answer.items &&
    typeof answer.value === "string" &&
    hasValidEvidence(answer, { ...evidence, topicId }, path)
      ? { topicId, path, sourceIds: [...answer.sourceIds] }
      : undefined;
  const textOf = (answer: SlotAnswer | undefined) =>
    answer?.state === "known" &&
    !answer.items &&
    typeof answer.value === "string"
      ? answer.value.trim()
      : "";
  const sleep = topics.Q15?.answers.condition;
  if (match("sleepApnea", textOf(sleep)))
    result.sleepApnea = asFact("Q15", "condition", sleep);
  const events = topics.Q07?.answers.events;
  if (events?.state === "known")
    for (const item of events.items ?? []) {
      const answer = item.answers.effects,
        text = textOf(answer);
      if (
        match("surgeryEatingEffect", text) &&
        match("surgeryCurrentEffect", text) &&
        !match("explicitNegativeOrUncertain", text)
      ) {
        const fact = asFact("Q07", `events[${item.id}].effects`, answer);
        if (fact) {
          result.surgeryEatingEffect = fact;
          break;
        }
      }
    }
  const administration = [...administrationFacts(result)];
  const addAdministration = (fact: NativeSourceFact | undefined) => {
    if (
      fact &&
      !administration.some(
        (old) => old.topicId === fact.topicId && old.path === fact.path,
      )
    )
      administration.push(fact);
  };
  const medicines = topics.Q08?.answers.medicines;
  if (medicines?.state === "known")
    for (const item of medicines.items ?? []) {
      const purpose = item.answers.reason,
        text = textOf(purpose);
      if (
        !result.reproductive &&
        match("reproductiveMedicationPurpose", text) &&
        !match("reproductivePurposeNegatedOrUncertain", text)
      )
        result.reproductive = asFact(
          "Q08",
          `medicines[${item.id}].reason`,
          purpose,
        );
      for (const path of ["actualUse", "concerns"]) {
        const answer = item.answers[path],
          text = textOf(answer);
        if (match("administrationUnclear", text) && !escalation(text))
          addAdministration(
            asFact("Q08", `medicines[${item.id}].${path}`, answer),
          );
      }
    }
  for (const path of ["actualUse", "symptomsChanges"]) {
    const answer = topics.W07?.answers[path],
      text = textOf(answer);
    if (match("administrationUnclear", text) && !escalation(text))
      addAdministration(asFact("W07", path, answer));
  }
  if (administration.length) result.administrationUnclear = administration;
  const concern = topics.Q02?.answers.concern,
    text = textOf(concern);
  if (match("immediateSignsUnclear", text) && !escalation(text))
    result.immediateSignsUnclear = asFact("Q02", "concern", concern);
  const occasions = topics.Q11?.answers.occasions,
    preparation = [...(result.preparation ?? [])];
  if (occasions?.state === "known")
    for (const item of occasions.items ?? [])
      for (const path of ["foods", "drinks"]) {
        const answer = item.answers[path],
          text = textOf(answer);
        if (
          match("preparationRelevant", text) &&
          !match("preparationUnknown", text)
        ) {
          const fact = asFact("Q11", `occasions[${item.id}].${path}`, answer);
          if (fact && !preparation.some((old) => old.path === fact.path))
            preparation.push(fact);
        }
      }
  if (preparation.length) result.preparation = preparation;
  // Remove empty optional entries so serialization and digesting are deterministic.
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  ) as NativeRoutingContext;
}

/** Closed reuse proposals retain the original authored target and repeated instance. */
export function nativeCrossTopicReuses(
  snapshot: {
    topics: Readonly<Record<string, TopicResponse | undefined>>;
    context?: NativeRoutingContext;
  },
  evidence: EvidenceContext,
): Array<{
  topicId: "GI" | "Q15";
  path: "effect" | "condition";
  answer: SlotAnswer;
}> {
  const result: Array<{
    topicId: "GI" | "Q15";
    path: "effect" | "condition";
    answer: SlotAnswer;
  }> = [];
  const apnea = snapshot.topics.Q06?.answers["conditions.sleepApnea"];
  if (
    apnea?.state === "known" &&
    !apnea.items &&
    apnea.value === true &&
    hasValidEvidence(apnea, { ...evidence, topicId: "Q06" }, "conditions.sleepApnea")
  )
    result.push({
      topicId: "Q15",
      path: "condition",
      answer: {
        state: "known",
        value: "sleep apnea",
        sourceIds: [...apnea.sourceIds],
        reusedFrom: { topicId: "Q06", path: "conditions.sleepApnea" },
      },
    });
  const fact = snapshot.context?.surgeryEatingEffect;
  if (
    fact &&
    fact.topicId === "Q07" &&
    /^events\[[A-Za-z0-9_-]+\]\.effects$/.test(fact.path) &&
    nativeSourceFactValid(fact, snapshot.topics, evidence)
  ) {
    const origin = nativeResolveSlot(
      nativeTopics().find((t) => t.id === "Q07")!,
      snapshot.topics.Q07!,
      fact.path,
    ).answer;
    if (
      origin?.state === "known" &&
      !origin.items &&
      typeof origin.value === "string" &&
      new RegExp(nativeSourceRecognition.surgeryDetailedEffect, "i").test(
        origin.value,
      ) &&
      new RegExp(nativeSourceRecognition.surgeryCurrentEffect, "i").test(
        origin.value,
      ) &&
      new RegExp(nativeSourceRecognition.surgeryEatingEffect, "i").test(
        origin.value,
      ) &&
      !new RegExp(
        nativeSourceRecognition.explicitNegativeOrUncertain,
        "i",
      ).test(origin.value) &&
      !new RegExp(nativeSourceRecognition.surgeryReuseUncertain, "i").test(
        origin.value,
      )
    )
      result.push({
        topicId: "GI",
        path: "effect",
        answer: {
          state: "known",
          value: origin.value,
          sourceIds: [...origin.sourceIds],
          reusedFrom: { topicId: "Q07", path: fact.path },
        },
      });
  }
  return result;
}
/** Select only an active authored prompt, filling templates from verified records alone.
 * This is runtime navigation; unavailable prompts never change capture/readiness data. */
export function activeNativeGuidedPrompt(
  topic: TopicDefinition,
  field: Pick<GuidedField, "path" | "promptIds">,
  authority: NativePromptAuthority & { scenario: ScenarioId },
  evidence: EvidenceContext,
): { promptId: string; text: string } | undefined {
  const contextPrompts = scenarioForWorkflowTopic(topic.id)?.behaviour?.contextPrompts;
  const candidates = field.promptIds.flatMap(id =>
    contextPrompts && id === contextPrompts.verifiedPromptId ? [id, contextPrompts.missingPromptId] : [id],
  );
  for (const promptId of new Set(candidates)) {
    let text = promptsById[promptId]?.text;
    if (!text) continue;
    const verified = authority.context;
    if (promptId === "S01" && verified?.appointment)
      text = text.replace("[verified date/time/timezone]", `${verified.appointment.startsAt} ${verified.appointment.timezone}`).replace("[dated prior update]", verified.appointment.priorUpdateAt);
    if (promptId === "S03" && verified?.plan)
      text = text.replace("[demo author/role]", verified.plan.author).replace("[date]", verified.plan.recordedAt);
    if (text.includes("[")) continue;
    try {
      guardNativePrompt({ ...authority, promptId, topicId: topic.id, path: field.path, text }, evidence);
      return { promptId, text };
    } catch {
      // An inactive first candidate must not hide a later active authored prompt.
    }
  }
}

/** Authored one-field selection. Relevant optional clarifications never become universal completion minimums. */
export function nextNativeGuidedField(
  topic: TopicDefinition,
  response: TopicResponse,
  evidence: EvidenceContext,
  snapshot: {
    topics: Readonly<Record<string, TopicResponse | undefined>>;
    context?: NativeRoutingContext;
  },
): GuidedField | undefined {
  if (
    response.stopped ||
    (topic.presentation === "C" && response.applicability !== "applicable")
  )
    return;
  const topics = Object.fromEntries(
    Object.entries(snapshot.topics).filter(
      (entry): entry is [string, TopicResponse] => !!entry[1],
    ),
  );
  const context = deriveNativeRoutingContext(
      snapshot.topics,
      evidence,
      snapshot.context,
    ),
    decisions = nativeRoutingDecisions({ topics, context }, evidence);
  // Scope uncertainty to each named condition; a single broad recall never closes several instances.
  for (const entry of nativeSlotEntries([topic]).filter(
    (entry) => entry.slot.optional && entry.path !== "uncertainDiagnosis",
  )) {
    const collection = entry.path.includes("[*]")
      ? response.answers[entry.path.split("[*]")[0]]
      : undefined;
    const instances = entry.path.includes("[*]")
      ? collection?.state === "known"
        ? (collection.items?.map((item) => item.id) ?? [])
        : []
      : [undefined];
    for (const instanceId of instances) {
      const decision = decisions.find(
        (decision) =>
          decision.ruleId === `slot.${entry.topicId}.${entry.path}` &&
          decision.instanceId === instanceId,
      );
      if (decision?.outcome !== "applicable") continue;
      const path = entry.path.replace("[*]", `[${instanceId}]`),
        resolved = nativeResolveSlot(topic, response, path);
      // Any explicit state closes that clarification; don't rephrase unknown, refusal, or skip.
      if (resolved.answer && resolved.answer.state !== "not-asked") continue;
      return guidedFieldForPath(topic, response, path);
    }
  }
  const workflow = scenarioForWorkflowTopic(topic.id);
  if (workflow) {
    // Filter navigation metadata only. In particular W02.changes remains unasked
    // and unresolved until its prior item/date can be supplied by trusted context.
    const navigable = { ...topic, slots: topic.slots.map(slot => {
      const selected = activeNativeGuidedPrompt(topic, { path: slot.id, promptIds: slot.promptIds }, { scenario: workflow.id, topics, context }, evidence);
      return { ...slot, promptIds: selected ? [selected.promptId] : [] };
    }) };
    return nextGuidedField(navigable, response, evidence);
  }
  return nextGuidedField(topic, response, evidence);
}
