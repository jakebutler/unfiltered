import { describe, expect, it } from "vitest";
import {
  deserializeSlots,
  serializeSlots,
} from "../src/questionnaire-response.js";
import { isPhq4ItemSlot, PHQ4_ITEM_IDS } from "../../clinic-content/src/mental-health.js";
import { mentalHealthSlots } from "../../clinic-content/src/slots.js";
import { NATIVE_EXTENSION } from "../../clinic-content/src/native-questionnaire.js";
import type {
  SlotAnswers,
  SlotDefinition,
} from "../../clinic-content/src/types.js";

const PHQ_LABELS = [
  "Not at all",
  "Several days",
  "More than half the days",
  "Nearly every day",
];

const syntheticInteger: SlotDefinition = {
  id: "severity",
  label: "Synthetic severity",
  kind: "choice",
  promptIds: ["SYN-1"],
  choices: [0, 1, 2, 3],
};
const syntheticDecimal: SlotDefinition = {
  id: "weight.scale",
  label: "Synthetic decimal scale",
  kind: "choice",
  promptIds: ["SYN-2"],
  choices: [0.5, 1.5],
};
const syntheticMixedNumeric: SlotDefinition = {
  id: "mixed.scale",
  label: "Synthetic mixed numeric scale",
  kind: "choice",
  promptIds: ["SYN-3"],
  choices: [0, 0.5, 1],
};

const known = (value: number) => ({
  state: "known" as const,
  value,
  sourceIds: ["s1"],
});

function roundTrip(
  topicId: string,
  slots: readonly SlotDefinition[],
  answers: SlotAnswers,
) {
  const items = serializeSlots(topicId, slots, answers, []);
  const decoded = deserializeSlots(topicId, slots, items);
  return { items, decoded };
}

