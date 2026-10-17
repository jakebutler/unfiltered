import { expect, it, vi } from "vitest";
import {
  createGroupedExtractionManifest,
  encodeGroupedExtraction,
  groupedSavedNavigation,
} from "../src/adaptive-extraction-grouped.js";
import { runGroupedExtractionOperation } from "../src/adaptive-extraction-grouped-session.js";
import { trackDirectAdaptiveEdits } from "../src/adaptive-stream-session.js";
import { createFullReplyManifest } from "../src/adaptive-reply-full.js";
import { createDomainManifest } from "../src/adaptive-reply-domain.js";
import { ApiFailure, type Draft, type StoredDraft } from "../src/types.js";
import { groupedCaseContext } from "../../../scripts/qualification/fixtures/adaptive-extraction-grouped-cases.js";
import { domainRepresentativeDraft } from "../../../scripts/qualification/fixtures/adaptive-domain-development.js";
import { groupedCaseReadback } from "../../../scripts/qualification/fixtures/adaptive-extraction-grouped-readback.js";
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(
  caseId = "G3",
  contextOverride?: ReturnType<typeof groupedCaseContext>,
  wireFactory?: (
    m: ReturnType<typeof createGroupedExtractionManifest>,
  ) => unknown,
) {
  const context = contextOverride ?? groupedCaseContext(caseId),
    m = createGroupedExtractionManifest(context),
    full = createFullReplyManifest(context),
    wire = wireFactory
      ? wireFactory(m)
      : encodeGroupedExtraction(
          domainRepresentativeDraft(caseId, full, createDomainManifest(full)),
          m,
        ),
    id = context.binding.operationId;
  let stored: StoredDraft = {
    resource: { resourceType: "DocumentReference", id: "experiment" },
    versionId: "1",
    draft: {
      schema: 1,
      id: context.binding.sessionId,
      patient: context.binding.patient,
      scenario: context.binding.scenario,
      revision: context.binding.revision + 1,
      createdAt: context.source.at,
      savedAt: context.source.at,
      phase: "conversation",
      turns: context.sources.map((s) => ({ ...s, channel: "text" })),
      topics: context.responses as Draft["topics"],
      requests: {},
      version: 1,
      adaptive: {
        mode: "adaptive",
        activeOperationId: id,
        targetGenerations: {},
        operations: {
          [id]: {
            id,
            sourceId: context.source.id,
            requestId: id,
            fingerprint: "extraction-test",
            binding: context.binding,
            status: "processing",
            attemptId: id,
            processingRevision: context.binding.revision + 1,
            acceptedAt: context.source.at,
            updatedAt: context.source.at,
            stream: {
              protocol: "durable-provisional-stream-v1",
              reply: "pending",
              capture: "pending",
              targetGenerations: {},
            },
          },
        },
      },
    },
  };
  let race: ((d: Draft) => void) | undefined,
    afterSave: (() => void) | undefined,
    fail = false,
    failFresh = false;
  const writes: Draft[] = [];
  const edit = (fn: (d: Draft) => void) => {
    const next = structuredClone(stored.draft);
    fn(next);
    next.revision++;
    stored = {
      ...stored,
      draft: trackDirectAdaptiveEdits(stored.draft, next),
      versionId: String(Number(stored.versionId) + 1),
    };
  };
  const store = {
    read: async () => {
      if (failFresh && writes.length) throw new ApiFailure("read-failed", 503);
      return structuredClone(stored);
    },
    save: async (previous: StoredDraft, next: Draft) => {
      if (race) {
        const fn = race;
        race = undefined;
        edit(fn);
      }
      if (previous.versionId !== stored.versionId)
        throw new ApiFailure("stale-session", 409);
      if (fail) throw new ApiFailure("save-outcome-unknown", 503);
      stored = {
        ...stored,
        draft: structuredClone(next),
        versionId: String(Number(stored.versionId) + 1),
      };
      writes.push(next);
      afterSave?.();
      return structuredClone(stored);
    },
  };
  const tail = deferred<{ raw: unknown }>(),
    extract = vi.fn(async () => tail.promise),
    onReplySaved = vi.fn();
  const run = (timeoutMs = 1000, signal?: AbortSignal) =>
    runGroupedExtractionOperation(
      store,
      structuredClone(stored),
      context,
      { extract },
      { now: Date.now, timeoutMs, signal, onReplySaved },
    );
  return {
    context,
    m,
    wire,
    id,
    store,
    tail,
    extract,
    onReplySaved,
    run,
    writes,
    edit,
    current: () => structuredClone(stored),
    race: (fn: (d: Draft) => void) => {
      race = fn;
    },
    afterSave: (fn: () => void) => {
      afterSave = fn;
    },
    failSave: () => {
      fail = true;
    },
    failFresh: () => {
      failFresh = true;
    },
  };
}
it("saves completed provisional capture and an issued local question before notification, with no early provider action", async () => {
  const f = fixture(),
    running = f.run();
  await Promise.resolve();
  expect(f.writes).toHaveLength(0);
  expect(f.onReplySaved).not.toHaveBeenCalled();
  f.tail.resolve({ raw: f.wire });
  const result = await running,
    op = result.stored.draft.adaptive!.operations[f.id];
  expect(op.status).toBe("applied");
  expect(op.stream).toMatchObject({ capture: "saved", reply: "saved" });
  expect(op.stream!.navigation).toBeUndefined();
  expect(op.stream!.provisional!.claims.length).toBeGreaterThan(3);
  expect(result.stored.draft.topics).toEqual(f.context.responses);
  expect(f.onReplySaved).toHaveBeenCalledTimes(1);
  expect(result.localQuestionOrigin).toBe(
    "issued-local-content-after-complete-capture",
  );
  expect(result.timings.captureValidatedMs).not.toBeNull();
  expect(result.timings.nextQuestionSavedMs).not.toBeNull();
  expect(result.timings.nextQuestionSavedMs!).toBeGreaterThanOrEqual(
    result.timings.captureSavedMs!,
  );
});
it.each(["G3", "P1", "G7"])(
  "real settlement/readback saves authored %s with zero clinical credit",
  async (id) => {
    const f = fixture(id),
      r = await groupedCaseReadback(id, { raw: f.wire }),
      op =
        r.savedDraft.adaptive!.operations[
          r.savedDraft.adaptive!.activeOperationId!
        ];
    expect(op.stream!.capture).toBe("saved");
    expect(op.status).toBe("applied");
    expect(r.projection.creditedSourceIds).toEqual([]);
    expect(r.policyQualified).toBe(false);
    expect(op.stream!.reply).toBe("saved");
    expect(r.savedDraft.adaptive!.exchange!.status).toBe("question");
    if (id === "P1") {
      expect(r.projection.responses.W02?.answers.logistics?.state).not.toBe(
        "negative",
      );
      expect(
        r.savedDraft.adaptive!.exchange!.prompt!.targetPaths,
      ).not.toContain("logistics");
    }
    if (id === "G7")
      expect(r.savedDraft.adaptive!.exchange!.prompt!.text).toContain(
        "Metformin",
      );
  },
);
it("malformed completed extraction settles failed/partial without question and retains original source", async () => {
  const f = fixture(),
    running = f.run();
  f.tail.resolve({ raw: { bad: true } });
  const r = await running;
  expect(r.stored.draft.adaptive!.operations[f.id]).toMatchObject({
    status: "failed",
    errorCode: "invalid-grouped-extraction",
    stream: { reply: "withheld", capture: "partial" },
  });
  expect(r.stored.draft.turns).toEqual(f.current().draft.turns);
  expect(f.onReplySaved).not.toHaveBeenCalled();
});
it("timeout/cancel cannot apply a late complete result or notify", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(),
      controller = new AbortController(),
      running = f.run(cancel ? 1000 : 200, controller.signal);
    if (cancel) controller.abort();
    const r = await running,
      before = f.current();
    expect(r.stored.draft.adaptive!.operations[f.id].stream).toMatchObject({
      reply: "withheld",
      capture: "partial",
    });
    f.tail.resolve({ raw: f.wire });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.current()).toEqual(before);
    expect(f.onReplySaved).not.toHaveBeenCalled();
    expect(f.extract).toHaveBeenCalledTimes(cancel ? 0 : 1);
  }
});
it("direct edits and a real CAS race supersede only affected evidence and never replace the current question", async () => {
  for (const cas of [false, true]) {
    const f = fixture(),
      running = f.run(),
      change = (d: Draft) => {
        d.topics.Q11 = {
          presented: true,
          answers: {
            day: {
              state: "known",
              value: "Directly edited day",
              sourceIds: ["direct"],
            },
          },
        };
        d.activeTopic = "Q01";
      };
    if (cas) f.race(change);
    else f.edit(change);
    f.tail.resolve({ raw: f.wire });
    const r = await running,
      op = r.stored.draft.adaptive!.operations[f.id];
    expect(op.status).toBe("applied");
    expect(op.stream!.capture).toBe("saved");
    expect(op.stream!.reply).toBe("withheld");
    expect(
      op.stream!.provisional!.claims.find(
        (c) => c.topicId === "Q11" && c.path === "day",
      )!.status,
    ).toBe("superseded");
    expect(r.stored.draft.activeTopic).toBe("Q01");
    expect(r.stored.draft.topics.Q11.answers.day.value).toBe(
      "Directly edited day",
    );
    expect(f.extract).toHaveBeenCalledTimes(1);
    expect(f.onReplySaved).not.toHaveBeenCalled();
  }
});
it("discard, frozen review, confirmation and safety pause defeat interpretation application", async () => {
  for (const mode of ["discard", "review", "confirmed", "safety"]) {
    const f = fixture(),
      running = f.run();
    f.edit((d) => {
      if (mode === "discard") d.adaptive!.operations[f.id].status = "discarded";
      else if (mode === "safety") d.safety = { paused: true } as any;
      else d.phase = mode as Draft["phase"];
    });
    const before = f.current();
    f.tail.resolve({ raw: f.wire });
    const r = await running;
    expect(r.stored).toEqual(before);
    expect(f.onReplySaved).not.toHaveBeenCalled();
  }
});
it("unknown save cannot notify or retry provider work; source and pending evidence remain visible", async () => {
  const f = fixture();
  f.failSave();
  const running = f.run();
  f.tail.resolve({ raw: f.wire });
  await expect(running).rejects.toMatchObject({ code: "save-outcome-unknown" });
  expect(f.onReplySaved).not.toHaveBeenCalled();
  expect(f.extract).toHaveBeenCalledTimes(1);
  expect(f.current().draft.adaptive!.operations[f.id].status).toBe(
    "processing",
  );
});
it("capacity overflow retains explicit partial source without publishing a planned question", async () => {
  const f = fixture(),
    running = f.run();
  f.edit((d) => {
    d.notice = { tone: "info", text: "x".repeat(492000) };
  });
  f.tail.resolve({ raw: f.wire });
  const r = await running;
  expect(r.stored.draft.adaptive!.operations[f.id]).toMatchObject({
    status: "failed",
    errorCode: "provisional-capacity",
    stream: { capture: "partial", reply: "withheld" },
  });
  expect(f.onReplySaved).not.toHaveBeenCalled();
});
it("notification rechecks cancellation and fresh scope after acknowledged save", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(),
      controller = new AbortController();
    f.afterSave(() => {
      if (cancel) controller.abort();
      else
        f.edit((d) => {
          d.activeTopic = "Q05";
        });
    });
    const running = f.run(1000, controller.signal);
    f.tail.resolve({ raw: f.wire });
    const r = await running;
    expect(f.onReplySaved).not.toHaveBeenCalled();
    expect(r.timings.captureSavedMs).not.toBeNull();
    expect(r.timings.nextQuestionSavedMs).not.toBeNull();
    expect(r.notificationStatus).toBe("suppressed");
  }
});
it("caller source/binding mismatch fails before provider work; changed source while extracting cannot be applied", async () => {
  const f = fixture();
  await expect(
    runGroupedExtractionOperation(
      f.store,
      f.current(),
      { ...f.context, source: { ...f.context.source, text: "changed" } },
      { extract: f.extract },
      { now: Date.now, timeoutMs: 1000 },
    ),
  ).rejects.toMatchObject({ code: "extraction-context-unverified" });
  expect(f.extract).not.toHaveBeenCalled();
  const running = f.run();
  f.edit((d) => {
    d.turns[0].text = "Changed retained words";
  });
  f.tail.resolve({ raw: f.wire });
  const r = await running;
  expect(r.stored.draft.adaptive!.operations[f.id].stream!.capture).toBe(
    "partial",
  );
  expect(f.onReplySaved).not.toHaveBeenCalled();
});

