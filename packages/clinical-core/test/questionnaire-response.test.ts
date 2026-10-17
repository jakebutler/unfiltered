import { describe, expect, it } from "vitest";
import {
  buildNativeQuestionnaireCapture,
  toNativeQuestionnaireResponse,
  fromNativeQuestionnaireResponse,
  validateNativeQuestionnaireCapture,
  validateNativeQuestionnaireCaptureShape,
} from "../src/questionnaire-response.js";
import { scorePhq4 } from "../../clinic-content/src/mental-health.js";
import type { TopicResponse } from "../../clinic-content/src/types.js";
const validSourceIds = new Set(["s1", "s2", "s3"]);
const known = (
  value: string | number | boolean | { feet: number; inches: number },
  sourceIds = ["s1"],
) => ({ state: "known" as const, value, sourceIds });
const negative = { state: "negative" as const, sourceIds: ["s1"] };
const topic = (answers: TopicResponse["answers"]): TopicResponse => ({
  presented: true,
  answers,
});
async function qr(
  topics: Record<string, TopicResponse>,
  options: Record<string, unknown> = {},
) {
  const capture = await buildNativeQuestionnaireCapture({
    scenario: "first-intake",
    topics,
    validSourceIds,
    ...options,
  });
  const response = await toNativeQuestionnaireResponse({
    capture,
    validSourceIds,
    patient: "Patient/demo",
    authored: "2026-10-10T12:00:00.000Z",
    confirmed: true,
  });
  return { capture, response };
}
describe("typed native capture and response", () => {
  it("roundtrips repeated ownership, feet inches, true negatives and explicit missing states", async () => {
    const { capture, response } = await qr({
      Q04: topic({
        "height.value": known({ feet: 5, inches: 9 }),
        "height.unit": known("ft-in"),
        "lastMeasuredWeight.value": known(200),
        "lastMeasuredWeight.unit": known("lb"),
        "lastMeasuredWeight.measuredWhen": known("last month"),
        "lastMeasuredWeight.datePrecision": known("approximate"),
        "lastMeasuredWeight.representsCurrent": known(true),
      }),
      Q08: topic({
        medicines: {
          state: "known",
          sourceIds: ["s1"],
          complete: true,
          items: [
            {
              id: "m1",
              answers: { name: known("first"), strength: known("5 mg") },
            },
            {
              id: "m2",
              answers: {
                name: known("second"),
                strength: { state: "unknown", sourceIds: ["s2"] },
              },
            },
          ],
        },
      }),
      Q06: topic({
        "conditions.diabetes": negative,
        "conditions.prediabetes": negative,
      }),
      Q16: topic({
        MH01: { state: "skipped", sourceIds: ["s1"] },
        MH02: { state: "declined", sourceIds: ["s2"] },
        MH03: { state: "uncertain", sourceIds: ["s1"] },
        MH04: { state: "conflicting", sourceIds: ["s3"] },
      }),
    });
    expect(response.status).toBe("stopped");
    expect(response.questionnaire).toContain("|CC-0.2.phq4.native-5");
    expect(
      await fromNativeQuestionnaireResponse(response, validSourceIds),
    ).toEqual(capture);
    expect(JSON.stringify(response)).toContain("valueInteger");
    expect(JSON.stringify(response)).toContain('"id":"m2"');
    expect(JSON.stringify(response)).toContain('valueBoolean":false');
  });
  it("reuses detailed surgery effect and reported sleep apnea with origin ownership, while preserving explicit targets and recomputing corrections", async () => {
    const { deriveNativeRoutingContext, nativeTopics, nextNativeGuidedField } =
      await import("../../clinic-content/src/index.js");
    const { projectNativeQuestionnaireState } =
      await import("../src/questionnaire-response.js");
    const original = {
      Q15: topic({
        schedule: known("reported schedule"),
        quality: known("reported quality"),
      }),
      Q06: topic({ "conditions.sleepApnea": known(true) }),
      Q07: topic({
        events: {
          state: "known" as const,
          complete: true,
          sourceIds: ["s2"],
          items: [
            {
              id: "surgery-1",
              answers: {
                event: known("reported surgery", ["s2"]),
                effects: known(
                  "Since surgery I still cannot tolerate eating solid food now.",
                  ["s2"],
                ),
              },
            },
          ],
        },
      }),
    };
    const context = deriveNativeRoutingContext(original, { validSourceIds });
    const live = projectNativeQuestionnaireState(
      { topics: original, context },
      validSourceIds,
    );
    expect(live.topics.GI.answers.effect).toEqual({
      ...original.Q07.answers.events.items![0].answers.effects,
      reusedFrom: { topicId: "Q07", path: "events[surgery-1].effects" },
    });
    expect(live.topics.Q15.answers.condition).toEqual({
      ...known("sleep apnea"),
      reusedFrom: { topicId: "Q06", path: "conditions.sleepApnea" },
    });
    expect(
      nextNativeGuidedField(
        nativeTopics().find((t) => t.id === "GI")!,
        live.topics.GI,
        { validSourceIds },
        { topics: live.topics, context },
      ),
    ).toBeUndefined();
    expect(
      nextNativeGuidedField(
        nativeTopics().find((t) => t.id === "Q15")!,
        live.topics.Q15,
        { validSourceIds },
        { topics: live.topics, context },
      )?.path,
    ).toBe("treatment");
    const mapped = await qr(live.topics, { context });
    expect(
      await fromNativeQuestionnaireResponse(mapped.response, validSourceIds),
    ).toEqual(mapped.capture);
    expect(JSON.stringify(mapped.response)).toContain(
      "events[surgery-1].effects",
    );
    const explicit = projectNativeQuestionnaireState(
      {
        topics: {
          ...original,
          GI: topic({ effect: { state: "unknown", sourceIds: ["s3"] } }),
          Q15: topic({
            condition: known("explicit separate sleep concern", ["s3"]),
          }),
        },
        context,
      },
      validSourceIds,
    );
    expect(explicit.topics.GI.answers.effect?.state).toBe("unknown");
    expect(explicit.topics.Q15.answers.condition).toEqual(
      known("explicit separate sleep concern", ["s3"]),
    );
    const withTreatment = {
      ...live.topics,
      Q15: topic({
        ...live.topics.Q15.answers,
        treatment: known("reported treatment", ["s2"]),
      }),
    };
    const forgedReuse = structuredClone(mapped.capture);
    forgedReuse.topics.GI = topic({
      effect: {
        ...known("forged detail", ["s2"]),
        reusedFrom: { topicId: "Q07", path: "events[surgery-1].effects" },
      },
    });
    expect(() =>
      validateNativeQuestionnaireCaptureShape(forgedReuse, validSourceIds),
    ).toThrow("questionnaire-reuse-source-mismatch");
    const corrected = projectNativeQuestionnaireState(
      {
        topics: {
          ...withTreatment,
          Q06: topic({
            "conditions.sleepApnea": { state: "negative", sourceIds: ["s3"] },
          }),
          Q07: topic({ events: { state: "negative", sourceIds: ["s3"] } }),
        },
      },
      validSourceIds,
    );
    expect(corrected.topics.GI.answers.effect).toBeUndefined();
    expect(corrected.topics.Q15.answers.condition).toBeUndefined();
    expect(corrected.topics.Q15.answers.treatment).toBeUndefined();
    expect(
      corrected.inactiveHistory
        .filter(
          (entry) => entry.path === "effect" || entry.path === "condition",
        )
        .map((entry) => entry.answer),
    ).toContainEqual(live.topics.Q15.answers.condition);
    for (const value of [
      "It affects eating now",
      "yes",
      "It may affect eating solid food now",
    ]) {
      const insufficient = {
        Q07: topic({
          events: {
            state: "known" as const,
            complete: true,
            sourceIds: ["s2"],
            items: [
              { id: "surgery-1", answers: { effects: known(value, ["s2"]) } },
            ],
          },
        }),
      };
      const candidate = projectNativeQuestionnaireState(
        {
          topics: insufficient,
          context: deriveNativeRoutingContext(insufficient, { validSourceIds }),
        },
        validSourceIds,
      );
      expect(candidate.topics.GI?.answers.effect).toBeUndefined();
    }
    const unknownOrigin = {
      Q06: topic({
        "conditions.sleepApnea": {
          state: "uncertain" as const,
          sourceIds: ["s1"],
        },
      }),
    };
    expect(
      projectNativeQuestionnaireState({ topics: unknownOrigin }, validSourceIds)
        .topics.Q15,
    ).toBeUndefined();
  });
  it("requires trusted repeated ancestors before a confirmed child enables digestive reuse and leaves one-pass state consistent", async () => {
    const { deriveNativeRoutingContext } =
      await import("../../clinic-content/src/index.js");
    const { projectNativeQuestionnaireState } =
      await import("../src/questionnaire-response.js");
    const original = {
      Q07: topic({
        events: {
          state: "known" as const,
          complete: true,
          sourceIds: ["s1"],
          items: [
            {
              id: "surgery-1",
              answers: {
                effects: known(
                  "Since surgery I still cannot tolerate eating solid food now.",
                  ["s2"],
                ),
              },
            },
          ],
        },
      }),
    };
    const context = deriveNativeRoutingContext(original, { validSourceIds });
    const trusted = projectNativeQuestionnaireState(
      { topics: original, context },
      validSourceIds,
    );
    expect(trusted.topics.GI.answers.effect?.state).toBe("known");
    expect(
      trusted.routingDecisions.find(
        (decision) => decision.ruleId === "branch.digestive",
      )?.outcome,
    ).toBe("applicable");
    const unreviewed = projectNativeQuestionnaireState(
      { topics: trusted.topics, context, unreviewedSourceIds: ["s1"] },
      validSourceIds,
    );
    expect(unreviewed.topics.Q07.answers.events).toBeUndefined();
    expect(unreviewed.topics.GI?.answers.effect).toBeUndefined();
    expect(unreviewed.topics.GI?.applicability).toBe("unknown");
    expect(
      unreviewed.routingDecisions.find(
        (decision) => decision.ruleId === "branch.digestive",
      )?.outcome,
    ).toBe("unknown");
    const repeat = projectNativeQuestionnaireState(
      {
        topics: unreviewed.topics,
        inactiveHistory: unreviewed.inactiveHistory,
        unreviewedSourceIds: ["s1"],
      },
      validSourceIds,
    );
    expect(repeat).toEqual(unreviewed);
    const { capture, response } = await qr(original, {
      context,
      unreviewedSourceIds: ["s1"],
    });
    expect(capture.topics.GI?.answers.effect).toBeUndefined();
    expect(
      await fromNativeQuestionnaireResponse(response, validSourceIds),
    ).toEqual(capture);
  });
  it("roundtrips independently owned medication clarification source facts and accepts the legacy single fact", async () => {
    const { deriveNativeRoutingContext } =
      await import("../../clinic-content/src/index.js");
    const topics = {
      Q08: topic({
        medicines: {
          state: "known",
          complete: true,
          sourceIds: ["s1", "s2"],
          items: ["m1", "m2"].map((id, index) => ({
            id,
            answers: {
              name: known("reported medicine", [index ? "s2" : "s1"]),
              actualUse: known("I am unsure whether I took the dose", [
                index ? "s2" : "s1",
              ]),
              administrationClarification: {
                state: "unknown" as const,
                sourceIds: [index ? "s2" : "s1"],
              },
            },
          })),
        },
      }),
    };
    const context = deriveNativeRoutingContext(topics, { validSourceIds });
    const { capture, response } = await qr(topics, { context });
    expect(
      await fromNativeQuestionnaireResponse(response, validSourceIds),
    ).toEqual(capture);
    expect(
      capture.routingDecisions
        .filter(
          (decision) =>
            decision.ruleId ===
            "slot.Q08.medicines[*].administrationClarification",
        )
        .map((decision) => [
          decision.instanceId,
          decision.outcome,
          decision.sourceIds,
        ]),
    ).toEqual([
      ["m1", "applicable", ["s1"]],
      ["m2", "applicable", ["s2"]],
    ]);
    const legacy = await qr(topics, {
      context: {
        administrationUnclear: Array.isArray(context.administrationUnclear)
          ? context.administrationUnclear[0]
          : context.administrationUnclear,
      },
    });
    expect(
      await fromNativeQuestionnaireResponse(legacy.response, validSourceIds),
    ).toEqual(legacy.capture);
  });
  it("deactivates corrected dependent values without losing raw history and never revives them", async () => {
    const { capture, response } = await qr({
      Q12: topic({
        concern: negative,
        timing: known("yesterday"),
        effect: known("tired"),
      }),
    });
    expect(capture.topics.Q12.answers.timing).toBeUndefined();
    expect(capture.inactiveHistory?.map((h) => h.path)).toContain("timing");
    expect(
      await fromNativeQuestionnaireResponse(response, validSourceIds),
    ).toEqual(capture);
    const renewed = await buildNativeQuestionnaireCapture({
      ...capture,
      topics: { Q12: topic({ concern: known("worry") }) },
      validSourceIds,
    });
    expect(renewed.topics.Q12.answers.timing).toBeUndefined();
    expect(renewed.inactiveHistory).toEqual(capture.inactiveHistory);
  });
  it("rejects changed binding, forged routing, dangling slot, duplicate repeat and wrong typed answer", async () => {
    const { capture, response } = await qr({
      Q01: topic({ reason: known("visit") }),
    });
    await expect(
      validateNativeQuestionnaireCapture(
        {
          ...capture,
          definition: { ...capture.definition, digest: "0".repeat(64) },
        },
        validSourceIds,
      ),
    ).rejects.toThrow("questionnaire-definition-mismatch");
    await expect(
      validateNativeQuestionnaireCapture(
        { ...capture, routingDecisions: [] },
        validSourceIds,
      ),
    ).rejects.toThrow("questionnaire-routing-mismatch");
    await expect(qr({ Q01: topic({ invented: known("x") }) })).rejects.toThrow(
      "unknown-questionnaire-slot",
    );
    await expect(
      qr({
        Q08: topic({
          medicines: {
            state: "known",
            sourceIds: ["s1"],
            complete: false,
            items: [
              { id: "same", answers: {} },
              { id: "same", answers: {} },
            ],
          },
        }),
      }),
    ).rejects.toThrow("duplicate-questionnaire-instance");
    const altered = structuredClone(response);
    const value = altered.item
      .find((i) => i.linkId === "Q01")!
      .item!.find((i) => i.linkId === "Q01.reason")!;
    value.answer = [{ valueDecimal: 4 }];
    await expect(
      fromNativeQuestionnaireResponse(altered, validSourceIds),
    ).rejects.toThrow("response-value-type-mismatch");
  });
  it("keeps unreviewed recognition separate and suppresses PHQ scores for any incomplete choice", async () => {
    const { capture } = await qr(
      {
        Q16: topic({
          MH01: known(2, ["s3"]),
          MH02: known(1),
          MH03: known(0),
          MH04: known(0),
        }),
      },
      { unreviewedSourceIds: ["s3"] },
    );
    expect(capture.topics.Q16.answers.MH01).toBeUndefined();
    expect(
      capture.inactiveHistory?.some(
        (h) => h.reason === "unreviewed-recognition",
      ),
    ).toBe(true);
    expect(
      scorePhq4(capture.topics.Q16.answers, {
        validSourceIds,
        confirmedItemIds: new Set(["MH01", "MH02", "MH03", "MH04"]),
        completedAt: "2026-10-10T12:00:00.000Z",
      }).scores,
    ).toBeNull();
    expect(
      scorePhq4(
        { MH01: known(2), MH02: known(1), MH03: known(0), MH04: known(0) },
        {
          validSourceIds,
          confirmedItemIds: new Set(["MH01", "MH02", "MH03", "MH04"]),
          completedAt: "2026-10-10T12:00:00.000Z",
        },
      ).scores,
    ).toEqual({ gad2: 3, phq2: 0, phq4: 3 });
  });
  it("draft and confirmed partial remain honest with required height and date missing", async () => {
    const { capture } = await qr({
      Q04: topic({ "lastMeasuredWeight.value": known(80) }),
    });
    const draft = await toNativeQuestionnaireResponse({
      capture,
      validSourceIds,
      patient: "Patient/demo",
      authored: "2026-10-10T12:00:00.000Z",
      confirmed: false,
    });
    expect(draft.status).toBe("in-progress");
    const altered = { ...draft, status: "completed" as const };
    await expect(
      fromNativeQuestionnaireResponse(altered, validSourceIds),
    ).rejects.toThrow("response-completeness-mismatch");
  });
});

