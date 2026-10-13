import { describe, expect, it } from "vitest";
import {
  getNativeQuestionnaireDefinition,
  evaluateNativeRule,
  nativeScenarioTopics,
  nativeTopics,
  createClinicContent,
  guardNativePrompt,
  nativeResolveAlias,
  validateNativeDefinitionStructure,
} from "../src/index.js";
import type { TopicResponse } from "../src/types.js";
const evidence = { validSourceIds: new Set(["s1", "s2"]) };
const known = (value: string | number | boolean) => ({
  state: "known" as const,
  value,
  sourceIds: ["s1"],
});
const negative = { state: "negative" as const, sourceIds: ["s1"] };
const topic = (answers: TopicResponse["answers"]): TopicResponse => ({
  presented: true,
  answers,
});
describe("fixed authored native Questionnaire", () => {
  it("compiles every fixed prompt with unique reachable acyclic link IDs and binds all semantics", async () => {
    const d = await getNativeQuestionnaireDefinition();
    expect(d.binding.digest).toMatch(/^[a-f0-9]{64}$/);
    // Pinned; extraction-only slot hints must not change it. E-0.2 safety and SP-0.1 specificity with its reference
    // releases (D1 re-qualification, published with stage8).
    expect(d.binding.digest).toBe("442fa9ed9da87ec6895720a7d086e2cc41b036a6a9c074df1111cd46088bd1a6");
    const specificity = JSON.parse(d.questionnaire.extension!.find((e) => e.url.endsWith("specificity-contract"))!.valueString!);
    expect(specificity).toMatchObject({ version: "SP-0.1", budget: { perField: 2, perTopic: 4, perTurn: 1 }, reference: { medications: "rxnorm-prescribe-2026-10-05", conditions: "CT-0.1+icd10cm-FY2027" } });
    expect(d.questionnaire.url).toBe(d.binding.canonical);
    validateNativeDefinitionStructure(d.questionnaire.item);
    expect(d.promptTargets["MH.unscored"]).toBeUndefined();
    expect(d.topics.some((t) => t.id === "COND")).toBe(false);
    expect(d.promptTargets.MH01.text).toBe(
      "Feeling nervous, anxious or on edge",
    );
    expect(d.standaloneForm.supported).toBe(false);
    const mutated = await getNativeQuestionnaireDefinition();
    mutated.questionnaire.item = [];
    expect(
      (await getNativeQuestionnaireDefinition()).questionnaire.item.length,
    ).toBeGreaterThan(0);
  });
  it("evaluates consequential diabetes true false unknown without inferring from medicines", async () => {
    const d = await getNativeQuestionnaireDefinition(),
      rule = d.routingRules.find((r) => r.id === "branch.diabetes")!;
    expect(
      evaluateNativeRule(
        rule,
        { topics: { Q06: topic({ "conditions.diabetes": known(true) }) } },
        evidence,
      ).outcome,
    ).toBe("applicable");
    expect(
      evaluateNativeRule(
        rule,
        {
          topics: {
            Q06: topic({
              "conditions.diabetes": negative,
              "conditions.prediabetes": negative,
            }),
          },
        },
        evidence,
      ).outcome,
    ).toBe("not-applicable");
    expect(
      evaluateNativeRule(
        rule,
        { topics: { Q08: topic({ medicines: known("metformin") }) } },
        evidence,
      ).outcome,
    ).toBe("unknown");
    expect(
      evaluateNativeRule(
        rule,
        {
          topics: {
            Q06: topic({
              "conditions.diabetes": { state: "uncertain", sourceIds: ["s1"] },
            }),
          },
        },
        evidence,
      ).outcome,
    ).toBe("unknown");
  });
  it("routes all seven scenarios and rejects foreign targets", () => {
    for (const scenario of Object.keys(
      createClinicContent().scenarios,
    ) as Array<keyof ReturnType<typeof createClinicContent>["scenarios"]>) {
      const topics = nativeScenarioTopics(createClinicContent(), scenario);
      expect(topics.length).toBeGreaterThan(0);
      expect(topics.some((t) => t.id === "Q04")).toBe(
        scenario === "first-intake",
      );
    }
    expect(() =>
      nativeScenarioTopics(createClinicContent(), "billing", {
        relevantTopicIds: ["Q04"],
      }),
    ).toThrow("topic-not-in-scenario");
  });
  it("enforces exact PHQ and scoped correction and COND aliases", () => {
    expect(nativeResolveAlias("COND", "care", "c2")).toEqual({
      topicId: "Q06",
      path: "reportedConditions[c2].care",
    });
    expect(() => nativeResolveAlias("COND", "care")).toThrow(
      "condition-instance-required",
    );
    expect(() =>
      guardNativePrompt(
        {
          promptId: "MH01",
          topicId: "Q16",
          path: "MH01",
          text: "Are you nervous?",
          scenario: "first-intake",
          topics: {},
        },
        evidence,
      ),
    ).toThrow("exact-prompt-wording-required");
    expect(() =>
      guardNativePrompt(
        {
          promptId: "made-up",
          topicId: "Q01",
          scenario: "first-intake",
          topics: {},
        },
        evidence,
      ),
    ).toThrow("unauthored-prompt");
    expect(
      nativeTopics()
        .find((t) => t.id === "Q11")!
        .slots.find((s) => s.id === "occasions")!
        .fields!.find((s) => s.id === "preparation")!.optional,
    ).toBe(true);
  });
});