it("already cancelled or expired attempts never invoke extraction", async () => {
  for (const aborted of [false, true]) {
    const f = fixture(),
      controller = new AbortController();
    if (aborted) controller.abort();
    else
      f.edit((d) => {
        d.adaptive!.operations[f.id].deadlineAt = new Date(
          Date.now() - 1000,
        ).toISOString();
        d.adaptive!.operations[f.id].processingRevision = d.revision + 1;
      });
    const r = await f.run(1000, controller.signal);
    expect(f.extract).not.toHaveBeenCalled();
    expect(r.stored.draft.adaptive!.operations[f.id].stream).toMatchObject({
      capture: "partial",
      reply: "withheld",
    });
    expect(f.onReplySaved).not.toHaveBeenCalled();
  }
});

it.each([
  ["unknown", "I do not know what practical help I need before my visit."],
  ["uncertain", "I am unsure what practical help I need before my visit."],
  ["declined", "I decline to discuss practical help before my visit."],
])(
  "complete field-level %s is retained and permits the next unanswered question",
  async (state, text) => {
    const context = groupedCaseContext("P1");
    context.source = { ...context.source, text };
    context.sources = [context.source];
    context.displayed = {
      ...context.displayed!,
      topicId: "W02",
      targetPaths: ["logistics"],
    };
    const f = fixture("P1", context, (m) => {
      return {
        m: m.id,
        topics: { W02: { owner: "patient", [state]: [["s0", ["logistics"]]] } },
        events: [],
        residual: [],
        disposition: "represented",
      };
    });
    const running = f.run();
    f.tail.resolve({ raw: f.wire });
    const r = await running,
      op = r.stored.draft.adaptive!.operations[f.id];
    expect(op.status).toBe("applied");
    expect(op.stream!.capture).toBe("saved");
    expect(op.stream!.reply).toBe("saved");
    expect(op.stream!.provisional!.gaps).toEqual([]);
    expect(op.stream!.provisional!.accounting.remaining).toEqual([]);
    expect(
      op.stream!.provisional!.claims.find(
        (c) => c.topicId === "W02" && c.path === "logistics",
      )!.state,
    ).toBe(state);
    expect(r.stored.draft.adaptive!.exchange!.status).toBe("question");
    expect(
      r.stored.draft.adaptive!.exchange!.prompt!.targetPaths,
    ).not.toContain("logistics");
    expect(r.stored.draft.topics).toEqual(context.responses);
    expect(r.timings.nextQuestionSavedMs).not.toBeNull();
  },
);
it("notification errors and failed fresh reads preserve the known commit without resave", async () => {
  for (const mode of ["throw", "stale-session", "fresh-read"]) {
    const f = fixture();
    if (mode === "fresh-read") f.failFresh();
    else
      f.onReplySaved.mockImplementation(() => {
        throw mode === "stale-session"
          ? new ApiFailure("stale-session", 409)
          : new Error("notification failure");
      });
    const running = f.run();
    f.tail.resolve({ raw: f.wire });
    const r = await running;
    expect(r.stored.draft.adaptive!.operations[f.id].stream).toMatchObject({
      capture: "saved",
      reply: "saved",
    });
    expect(f.writes).toHaveLength(1);
    expect(f.extract).toHaveBeenCalledTimes(1);
    expect(r.timings.captureSavedMs).not.toBeNull();
    expect(r.timings.nextQuestionSavedMs).not.toBeNull();
    expect(r.notificationStatus).toBe(
      mode === "fresh-read" ? "fresh-read-failed" : "failed",
    );
  }
});