describe("compiler and real structured engine parity", () => {
  it("keeps native enabled values equal to current authored values across interacting repeated corrections", async () => {
    const {
      getNativeQuestionnaireDefinition,
      nativeCompiledActiveValues,
      createClinicContent,
      nativeTopics,
    } = await import("../../clinic-content/src/index.js");
    const { applyGuidedAnswer, addCollectionItem, finishCollection } =
      await import("../../clinic-content/src/guided.js");
    const definition = await getNativeQuestionnaireDefinition(),
      eating = nativeTopics().find((t) => t.id === "Q11")!;
    let response = topic({
      day: known("yesterday"),
      otherIntake: negative,
      typicality: known("usual"),
    });
    const evidence = { validSourceIds };
    for (const id of ["breakfast", "dinner"]) {
      response = addCollectionItem(
        eating,
        response,
        { path: "occasions", itemId: id, sourceIds: ["s1"] },
        evidence,
      );
      for (const [field, answer] of Object.entries({
        time: known(id === "breakfast" ? "8am" : "7pm"),
        foods: known("toast"),
        drinks: negative,
        foodAmounts: known("two slices"),
      }))
        response = applyGuidedAnswer(
          eating,
          response,
          { path: `occasions[${id}].${field}`, answer },
          evidence,
        );
    }
    response = finishCollection(
      eating,
      response,
      { path: "occasions", sourceIds: ["s1"] },
      evidence,
    );
    const first = await qr({ Q11: response });
    const firstValues = nativeCompiledActiveValues(
      definition,
      first.response.item,
    );
    expect(firstValues).toContain("Q11.occasions[breakfast].foodAmounts");
    expect(firstValues).toContain("Q11.occasions[dinner].foodAmounts");
    expect(firstValues.some((path) => path.endsWith(".drinkAmounts"))).toBe(
      false,
    );
    response = applyGuidedAnswer(
      eating,
      response,
      { path: "occasions[breakfast].foods", answer: negative },
      evidence,
    );
    const corrected = await qr({ Q11: response });
    const values = nativeCompiledActiveValues(
      definition,
      corrected.response.item,
    );
    expect(values).not.toContain("Q11.occasions[breakfast].foodAmounts");
    expect(values).toContain("Q11.occasions[dinner].foodAmounts");
    expect(
      corrected.capture.inactiveHistory?.some(
        (h) => h.path === "occasions[breakfast].foodAmounts",
      ),
    ).toBe(true);
    expect(
      await fromNativeQuestionnaireResponse(corrected.response, validSourceIds),
    ).toEqual(corrected.capture);
    expect(
      createClinicContent().scenarios["first-intake"].reusableTopicIds,
    ).toHaveLength(22);
  });
  it("produces completed only for actual applicable required minimums and preserves all seven workflow captures", async () => {
    // Time, frequency and relation answers must be specific to count as complete (SP-0.1).
    const specific: Record<string, string> = { onset: "Since March 2026", timing: "In 2019", measuredWhen: "In March 2026", period: "In 2020", when: "In 2018", actualUse: "Twice a day", relationship: "My mother", frequency: "Three times a week", frequencyAmount: "Two drinks a week" };
    const { nativeTopics, createClinicContent, nativeScenarioTopics } =
      await import("../../clinic-content/src/index.js");
    const { evaluateTopic } =
      await import("../../clinic-content/src/readiness.js");
    const makeAnswers = (
      slots: readonly import("../../clinic-content/src/types.js").SlotDefinition[],
    ): TopicResponse["answers"] =>
      Object.fromEntries(
        slots
          .filter((slot) => !slot.optional && !slot.when)
          .map((slot) => [
            slot.id,
            slot.acceptsNegative
              ? negative
              : slot.kind === "collection"
                ? {
                    state: "known",
                    complete: true,
                    sourceIds: ["s1"],
                    items: [
                      { id: "one", answers: makeAnswers(slot.fields ?? []) },
                    ],
                  }
                : known(
                    slot.kind === "height-value" ||
                      slot.kind === "positive-number"
                      ? 80
                      : slot.kind === "presence"
                        ? true
                        : slot.kind === "choice"
                          ? slot.choices![0]
                          : specific[slot.id.split(".").at(-1)!] ?? "reported detail",
                  ),
          ]),
      );
    const topics = Object.fromEntries(
      nativeTopics()
        .filter((topic) => topic.id.startsWith("Q"))
        .map((definition) => [
          definition.id,
          topic(makeAnswers(definition.slots)),
        ]),
    );
    topics.Q04 = topic({
      ...topics.Q04.answers,
      "height.unit": known("cm"),
      "lastMeasuredWeight.representsCurrent": known(true),
    });
    topics.Q18 = {
      presented: true,
      answers: {},
      applicability: "not-applicable",
      applicabilitySourceIds: ["s1"],
    };
    const complete = await qr(topics);
    expect(complete.response.status).toBe("completed");
    expect(
      await fromNativeQuestionnaireResponse(complete.response, validSourceIds),
    ).toEqual(complete.capture);
    const withoutReproductive = { ...topics };
    delete withoutReproductive.Q18;
    const noTrigger = await qr(withoutReproductive);
    expect(noTrigger.response.status).toBe("completed");
    expect(
      noTrigger.capture.routingDecisions.find(
        (rule) => rule.ruleId === "branch.reproductive",
      )?.outcome,
    ).toBe("unknown");
    expect(
      await fromNativeQuestionnaireResponse(noTrigger.response, validSourceIds),
    ).toEqual(noTrigger.capture);
    const explicitlyRelevant = await qr(withoutReproductive, {
      relevantTopicIds: ["Q18"],
    });
    expect(explicitlyRelevant.response.status).toBe("stopped");
    const triggered = await qr(withoutReproductive, {
      topics: {
        ...withoutReproductive,
        Q08: topic({
          medicines: {
            state: "known",
            complete: true,
            sourceIds: ["s1"],
            items: [
              {
                id: "purpose",
                answers: {
                  name: known("reported medicine"),
                  reason: known("weight management"),
                },
              },
            ],
          },
        }),
      },
      context: {
        reproductive: {
          topicId: "Q08",
          path: "medicines[purpose].reason",
          sourceIds: ["s1"],
        },
      },
    });
    expect(
      triggered.capture.routingDecisions.find(
        (rule) => rule.ruleId === "branch.reproductive",
      )?.outcome,
    ).toBe("applicable");
    expect(triggered.response.status).toBe("stopped");
    const missing = await qr({
      ...topics,
      Q04: topic({
        ...topics.Q04.answers,
        "height.value": { state: "unknown", sourceIds: ["s1"] },
      }),
    });
    expect(missing.response.status).toBe("stopped");
    for (const scenario of Object.keys(
      createClinicContent().scenarios,
    ) as Array<keyof ReturnType<typeof createClinicContent>["scenarios"]>) {
      const definitions = nativeScenarioTopics(createClinicContent(), scenario);
      const snapshot =
        scenario === "first-intake"
          ? topics
          : Object.fromEntries(
              definitions.map((definition) => [
                definition.id,
                topic(makeAnswers(definition.slots)),
              ]),
            );
      // Strict dates are actual typed calendar values, never recalled text normalization.
      if (snapshot.W05)
        snapshot.W05 = topic({
          ...snapshot.W05.answers,
          serviceDate: known("2026-10-09"),
        });
      if (snapshot.W06)
        snapshot.W06 = topic({
          ...snapshot.W06.answers,
          requestedDate: known("2026-10-11"),
        });
      const capture = await buildNativeQuestionnaireCapture({
        scenario,
        topics: snapshot,
        validSourceIds,
      });
      const response = await toNativeQuestionnaireResponse({
        capture,
        validSourceIds,
        patient: "Patient/demo",
        authored: "2026-10-10T12:00:00.000Z",
        confirmed: true,
      });
      expect(response.status, scenario).toBe("completed");
      expect(
        await fromNativeQuestionnaireResponse(response, validSourceIds),
      ).toEqual(capture);
      for (const definition of definitions)
        if (definition.presentation !== "O")
          expect(
            evaluateTopic(definition, capture.topics[definition.id], {
              validSourceIds,
            }).sufficient,
            definition.id,
          ).toBe(true);
    }
  });
});

