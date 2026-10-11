import { expect, it } from "vitest";
import { canonicalJson } from "../../clinical-core/src/domain.js";
import { createFullReplyManifest } from "../src/adaptive-reply-full.js";
import {
  createDomainManifest,
  decodeDomainDraft,
} from "../src/adaptive-reply-domain.js";
import {
  createGroupedExtractionManifest,
  encodeGroupedExtraction,
  compileGroupedExtraction,
  type GroupedWire,
} from "../src/adaptive-extraction-grouped-v2.js";
import {
  groupedCaseContext,
  groupedDevelopmentContext,
} from "../../../scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js";
import { fullDevelopmentContext } from "../../../scripts/qualification/fixtures/adaptive-full-development.js";
import { groupedRepresentativeDraft as domainRepresentativeDraft } from "../../../scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js";
import { groupedCaseReadback } from "../../../scripts/qualification/fixtures/adaptive-extraction-grouped-v2-readback.js";
import { promptsById } from "../../clinic-content/src/index.js";
const fixture = (id: string) => {
  const context = groupedCaseContext(id);
  if (context.displayed && !promptsById[context.displayed.promptId])
    context.displayed = {
      ...context.displayed,
      promptId: context.topics.find((t) => t.id === context.displayed!.topicId)!
        .openingPromptId,
    };
  const full = createFullReplyManifest(context),
    legacy = createDomainManifest(full),
    m = createGroupedExtractionManifest(context),
    original = domainRepresentativeDraft(id, full, legacy);
  return {
    context,
    full,
    legacy,
    m,
    wire: encodeGroupedExtraction(original, m),
    old: decodeDomainDraft(original, legacy),
  };
};
const sorted = (values: unknown[]) => values.map(canonicalJson).sort();
it.each(["G3", "P1", "G7"])(
  "authored %s retains all typed semantics and fits the conservative 400 token envelope",
  (id) => {
    const f = fixture(id),
      result = compileGroupedExtraction(f.wire, f.m);
    expect(sorted(result.draft.claims)).toEqual(sorted(f.old.claims));
    expect(sorted(result.draft.items)).toEqual(sorted(f.old.items));
    expect(result.draft.residual).toEqual(f.old.residual);
    expect(result.draft.accounting).toEqual(f.old.accounting);
    expect(
      Math.ceil(Buffer.byteLength(JSON.stringify(f.wire)) * 0.5),
    ).toBeLessThanOrEqual(400);
    const system = String(f.m.messages[0].content);
    for (const caseId of ["G3", "P1", "G7"])
      for (const sentence of groupedCaseContext(caseId).source.text.split(
        /(?<=[.!?])\s+/,
      ))
        expect(system).not.toContain(sentence);
  },
);
it.each([
  "first-intake",
  "pre-visit",
  "non-visit",
  "post-visit",
  "billing",
  "scheduling",
  "refill",
] as const)(
  "%s has readable whole scenario context and bounded schema/request",
  (scenario) => {
    const m = createGroupedExtractionManifest(
        groupedDevelopmentContext(scenario),
      ),
      payload = JSON.parse(String(m.messages[1].content));
    expect(m.measurement.schemaBytes).toBeLessThanOrEqual(32000);
    expect(m.measurement.requestBodyBytes).toBeLessThanOrEqual(131072);
    expect(payload.topics.length).toBeGreaterThan(0);
    expect(
      payload.topics.every(
        (t: {
          purpose: string;
          minimums: string;
          stopRules: string[];
          fields: unknown[];
        }) => t.purpose && t.minimums && t.stopRules && t.fields.length,
      ),
    ).toBe(true);
    expect(
      payload.displayed === null || typeof payload.displayed.text === "string",
    ).toBe(true);
    expect(
      compileGroupedExtraction(
        {
          m: m.id,
          topics: {},
          events: [],
          residual: [],
          disposition: "partially-represented",
        },
        m,
      ).draft.claims,
    ).toEqual([]);
  },
);
it("P1 uses the existing S01a displayed copy and clearly identifies appointment recollections as patient reports", () => {
  const f = fixture("P1"),
    payload = JSON.parse(String(f.m.messages[1].content));
  expect(f.context.displayed?.promptId).toBe("S01a");
  expect(payload.displayed.text).toBe(promptsById.S01a.text);
  const appointment = payload.topics.find(
    (t: { id: string }) => t.id === "W02",
  );
  expect(JSON.stringify(appointment)).toContain("Patient-reported");
  expect(JSON.stringify(appointment)).not.toContain(
    "Verified appointment/context",
  );
});
it("strict local relations reject illegal scalar/item placement, types, identities and source overrides", () => {
  const f = fixture("G3");
  const bad = structuredClone(f.wire);
  bad.topics.Q11.known![0][1].day = 27;
  expect(() => compileGroupedExtraction(bad, f.m)).toThrow();
  const placement = structuredClone(f.wire);
  placement.topics.Q11.known!.push([
    "s0",
    { foodDrink: "fabricated scalar item" },
  ]);
  expect(() => compileGroupedExtraction(placement, f.m)).toThrow();
  const identity = structuredClone(f.wire);
  identity.topics.Q11.lists!.occasions.items![0].existing = "i999";
  delete identity.topics.Q11.lists!.occasions.items![0].new;
  expect(() => compileGroupedExtraction(identity, f.m)).toThrow();
  const span = structuredClone(f.wire);
  span.topics.Q11.known![0][0] = ["s0", 0, 99999];
  expect(() => compileGroupedExtraction(span, f.m)).toThrow();
  const provenance = structuredClone(f.wire);
  provenance.topics.Q11.known![0][0] = {
    e: ["s0"],
    p: "s0",
    v: ["s0", 999, 1000],
    t: null,
    c: [],
  };
  expect(() => compileGroupedExtraction(provenance, f.m)).toThrow();
  const correction = fixture("G7");
  const wrong = structuredClone(correction.wire);
  wrong.topics.Q08.lists!.medicines.items![0].known![0][0] = {
    e: ["s0"],
    p: "s0",
    v: "s0",
    t: null,
    c: ["p999"],
  };
  expect(() => compileGroupedExtraction(wrong, correction.m)).toThrow();
});
it("narrow detail stays exact and broad negative remains an observable semantic failure without repair", () => {
  const f = fixture("P1"),
    result = compileGroupedExtraction(f.wire, f.m),
    topic = f.wire.topics.W02;
  expect(result.draft.claims).toHaveLength(3);
  expect(result.narrow[0].detail).toBe("I need no transport help.");
  const broad = structuredClone(f.wire),
    ref = topic.narrow![0][0];
  delete broad.topics.W02.narrow;
  broad.topics.W02.negative = [[ref, ["logistics"]]];
  expect(
    compileGroupedExtraction(broad, f.m).draft.claims.find(
      (c) =>
        f.full.targets.find((t) => t.id === c.targetId)?.path === "logistics",
    )?.state,
  ).toBe("negative");
  const invented = structuredClone(f.wire);
  invented.topics.W02.narrow![0][1].logistics = "No practical needs.";
  expect(() => compileGroupedExtraction(invented, f.m)).toThrow();
});
it("proper narrow P1 continues independently while preserving unresolved breadth and zero credit", async () => {
  const f = fixture("P1"),
    read = await groupedCaseReadback("P1", { raw: f.wire });
  expect(read.timings.captureSavedMs).not.toBeNull();
  expect(read.timings.nextQuestionSavedMs).not.toBeNull();
  expect(read.projection.gaps.length).toBeGreaterThan(0);
  expect(read.projection.creditedSourceIds).toEqual([]);
  expect(read.savedDraft.adaptive?.exchange?.prompt?.targetPaths).not.toContain(
    "logistics",
  );
});
it("unaccounted source paired with narrow detail stays blocked; conflict gates are never suppressed", async () => {
  const f = fixture("P1"),
    bad = structuredClone(f.wire);
  delete bad.topics.W02.known;
  const read = await groupedCaseReadback("P1", { raw: bad });
  expect(read.timings.captureSavedMs).not.toBeNull();
  expect(read.timings.nextQuestionSavedMs).toBeNull();
  expect(read.savedDraft.adaptive?.exchange?.status).toBe(
    "interpretation-review",
  );
  const g = fixture("G7"),
    conflict = structuredClone(g.wire),
    item = conflict.topics.Q08.lists!.medicines.items![0];
  delete item.existing;
  item.new = ["patient", "Metformin", "s0"];
  const conflicting = await groupedCaseReadback("G7", { raw: conflict });
  expect(conflicting.timings.nextQuestionSavedMs).toBeNull();
  expect(conflicting.projection.gaps.some((g) => g.reason === "conflict")).toBe(
    true,
  );
});
it.each(["negative", "unknown", "uncertain", "declined"] as const)(
  "ordinary source-linked %s supplies only its exact field and permits unanswered question flow",
  (state) => {
    const base = groupedCaseContext("P1"),
      text = {
        negative: "I need no practical help before my visit.",
        unknown: "I do not know what practical help I need before my visit.",
        uncertain: "I am unsure what practical help I need before my visit.",
        declined: "I decline to discuss practical help before my visit.",
      }[state],
      source = { ...base.source, text },
      context = { ...base, source, sources: [source] },
      m = createGroupedExtractionManifest(context),
      wire: GroupedWire = {
        m: m.id,
        topics: { W02: { owner: "patient", [state]: [["s0", ["logistics"]]] } },
        events: [],
        residual: [],
        disposition: "represented",
      },
      result = compileGroupedExtraction(wire, m);
    expect(
      result.draft.claims.map((c) => [
        createFullReplyManifest(context).targets.find(
          (t) => t.id === c.targetId,
        )?.path,
        c.state,
      ]),
    ).toEqual([["logistics", state]]);
    expect(result.draft.residual).toEqual([]);
  },
);
it("family ownership remains explicit and cross-topic volunteered facts are retained", () => {
  const f = fixture("G5"),
    result = compileGroupedExtraction(f.wire, f.m);
  expect(sorted(result.draft.claims)).toEqual(sorted(f.old.claims));
  expect(result.draft.claims.some((c) => c.scope.subject === "other")).toBe(
    true,
  );
  const bad = structuredClone(f.wire),
    topic = Object.values(bad.topics).find((t) => Array.isArray(t.owner))!;
  topic.owner = "patient";
  const family = Object.values(topic.lists!)[0].items![0];
  family.new![0] = "patient";
  expect(() => compileGroupedExtraction(bad, f.m)).toThrow();
});
it("quoted third-party advice cannot become a current-topic patient move-on command", () => {
  const base = groupedCaseContext("P1"),
    source = { ...base.source, text: "My sister said to move on." },
    m = createGroupedExtractionManifest({ ...base, source, sources: [source] });
  expect(() =>
    compileGroupedExtraction(
      {
        m: m.id,
        topics: {},
        events: [
          {
            kind: "move-on",
            topic: "W02",
            source: "s0",
            owner: "administrative",
          },
        ],
        residual: [],
        disposition: "represented",
      },
      m,
    ),
  ).toThrow();
});