it("genuine patient questions and current-topic move-on retain source and permit ordinary independent continuation", async () => {
  const context = groupedCaseContext("P1");
  context.source = {
    ...context.source,
    text: "Why is this question needed? Please move on.",
  };
  context.sources = [context.source];
  const f = fixture("P1", context, (m) => {
    const p = JSON.parse(m.messages[1].content);
    return {
      m: m.id,
      topics: {},
      events: [
        {
          kind: "question",
          topic: "W02",
          source: "s0",
          owner: "administrative",
        },
        {
          kind: "move-on",
          topic: "W02",
          source: "s1",
          owner: "administrative",
        },
      ],
      residual: [],
      disposition: "represented",
    };
  });
  const running = f.run();
  f.tail.resolve({ raw: f.wire });
  const r = await running,
    op = r.stored.draft.adaptive!.operations[f.id];
  expect(op.status).toBe("applied");
  expect(op.stream).toMatchObject({ capture: "saved", reply: "saved" });
  expect(op.stream!.provisional!.accounting.remaining).toEqual([]);
  expect(op.unresolvedQuestions).toHaveLength(1);
  expect(r.stored.draft.adaptive!.exchange!.status).toBe("question");
  expect(r.stored.draft.adaptive!.exchange!.prompt!.topicId).not.toBe("W02");
  expect(r.stored.draft.adaptive!.exchange!.reply!.text).toContain("care team");
  expect(r.stored.draft.turns[0].text).toBe(context.source.text);
  expect(r.timings.nextQuestionSavedMs).not.toBeNull();
});