describe("branch reactivation authority", () => {
  it("requires a current source for explicit reuse of previously disabled detail", async () => {
    const disabled = await qr({
      Q12: topic({ concern: negative, timing: known("yesterday") }),
    });
    const reopened = {
      Q12: topic({
        concern: known("current concern", ["s2"]),
        timing: known("yesterday"),
      }),
    };
    await expect(
      buildNativeQuestionnaireCapture({
        scenario: "first-intake",
        topics: reopened,
        inactiveHistory: disabled.capture.inactiveHistory,
        validSourceIds,
      }),
    ).rejects.toThrow("questionnaire-history-reuse-requires-confirmation");
    const confirmed = await buildNativeQuestionnaireCapture({
      scenario: "first-intake",
      topics: {
        Q12: topic({
          ...reopened.Q12.answers,
          timing: known("yesterday", ["s2"]),
        }),
      },
      inactiveHistory: disabled.capture.inactiveHistory,
      validSourceIds,
    });
    expect(confirmed.topics.Q12.answers.timing?.sourceIds).toEqual(["s2"]);
  });
  it("honors collection ownership for optional preparation and excludes unknown activation", async () => {
    const response = topic({
      day: known("yesterday"),
      occasions: {
        state: "known",
        complete: true,
        sourceIds: ["s1"],
        items: [
          {
            id: "a",
            answers: { foods: known("toast"), preparation: known("toasted") },
          },
          {
            id: "b",
            answers: { foods: known("toast"), preparation: known("fried") },
          },
        ],
      },
    });
    const captured = await qr(
      { Q11: response },
      {
        context: {
          preparation: [
            { topicId: "Q11", path: "occasions[a].foods", sourceIds: ["s1"] },
          ],
        },
      },
    );
    const collection = captured.capture.topics.Q11.answers.occasions;
    expect(
      collection?.state === "known" &&
        collection.items?.[0].answers.preparation,
    ).toEqual(known("toasted"));
    expect(
      collection?.state === "known" &&
        collection.items?.[1].answers.preparation,
    ).toBeUndefined();
    expect(
      captured.capture.inactiveHistory?.some(
        (entry) => entry.path === "occasions[b].preparation",
      ),
    ).toBe(true);
    expect(
      await fromNativeQuestionnaireResponse(captured.response, validSourceIds),
    ).toEqual(captured.capture);
  });
});