describe("each authored conditional slot rule", () => {
  it("matches the live minimum evaluator for true, false and unresolved anchors in their own repeat", async () => {
    const { nativeSlotEntries, nativeRoutingRules, nativeResolveSlot } =
      await import("../src/native-questionnaire.js");
    const { evaluateSlots } = await import("../src/readiness.js");
    const all = nativeTopics();
    for (const rule of nativeRoutingRules().filter(
      (rule) => rule.kind === "slot" && rule.predicate !== "source-fact",
    )) {
      const entry = nativeSlotEntries(all).find(
        (entry) => `${entry.topicId}.${entry.path}` === rule.target,
      )!;
      const definition = all.find((t) => t.id === entry.topicId)!;
      for (const mode of ["positive", "negative", "unknown"] as const) {
        const condition = entry.slot.when!,
          anchors = [condition.slotId, ...(condition.orSlotIds ?? [])];
        const values = Object.fromEntries(
          anchors.map((id) => [
            id,
            mode === "positive"
              ? condition.condition === "uncertain"
                ? { state: "uncertain" as const, sourceIds: ["s1"] }
                : condition.condition === "estimate-needed"
                  ? known(false)
                  : known("yes")
              : mode === "negative"
                ? condition.condition === "uncertain"
                  ? known("settled")
                  : condition.condition === "estimate-needed"
                    ? known(true)
                    : negative
                : { state: "unknown" as const, sourceIds: ["s1"] },
          ]),
        );
        const repeat = entry.path.includes("[*]"),
          collection = repeat ? entry.path.split("[*]")[0] : undefined;
        const response = topic(
          collection
            ? {
                [collection]: {
                  state: "known",
                  items: [{ id: "a", answers: values }],
                  complete: true,
                  sourceIds: ["s1"],
                },
              }
            : values,
        );
        const path = entry.path.replace("[*]", "[a]"),
          resolved = nativeResolveSlot(definition, response, path);
        const parentDefs = repeat
          ? definition.slots.find((s) => s.id === collection)!.fields!
          : definition.slots;
        // Known anchor shape must follow its authored type; no truthiness inference.
        for (const anchor of parentDefs.filter((d) => anchors.includes(d.id)))
          if (mode === "positive" && condition.condition === "positive")
            values[anchor.id] = known(
              anchor.kind === "presence"
                ? true
                : anchor.kind === "positive-number"
                  ? 1
                  : "yes",
            );
        const ruleResult = evaluateNativeRule(
          rule,
          { topics: { [entry.topicId]: response } },
          evidence,
          repeat ? "a" : undefined,
        );
        const readiness = evaluateSlots(
          parentDefs.map((s) =>
            s.id === entry.slot.id ? { ...s, optional: false } : s,
          ),
          resolved.answers,
          evidence,
        ).find((s) => s.id === entry.slot.id)!;
        const appOutcome =
          readiness.state === "not-applicable"
            ? "not-applicable"
            : readiness.reason === "condition-unresolved"
              ? "unknown"
              : "applicable";
        expect(ruleResult.outcome, `${rule.id}:${mode}`).toBe(appOutcome);
      }
    }
  });
});