it.each(["G1", "G2", "G4", "B1", "N1", "V1", "A1", "S1", "G8"])(
  "material source contrast %s preserves typed source meaning and unresolved volunteered content",
  (id) => {
    const f = fixture(id),
      r = compileGroupedExtraction(f.wire, f.m);
    expect(sorted(r.draft.claims)).toEqual(sorted(f.old.claims));
    expect(sorted(r.draft.items)).toEqual(sorted(f.old.items));
    expect(r.draft.residual).toEqual(f.old.residual);
    if (id === "G1") {
      expect(
        r.draft.claims.filter((c) =>
          f.full.targets
            .find((t) => t.id === c.targetId)
            ?.path.startsWith("lastMeasuredWeight"),
        ).length,
      ).toBeGreaterThan(0);
      expect(
        r.draft.claims.filter((c) =>
          f.full.targets
            .find((t) => t.id === c.targetId)
            ?.path.startsWith("currentWeightEstimate"),
        ).length,
      ).toBeGreaterThan(0);
    }
    if (id === "G4") {
      for (const item of f.wire.topics.Q08.lists!.medicines.items!) {
        const fields = item.known!.flatMap((g) => Object.keys(g[1]));
        expect(fields).toContain("labelDirections");
        expect(fields).toContain("actualUse");
      }
    }
    if (id === "A1" || id === "G8")
      expect(r.draft.residual.length).toBeGreaterThan(0);
    if (id === "V1")
      expect(
        r.draft.claims.some((c) =>
          c.evidence.some((e) => e.quote.includes("not have a copy")),
        ),
      ).toBe(true);
  },
);