it.each([
  ["move-on", "Please move on."],
  ["decline", "I decline to discuss this topic."],
] as const)(
  "committed %s controls later isolated navigation and hostile audits confer no authority",
  async (kind, text) => {
    const context = groupedCaseContext("P1");
    context.source = { ...context.source, text };
    context.sources = [context.source];
    const first = fixture("P1", context, (m) => ({
      m: m.id,
      topics: {},
      events: [{ kind, topic: "W02", source: "s0", owner: "administrative" }],
      residual: [],
      disposition: "represented",
    }));
    const pending = first.run();
    first.tail.resolve({ raw: first.wire });
    const saved = await pending;
    const later = {
      ...context,
      binding: {
        ...context.binding,
        operationId: context.binding.operationId + "-later",
        revision: context.binding.revision + 2,
      },
      source: {
        ...context.source,
        id: context.source.id + "-later",
        text: "I need no practical help before my visit.",
      },
      sources: [] as typeof context.sources,
    };
    later.sources = [context.source, later.source];
    expect(
      groupedSavedNavigation(saved.stored.draft, later).stopped.has("W02"),
    ).toBe(true);
    const second = fixture("P1", later, (m) => ({
      m: m.id,
      // W02 logistics is a composite-negative field: a bare negative is an unsupported state, so the
      // isolated later statement is carried as an exact narrow detail with zero field credit.
      topics: { W02: { owner: "patient", narrow: [["s0", { logistics: "I need no practical help before my visit." }]] } },
      events: [],
      residual: [],
      disposition: "partially-represented",
    }));
    second.edit((d) => {
      d.adaptive!.operations[second.id].processingRevision = d.revision + 1;
      d.adaptive!.operations[first.id] = structuredClone(
        saved.stored.draft.adaptive!.operations[first.id],
      );
    });
    const pendingSecond = second.run();
    second.tail.resolve({ raw: second.wire });
    const completed = await pendingSecond;
    expect(completed.stored.draft.adaptive!.exchange!.prompt?.topicId).not.toBe(
      "W02",
    );
    expect(completed.timings.nextQuestionSavedMs).not.toBeNull();
    for (const mutation of [
      "malformed",
      "foreign",
      "stale",
      "actor",
      "not-committed",
    ]) {
      const bad = structuredClone(saved.stored.draft),
        op = bad.adaptive!.operations[first.id];
      if (mutation === "malformed")
        (op.rawProposalAudit as { content: string }).content = "{}";
      if (mutation === "foreign") op.binding.patient = "Patient/foreign";
      if (mutation === "stale")
        bad.adaptive!.targetGenerations = { "W02:priority": 1 };
      if (mutation === "actor") bad.turns[0].role = "assistant";
      if (mutation === "not-committed") op.stream!.capture = "partial";
      expect(groupedSavedNavigation(bad, later).stopped.size).toBe(0);
    }
    expect(saved.stored.draft.topics).toEqual(context.responses);
    expect(saved.stored.draft.turns[0].text).toBe(text);
  },
);
it.each([
  ["dose-question", "Should I double my medicine dose tonight?", "COPY-05"],
  ["treatment-question", "What treatment should I use?", "COPY-04"],
] as const)(
  "%s retains a medical human request and only reviewed boundary copy",
  async (kind, text, copy) => {
    const context = groupedCaseContext("P1");
    context.source = { ...context.source, text };
    context.sources = [context.source];
    const f = fixture("P1", context, (m) => ({
      m: m.id,
      topics: {},
      events: [{ kind, topic: "W02", source: "s0", owner: "nutrition" }],
      residual: [],
      disposition: "represented",
    }));
    const pending = f.run();
    f.tail.resolve({ raw: f.wire });
    const r = await pending;
    expect(r.stored.draft.adaptive!.exchange!.reply?.id).toBe(copy);
    expect(
      r.stored.draft.adaptive!.operations[f.id].unresolvedQuestions,
    ).toHaveLength(1);
    expect(r.stored.draft.turns[0].text).toBe(text);
    expect(r.stored.draft.requests).toEqual({});
    const audit = r.stored.draft.adaptive!.operations[f.id].rawProposalAudit;
    expect(audit?.retention).toBe("retained");
    if (audit?.retention === "retained")
      expect(JSON.parse(audit.content).events[0].owner).toBe("medical");
  },
);
it("required height unknown remains partial and continues to an independent measurement without repeating height", async () => {
  const context = groupedCaseContext("G1");
  context.source = { ...context.source, text: "I do not know my height." };
  context.sources = [context.source];
  const f = fixture("G1", context, (m) => ({
    m: m.id,
    topics: {
      Q04: {
        owner: "patient",
        unknown: [["s0", ["height.value", "height.unit"]]],
      },
    },
    events: [],
    residual: [],
    disposition: "represented",
  }));
  const pending = f.run();
  f.tail.resolve({ raw: f.wire });
  const r = await pending,
    op = r.stored.draft.adaptive!.operations[f.id];
  expect(op.stream!.capture).toBe("saved");
  expect(op.stream!.provisional!.claims.map((c) => c.state)).toEqual([
    "unknown",
    "unknown",
  ]);
  expect(r.stored.draft.topics).toEqual({});
  expect(
    r.stored.draft.adaptive!.exchange!.prompt!.targetPaths.some((p) =>
      p.startsWith("height."),
    ),
  ).toBe(false);
  expect(op.stream!.provisional!.accounting.semanticReview).toBe(
    "qualification-required",
  );
  expect(r.timings.nextQuestionSavedMs).not.toBeNull();
});