describe("authored interview navigation", () => {
  it("skips supplied and negative details, selects only relevant preparation, stops explicit unknown, and scopes uncertain conditions", async () => {
    const { deriveNativeRoutingContext, nextNativeGuidedField } =
      await import("../src/native-questionnaire.js");
    const all = nativeTopics(),
      q1 = all.find((t) => t.id === "Q01")!,
      q2 = all.find((t) => t.id === "Q02")!,
      q11 = all.find((t) => t.id === "Q11")!,
      q6 = all.find((t) => t.id === "Q06")!;
    const supplied = topic({
      reason: known("visit"),
      priority: known("energy"),
    });
    expect(
      nextNativeGuidedField(q1, supplied, evidence, {
        topics: { Q01: supplied },
      }),
    ).toBeUndefined();
    const noConcern = topic({ concern: negative });
    expect(
      nextNativeGuidedField(q2, noConcern, evidence, {
        topics: { Q02: noConcern },
      }),
    ).toBeUndefined();
    const eating = topic({
      day: known("yesterday"),
      occasions: {
        state: "known",
        complete: true,
        sourceIds: ["s1"],
        items: [
          {
            id: "a",
            answers: {
              time: known("8am"),
              foods: known("rice prepared differently"),
              drinks: negative,
              foodAmounts: known("a bowl"),
            },
          },
        ],
      },
      otherIntake: negative,
      typicality: known("usual"),
    });
    const context = deriveNativeRoutingContext({ Q11: eating }, evidence);
    expect(context.preparation?.[0].path).toBe("occasions[a].foods");
    expect(
      nextNativeGuidedField(q11, eating, evidence, {
        topics: { Q11: eating },
        context,
      })?.path,
    ).toBe("occasions[a].preparation");
    const answered = structuredClone(eating);
    const collection = answered.answers.occasions;
    if (collection?.state === "known" && collection.items)
      (collection.items[0].answers as Record<string, unknown>).preparation = {
        state: "unknown",
        sourceIds: ["s1"],
      };
    expect(
      nextNativeGuidedField(q11, answered, evidence, {
        topics: { Q11: answered },
        context,
      }),
    ).toBeUndefined();
    const conditions = topic({
      "conditions.diabetes": { state: "uncertain", sourceIds: ["s1"] },
      "conditions.prediabetes": { state: "uncertain", sourceIds: ["s2"] },
    });
    expect(
      nextNativeGuidedField(q6, conditions, evidence, {
        topics: { Q06: conditions },
      })?.path,
    ).toBe("conditions.diabetes.uncertainDiagnosis");
    const firstDone = topic({
      ...conditions.answers,
      "conditions.diabetes.uncertainDiagnosis": known("doctor mentioned it"),
    });
    expect(
      nextNativeGuidedField(q6, firstDone, evidence, {
        topics: { Q06: firstDone },
      })?.path,
    ).toBe("conditions.prediabetes.uncertainDiagnosis");
  });
  it("keeps weight-management relevance when an unrelated condition is denied and scopes purpose negation", async () => {
    const { deriveNativeRoutingContext, nativeRoutingRules } =
      await import("../src/native-questionnaire.js");
    const rule = nativeRoutingRules(nativeTopics()).find(
      (entry) => entry.id === "branch.reproductive",
    )!;
    for (const [reason, expected] of [
      ["For weight loss, not diabetes.", "applicable"],
      ["Not for weight loss.", "unknown"],
      ["I am not sure if it is for weight loss.", "unknown"],
    ] as const) {
      const topics = {
        Q08: topic({
          medicines: {
            state: "known",
            complete: true,
            sourceIds: ["s1"],
            items: [{ id: "m1", answers: { reason: known(reason) } }],
          },
        }),
      };
      const context = deriveNativeRoutingContext(topics, evidence);
      expect(
        evaluateNativeRule(rule, { topics, context }, evidence).outcome,
        reason,
      ).toBe(expected);
    }
  });
  it("clarifies each independently sourced medicine once before finishing the topic", async () => {
    const {
      deriveNativeRoutingContext,
      nextNativeGuidedField,
      nativeRoutingDecisions,
    } = await import("../src/native-questionnaire.js");
    const { applyGuidedAnswer } = await import("../src/guided.js");
    const definition = nativeTopics().find((t) => t.id === "Q08")!;
    let response = topic({
      medicines: {
        state: "known",
        sourceIds: ["s1", "s2"],
        complete: true,
        items: ["m1", "m2"].map((id, index) => ({
          id,
          answers: {
            ...Object.fromEntries(
              Object.entries({
                name: "reported medicine",
                strength: "reported strength",
                labelDirections: "reported directions",
                actualUse: "I am not sure whether I took the dose",
                reason: "reported reason",
              }).map(([key, value]) => [
                key,
                {
                  state: "known" as const,
                  value,
                  sourceIds: [index ? "s2" : "s1"],
                },
              ]),
            ),
            concerns: {
              state: "negative" as const,
              sourceIds: [index ? "s2" : "s1"],
            },
          },
        })),
      },
    });
    const context = deriveNativeRoutingContext({ Q08: response }, evidence);
    expect(
      Array.isArray(context.administrationUnclear) &&
        context.administrationUnclear.map((fact) => fact.path),
    ).toEqual(["medicines[m1].actualUse", "medicines[m2].actualUse"]);
    for (const [id, sourceId] of [
      ["m1", "s1"],
      ["m2", "s2"],
    ]) {
      expect(
        nextNativeGuidedField(definition, response, evidence, {
          topics: { Q08: response },
          context,
        })?.path,
      ).toBe(`medicines[${id}].administrationClarification`);
      expect(
        nativeRoutingDecisions(
          { topics: { Q08: response }, context },
          evidence,
        ).find(
          (decision) =>
            decision.ruleId ===
              "slot.Q08.medicines[*].administrationClarification" &&
            decision.instanceId === id,
        )?.sourceIds,
      ).toEqual([sourceId]);
      response = applyGuidedAnswer(
        definition,
        response,
        {
          path: `medicines[${id}].administrationClarification`,
          answer: { state: "unknown", sourceIds: [sourceId] },
        },
        evidence,
      );
    }
    expect(
      nextNativeGuidedField(definition, response, evidence, {
        topics: { Q08: response },
        context,
      }),
    ).toBeUndefined();
  });
  it("uses explicit source-qualified sleep and surgery effects and never infers apnea from snoring or surgery names", async () => {
    const { deriveNativeRoutingContext, nativeRoutingRules } =
      await import("../src/native-questionnaire.js");
    const sources = {
      Q15: topic({ condition: known("sleep apnea") }),
      Q07: topic({
        events: {
          state: "known",
          sourceIds: ["s1"],
          complete: true,
          items: [
            {
              id: "one",
              answers: {
                event: known("reported surgery"),
                effects: known("It affects eating now"),
              },
            },
          ],
        },
      }),
    };
    const context = deriveNativeRoutingContext(sources, evidence);
    expect(context.sleepApnea?.path).toBe("condition");
    expect(context.surgeryEatingEffect?.path).toBe("events[one].effects");
    for (const id of ["branch.sleep-apnea", "branch.digestive"])
      expect(
        evaluateNativeRule(
          nativeRoutingRules().find((rule) => rule.id === id)!,
          { topics: sources, context },
          evidence,
        ).outcome,
      ).toBe("applicable");
    expect(
      deriveNativeRoutingContext(
        {
          Q15: topic({ condition: known("snoring") }),
          Q07: topic({
            events: {
              state: "known",
              sourceIds: ["s1"],
              complete: true,
              items: [
                {
                  id: "one",
                  answers: {
                    event: known("gastric surgery"),
                    effects: negative,
                  },
                },
              ],
            },
          }),
        },
        evidence,
      ),
    ).toEqual({});
  });
  it("offers authored stop-choice only after server-recorded purpose and continued unsuccessful engagement", () => {
    const args = {
      promptId: "stop-choice",
      topicId: "Q01",
      scenario: "first-intake" as const,
      topics: { Q01: topic({}) },
    };
    expect(() => guardNativePrompt(args, evidence)).toThrow(
      "prompt-rule-inactive",
    );
    expect(
      guardNativePrompt(
        {
          ...args,
          context: {
            engagementUnclear: {
              topicId: "Q01",
              path: "reason",
              sourceIds: ["s1", "s2"],
              purposeExplained: true,
              unsuccessfulAttempts: 2,
            },
          },
        },
        evidence,
      ).id,
    ).toBe("stop-choice");
  });
});