it.each(["G3", "P1", "G7"])(
  "actual adapter admission %s respects the per-message cap as well as total request/schema caps",
  async (id) => {
    const f = fixture(id);
    const { prepareDigitalOceanStreamRequest } =
      await import("../../clinical-core/src/digitalocean-stream.js");
    const request = await prepareDigitalOceanStreamRequest(
      {
        endpoint: "https://inference.do-ai.run",
        model: "qwen3.8-max",
        apiKey: "offline-only",
        timeoutMs: 30000,
        maxOutputTokens: 512,
        maxRequestBytes: 131072,
        responseFormat: {
          type: "json-schema",
          name: "adaptive_extraction_grouped_v2",
          schema: f.m.jsonSchema,
        },
      },
      [...f.m.messages],
    );
    expect(request.requestBytes).toBeLessThanOrEqual(131072);
    for (const message of f.m.messages)
      expect(String(message.content).length).toBeLessThanOrEqual(32000);
  },
);
it("successor P1 structured values retain the update date and appointment date/time/timezone independently of evidence", () => {
  const f = fixture("P1"),
    result = compileGroupedExtraction(f.wire, f.m),
    value = (path: string) =>
      result.draft.claims.find(
        (c) => f.full.targets.find((t) => t.id === c.targetId)?.path === path,
      )?.value;
  expect(value("changes")).toBe(
    "Since the October 8, 2026 update, nausea stopped",
  );
  expect(value("appointmentContext")).toBe(
    "Patient reports October 20, 2026 at 9 am Pacific; staff verification absent.",
  );
  const captureValue = (path: string) =>
    result.capture.claims.find((c) => c.topicId === "W02" && c.path === path)
      ?.value;
  expect(captureValue("changes")).toBe(value("changes"));
  expect(captureValue("appointmentContext")).toBe(value("appointmentContext"));
  const system = String(f.m.messages[0].content);
  expect(system).not.toContain(String(value("changes")));
  expect(system).not.toContain(String(value("appointmentContext")));
});
it.each([
  "Please move on. Please move on.",
  "   Please move on.  Please move on.",
])(
  "repeated identical statements preserve the issued second occurrence with whitespace: %s",
  async (text) => {
    const { groupedNavigationAudit } =
      await import("../src/adaptive-extraction-grouped-v2.js");
    const base = groupedCaseContext("P1"),
      source = { ...base.source, text },
      context = { ...base, source, sources: [source] },
      m = createGroupedExtractionManifest(context),
      wire = {
        m: m.id,
        topics: {},
        events: [
          {
            kind: "move-on",
            topic: "W02",
            source: "s1",
            owner: "administrative",
          },
        ],
        residual: [[["s0"], "ambiguous"]],
        disposition: "partially-represented",
      },
      compiled = compileGroupedExtraction(wire, m),
      audit = groupedNavigationAudit(wire, m, compiled.capture);
    expect(audit?.retention).toBe("retained");
    if (audit?.retention !== "retained") throw new Error("audit missing");
    const span = JSON.parse(audit.content).events[0].evidence[0],
      expected = text.lastIndexOf("Please move on.");
    expect(span).toEqual({
      sourceId: source.id,
      start: expected,
      end: expected + "Please move on.".length,
    });
    expect(span.start).not.toBe(text.indexOf("Please move on."));
    expect(compiled.capture.acts![0].evidence[0]).toEqual(span);
  },
);
it("repeated patient questions preserve the second statement in human request audit; ambiguous subquotes fail closed", async () => {
  const { groupedNavigationAudit } =
    await import("../src/adaptive-extraction-grouped-v2.js");
  const base = groupedCaseContext("P1"),
    text = "Why is this question needed? Why is this question needed?",
    source = { ...base.source, text },
    m = createGroupedExtractionManifest({ ...base, source, sources: [source] }),
    wire = {
      m: m.id,
      topics: {},
      events: [
        {
          kind: "question",
          topic: "W02",
          source: "s1",
          owner: "administrative",
        },
      ],
      residual: [[["s0"], "ambiguous"]],
      disposition: "partially-represented",
    },
    compiled = compileGroupedExtraction(wire, m),
    audit = groupedNavigationAudit(wire, m, compiled.capture);
  if (audit?.retention !== "retained") throw new Error("audit missing");
  expect(JSON.parse(audit.content).events[0].evidence[0].start).toBe(
    text.lastIndexOf("Why is this question needed?"),
  );
  const ambiguousSource = { ...source, text: "go now, go now?" },
    ambiguous = createGroupedExtractionManifest({
      ...base,
      source: ambiguousSource,
      sources: [ambiguousSource],
    });
  expect(() =>
    compileGroupedExtraction(
      {
        m: ambiguous.id,
        topics: {},
        events: [
          {
            kind: "question",
            topic: "W02",
            source: ["s0", 0, 6],
            owner: "administrative",
          },
        ],
        residual: [],
        disposition: "represented",
      },
      ambiguous,
    ),
  ).toThrow("ambiguous-source-quote");
});