describe("PHQ-4 response coding is scoped to the locked PHQ-4 block", () => {
  it("identifies exactly MH01-MH04 under Q16 by explicit id", () => {
    expect([...PHQ4_ITEM_IDS]).toEqual(["MH01", "MH02", "MH03", "MH04"]);
    for (const id of PHQ4_ITEM_IDS) expect(isPhq4ItemSlot("Q16", id)).toBe(true);
    expect(isPhq4ItemSlot("Q15", "MH01")).toBe(false);
    expect(isPhq4ItemSlot("Q16", "severity")).toBe(false);
  });

  it("serialises a non-PHQ numeric choice slot as a plain valueInteger, without PHQ system or labels", () => {
    const { items, decoded } = roundTrip(
      "X99",
      [syntheticInteger],
      { severity: known(2) },
    );
    const answer = items.find((i) => i.linkId === "X99.severity")!.answer!;
    expect(answer).toEqual([{ valueInteger: 2 }]);
    expect(JSON.stringify(items)).not.toContain("urn:corvo:phq4-response");
    expect(JSON.stringify(items)).not.toContain("More than half the days");
    expect(decoded).toEqual({ severity: known(2) });
  });

  it("serialises a non-integer numeric choice slot as valueDecimal and round-trips it", () => {
    const { items, decoded } = roundTrip(
      "X99",
      [syntheticDecimal],
      { "weight.scale": known(1.5) },
    );
    expect(items.find((i) => i.linkId === "X99.weight.scale")!.answer).toEqual([
      { valueDecimal: 1.5 },
    ]);
    expect(decoded).toEqual({ "weight.scale": known(1.5) });
  });

  it("rejects a PHQ coding on a non-PHQ numeric choice slot", () => {
    const items = [
      {
        linkId: "X99.severity.__state",
        answer: [{ valueString: "known" }],
        extension: [
          {
            url: `${NATIVE_EXTENSION}slot-present`,
            valueBoolean: true,
          },
        ],
      },
      {
        linkId: "X99.severity",
        answer: [
          {
            valueCoding: {
              system: "urn:corvo:phq4-response",
              code: "2",
              display: PHQ_LABELS[2],
            },
          },
        ],
      },
    ];
    expect(() => deserializeSlots("X99", [syntheticInteger], items)).toThrow(
      "invalid-response-coding",
    );
  });

  it("keeps the exact PHQ-4 coding for MH01-MH04 under Q16 and round-trips it", () => {
    const phqSlots = mentalHealthSlots.phq4;
    expect(phqSlots.map((s) => s.id)).toEqual([...PHQ4_ITEM_IDS]);
    for (const slot of phqSlots)
      for (const value of [0, 1, 2, 3]) {
        const { items, decoded } = roundTrip("Q16", [slot], {
          [slot.id]: known(value),
        });
        expect(items.find((i) => i.linkId === `Q16.${slot.id}`)!.answer).toEqual([
          {
            valueCoding: {
              system: "urn:corvo:phq4-response",
              code: String(value),
              display: PHQ_LABELS[value],
            },
          },
        ]);
        expect(decoded).toEqual({ [slot.id]: known(value) });
      }
  });

  it("serialises the specified ZZ.score integer choice without PHQ coding", () => {
    const slot = { ...syntheticInteger, id: "score", choices: [0, 1, 2] };
    const { items, decoded } = roundTrip("ZZ", [slot], { score: known(1) });
    expect(items.find((item) => item.linkId === "ZZ.score")!.answer).toEqual([
      { valueInteger: 1 },
    ]);
    expect(JSON.stringify(items)).not.toContain("urn:corvo:phq4-response");
    expect(decoded).toEqual({ score: known(1) });
  });

  it.each([0, 0.5, 1])(
    "uses valueDecimal for selection %s when the numeric option set includes fractions",
    (value) => {
      const { items, decoded } = roundTrip("X99", [syntheticMixedNumeric], {
        [syntheticMixedNumeric.id]: known(value),
      });
      expect(items.find((item) => item.linkId === "X99.mixed.scale")!.answer).toEqual([
        { valueDecimal: value },
      ]);
      expect(decoded).toEqual({ [syntheticMixedNumeric.id]: known(value) });
    },
  );

  it.each([
    { topicId: "Q15", slotId: "MH01" },
    { topicId: "Q16", slotId: "severity" },
  ])(
    "requires both topic and slot identity for PHQ coding ($topicId.$slotId)",
    ({ topicId, slotId }) => {
      const slot = { ...syntheticInteger, id: slotId };
      const { items, decoded } = roundTrip(topicId, [slot], {
        [slotId]: known(2),
      });
      const field = items.find((item) => item.linkId === `${topicId}.${slotId}`)!;
      expect(field.answer).toEqual([{ valueInteger: 2 }]);
      expect(decoded).toEqual({ [slotId]: known(2) });
      field.answer = [{
        valueCoding: {
          system: "urn:corvo:phq4-response",
          code: "2",
          display: PHQ_LABELS[2],
        },
      }];
      expect(() => deserializeSlots(topicId, [slot], items)).toThrow(
        "invalid-response-coding",
      );
    },
  );

  it.each([
    { slot: syntheticInteger, answer: { valueDecimal: 2 }, selected: 2 },
    { slot: syntheticMixedNumeric, answer: { valueInteger: 1 }, selected: 1 },
  ])(
    "rejects the wrong numeric representation for $slot.id",
    ({ slot, answer, selected }) => {
      const items = serializeSlots("X99", [slot], { [slot.id]: known(selected) }, []);
      items.find((item) => item.linkId === `X99.${slot.id}`)!.answer = [answer];
      expect(() => deserializeSlots("X99", [slot], items)).toThrow(
        "response-value-type-mismatch",
      );
    },
  );

  it.each([
    { slot: syntheticInteger, answer: { valueInteger: 4 }, selected: 2 },
    { slot: syntheticDecimal, answer: { valueDecimal: 2 }, selected: 1.5 },
  ])(
    "rejects an out-of-option numeric value for $slot.id",
    ({ slot, answer, selected }) => {
      const items = serializeSlots("X99", [slot], { [slot.id]: known(selected) }, []);
      items.find((item) => item.linkId === `X99.${slot.id}`)!.answer = [answer];
      expect(() => deserializeSlots("X99", [slot], items)).toThrow(
        "invalid-response-choice",
      );
    },
  );

  it.each([
    { answer: { valueInteger: 2 }, error: "response-value-type-mismatch" },
    { answer: { valueDecimal: 2 }, error: "response-value-type-mismatch" },
    {
      answer: { valueCoding: {
        system: "urn:synthetic:scale", code: "2", display: PHQ_LABELS[2],
      } },
      error: "invalid-response-coding",
    },
    {
      answer: { valueCoding: {
        system: "urn:corvo:phq4-response", code: "4", display: PHQ_LABELS[2],
      } },
      error: "invalid-response-coding",
    },
    {
      answer: { valueCoding: {
        system: "urn:corvo:phq4-response", code: "2", display: "Synthetic label",
      } },
      error: "invalid-response-choice-label",
    },
  ])(
    "rejects a malformed or uncoded PHQ response ($answer)",
    ({ answer, error }) => {
      const slot = mentalHealthSlots.phq4[0];
      const items = serializeSlots("Q16", [slot], { [slot.id]: known(2) }, []);
      items.find((item) => item.linkId === `Q16.${slot.id}`)!.answer = [answer];
      expect(() => deserializeSlots("Q16", [slot], items)).toThrow(error);
    },
  );
});