it("proposed repeat sibling conditions permit only the exact item's navigation without branch authority", () => {
  const projected = topic({ occasions: { state: "known", sourceIds: ["s1"], items: [
    { id: "coffee", answers: { drinks: known("coffee") } },
    { id: "water", answers: {} },
  ] } });
  const args = { promptId: "Q11b", topicId: "Q11", path: "occasions[coffee].drinkAmounts", scenario: "first-intake" as const,
    topics: { Q11: topic({}) }, repeatResolutionTopics: { Q11: projected } };
  expect(guardNativePrompt(args, evidence).id).toBe("Q11b");
  expect(args.topics.Q11.answers).toEqual({});
  expect(() => guardNativePrompt({ ...args, path: "occasions[water].drinkAmounts" }, evidence)).toThrow("prompt-target-inactive");
  expect(() => guardNativePrompt({ ...args, path: "occasions[foreign].drinkAmounts" }, evidence)).toThrow("unknown-slot-path");
  expect(() => guardNativePrompt({ ...args, promptId: "DM01", topicId: "DM", path: "typeStatus",
    repeatResolutionTopics: { Q06: topic({ "conditions.diabetes": known(true) }) } }, evidence)).toThrow();
});

describe("E-0.2 safety floor", () => {
  it("keeps the approved copy and pauses only explicit, current, first-person hard stops", async () => {
    const old =
      await import("../../../docs/implementation/evidence/native-questionnaire-pre-edit/clinic-api-safety.js");
    const current = await import("../src/safety.js");
    expect(current.escalationCopy).toEqual(old.escalationCopy);
    const expected: Record<string, string | undefined> = {
      "I cannot breathe now": "E01",
      "I cannot breathe years ago": undefined,
      "I may hurt myself tonight": "E04",
      "I do not have suicidal thoughts": undefined,
      "I have never had suicidal thoughts": undefined,
      "I'm not suicidal but I do want to kill myself": "E04",
      "My brother overdosed last year": undefined,
      "I'd kill myself if I gained it back": undefined,
      "Is it normal to want to hurt myself?": undefined,
      "I took an extra dose and cannot breathe": "E01",
      "I cannot keep fluids down": "E02",
      "I am purging": "E05",
      "I was purging in the past": undefined,
      "I am unsure whether I took a dose": undefined,
      "I binge on chips at night": undefined,
      "I hurt myself running last month": undefined,
      "I am snoring": undefined,
    };
    for (const [text, rule] of Object.entries(expected)) expect(current.escalation(text), text).toBe(rule);
    // A scoped hit is never silently dropped: it is reported for the model gate.
    expect(current.safetyFloorHits("I have never had suicidal thoughts")).toEqual([{ rule: "E04", scope: "negated", term: "suicidal" }]);
  });
});