describe("immutable persistence ordering", () => {
  it("produces identical native trees before and after canonical persistence sorts topic keys", async () => {
    const { nativeCanonicalJson } =
      await import("../../clinic-content/src/native-questionnaire.js");
    const first = await qr({
      Q16: topic({ MH01: known(0) }),
      Q04: topic({ "height.value": known(170), "height.unit": known("cm") }),
      Q02: topic({ concern: negative }),
    });
    const persisted = JSON.parse(nativeCanonicalJson(first.capture));
    const second = await toNativeQuestionnaireResponse({
      capture: persisted,
      validSourceIds,
      patient: "Patient/demo",
      authored: "2026-10-10T12:00:00.000Z",
      confirmed: true,
    });
    expect(second).toEqual(first.response);
    expect(
      await fromNativeQuestionnaireResponse(second, validSourceIds),
    ).toEqual(first.capture);
  });
});

describe("immediate live correction projection", () => {
  it("cannot revive a hidden dependent value before preview on positive-negative-positive turns", async () => {
    const { projectNativeQuestionnaireState } =
      await import("../src/questionnaire-response.js");
    const first = projectNativeQuestionnaireState(
      {
        topics: {
          Q12: topic({ concern: known("concern"), timing: known("yesterday") }),
        },
      },
      validSourceIds,
    );
    const second = projectNativeQuestionnaireState(
      {
        topics: {
          Q12: topic({ ...first.topics.Q12.answers, concern: negative }),
        },
        inactiveHistory: first.inactiveHistory,
      },
      validSourceIds,
    );
    expect(second.topics.Q12.answers.timing).toBeUndefined();
    const third = projectNativeQuestionnaireState(
      {
        topics: {
          Q12: topic({
            ...second.topics.Q12.answers,
            concern: known("new concern", ["s2"]),
          }),
        },
        inactiveHistory: second.inactiveHistory,
      },
      validSourceIds,
    );
    expect(third.topics.Q12.answers.timing).toBeUndefined();
    expect(third.inactiveHistory.some((h) => h.path === "timing")).toBe(true);
  });
});

describe("exhaustive approved target mapping", () => {
  it("roundtrips every native target and preserves disabled originals through history", async () => {
    const { nativeTopics, nativeSlotEntries, nativeResolveAlias } =
      await import("../../clinic-content/src/native-questionnaire.js");
    const { readFileSync } = await import("node:fs");
    const inventory = JSON.parse(
      readFileSync(
        "docs/implementation/evidence/MEDPLUM-DYNAMIC-QUESTIONNAIRE-INVENTORY.json",
        "utf8",
      ),
    ) as { slots: Array<{ topicId: string; slotPath: string }> };
    const definitions = nativeTopics(),
      paths = new Set(
        nativeSlotEntries(definitions).map(
          (entry) => `${entry.topicId}.${entry.path}`,
        ),
      );
    for (const original of inventory.slots) {
      const resolved = nativeResolveAlias(
        original.topicId,
        original.slotPath,
        "owner",
      );
      expect(
        paths.has(
          `${resolved.topicId}.${resolved.path.replace("[owner]", "[*]")}`,
        ),
        `${original.topicId}.${original.slotPath}`,
      ).toBe(true);
    }
    const make = (
      slots: readonly import("../../clinic-content/src/types.js").SlotDefinition[],
    ): TopicResponse["answers"] =>
      Object.fromEntries(
        slots.map((slot) => [
          slot.id,
          slot.kind === "collection"
            ? {
                state: "known",
                complete: true,
                sourceIds: ["s1"],
                items: ["one", "two"].map((id) => ({
                  id,
                  answers: make(slot.fields ?? []),
                })),
              }
            : known(
                slot.kind === "height-value" || slot.kind === "positive-number"
                  ? 100
                  : slot.kind === "presence"
                    ? true
                    : slot.kind === "choice"
                      ? slot.choices![0]
                      : slot.id === "statedAt" || slot.id.endsWith(".statedAt")
                        ? "2026-10-10T12:00:00.000Z"
                        : ["serviceDate", "requestedDate"].includes(slot.id)
                          ? "2026-10-09"
                          : "reported detail",
              ),
        ]),
      );
    const topics = Object.fromEntries(
      definitions.map((definition) => [
        definition.id,
        {
          ...topic(make(definition.slots)),
          ...(definition.presentation === "C"
            ? {
                applicability: "applicable" as const,
                applicabilitySourceIds: ["s1"],
              }
            : {}),
        },
      ]),
    );
    topics.Q04 = topic({ ...topics.Q04.answers, "height.unit": known("cm") });
    const fixture = await qr(topics);
    expect(
      await fromNativeQuestionnaireResponse(fixture.response, validSourceIds),
    ).toEqual(fixture.capture);
    expect(paths.size).toBeGreaterThanOrEqual(181);
    expect(fixture.capture.inactiveHistory!.length).toBeGreaterThan(0);
  });
  it("serializes all exact PHQ choices and never scores any missing, skipped, unknown, declined, conflicting or unreviewed item", async () => {
    for (const id of ["MH01", "MH02", "MH03", "MH04"])
      for (const value of [0, 1, 2, 3]) {
        const fixture = await qr({ Q16: topic({ [id]: known(value) }) });
        const group = fixture.response.item.find(
          (item) => item.linkId === "Q16",
        )!;
        const field = group.item!.find((item) => item.linkId === `Q16.${id}`)!;
        expect(field.answer![0].valueCoding).toEqual({
          system: "urn:corvo:phq4-response",
          code: String(value),
          display: [
            "Not at all",
            "Several days",
            "More than half the days",
            "Nearly every day",
          ][value],
        });
      }
    for (const id of ["MH01", "MH02", "MH03", "MH04"])
      for (const state of [
        "unknown",
        "declined",
        "skipped",
        "uncertain",
        "conflicting",
        "not-asked",
      ] as const) {
        const answers: Record<
          string,
          import("../../clinic-content/src/types.js").SlotAnswer
        > = { MH01: known(0), MH02: known(0), MH03: known(0), MH04: known(0) };
        answers[id] =
          state === "not-asked" ? { state } : { state, sourceIds: ["s1"] };
        expect(
          scorePhq4(answers, {
            validSourceIds,
            confirmedItemIds: new Set(["MH01", "MH02", "MH03", "MH04"]),
            completedAt: "2026-10-10T12:00:00.000Z",
          }).scores,
        ).toBeNull();
      }
  });
});
