/** One explicitly reserved extraction-only call, or a credential-free offline preflight. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import {
  createGroupedExtractionManifest,
  groupedExtractionSchemaName,
  groupedExtractionProtocol,
  encodeGroupedExtraction,
  compileGroupedExtraction,
  consumeGroupedExtraction,
} from "../../.extraction-grouped-v2-build/packages/clinic-api/src/adaptive-extraction-grouped-v2.js";
import {
  createFullReplyManifest,
  prepareFullCapture,
} from "../../.extraction-grouped-v2-build/packages/clinic-api/src/adaptive-reply-full.js";
import {
  createDomainManifest,
  decodeDomainDraft,
} from "../../.extraction-grouped-v2-build/packages/clinic-api/src/adaptive-reply-domain.js";
import { canonicalJson } from "../../.extraction-grouped-v2-build/packages/clinical-core/src/domain.js";
import {
  prepareDigitalOceanStreamRequest,
  fullStreamLimits,
} from "../../.extraction-grouped-v2-build/packages/clinical-core/src/digitalocean-stream.js";
import { createSyntheticPartialCapture } from "../../.extraction-grouped-v2-build/packages/clinic-api/src/adaptive-reply-compact.js";
import {
  groupedCaseContext,
  groupedDevelopmentContext,
} from "../../.extraction-grouped-v2-build/scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js";
import { fullDevelopmentContext } from "../../.extraction-grouped-v2-build/scripts/qualification/fixtures/adaptive-full-development.js";
import {
  groupedCaseLabels as domainCaseLabels,
  groupedLabelInventory as domainLabelInventory,
  groupedRepresentativeDraft as domainRepresentativeDraft,
} from "../../.extraction-grouped-v2-build/scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js";
import { groupedCaseReadback } from "../../.extraction-grouped-v2-build/scripts/qualification/fixtures/adaptive-extraction-grouped-v2-readback.js";
import { validateFullDevelopmentAllocation } from "./adaptive-full-reservation.mjs";
const allowed = new Set(["--id", "--case", "--live", "--env", "--reservation"]),
  args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  assert(allowed.has(k) && !args.has(k), "unsupported/duplicate argument");
  args.set(k, k === "--live" ? true : process.argv[++i]);
  assert(args.get(k), "missing argument");
}
const id = args.get("--id"),
  caseId = args.get("--case"),
  live = args.has("--live"),
  env = args.get("--env"),
  allocation = args.get("--reservation");
assert(
  { "DO-AF58": "G3", "DO-AF59": "P1", "DO-AF60": "G7" }[id] === caseId &&
    caseId,
  "fixed grouped extraction operation/case required",
);
assert(
  live || (!env && !allocation),
  "offline must not access credentials/reservation",
);
const workspace = resolve(fileURLToPath(new URL("../../", import.meta.url)));
assert(resolve(process.cwd()) === workspace, "run in this workspace");
const sha = (x) => createHash("sha256").update(x).digest("hex"),
  prefix = `docs/implementation/evidence/${id}`;
for (const suffix of ["-INTENT.json", ".json"])
  assert(!existsSync(prefix + suffix), "preserve prior dispatch, never retry");
if (!live)
  assert(!existsSync(prefix + "-PREFLIGHT.json"), "preflight already exists");
assert(
  sha(readFileSync("packages/clinical-core/src/digitalocean.ts")) ===
    "0e40777c1c04ca3a4c8b3dee00240e5242ac4a1027028a89dd9257be2e47403e",
  "stable reviewed adapter required",
);
const freezePaths = [
  "S3-DOMAIN-PROMPT-FREEZE.json",
  "S3-DOMAIN-MODEL-COMPARISON-FREEZE.json",
  "S3-DOMAIN-BOUNDED-FREEZE.json",
  "S3-EXTRACTION-SCOPED-FREEZE-WITHDRAWN-NO-SETTLEMENT.json",
  "S3-EXTRACTION-SETTLEMENT-FREEZE.json",
  "S3-EXTRACTION-GROUPED-FREEZE.json",
].map((p) => "docs/implementation/evidence/" + p);
const settlementFreeze = JSON.parse(
  readFileSync(
    "docs/implementation/evidence/S3-EXTRACTION-SETTLEMENT-FREEZE.json",
  ),
);
const settlementSnapshot = JSON.parse(
  readFileSync(resolve(settlementFreeze.candidateArchive, "SNAPSHOT.json")),
);
const currentScopedPin = settlementSnapshot.files.find(
  (p) => p.path === "packages/clinic-api/src/adaptive-extraction-scoped.ts",
);
for (const path of freezePaths) {
  const f = JSON.parse(readFileSync(path)),
    s = JSON.parse(readFileSync(resolve(f.candidateArchive, "SNAPSHOT.json")));
  assert(
    sha(readFileSync(resolve(f.candidateArchive, "SNAPSHOT.json"))) ===
      f.snapshotSha256,
    "old frozen snapshot changed",
  );
  for (const pin of s.files) {
    assert(
      sha(readFileSync(resolve(f.candidateArchive, "files", pin.path))) ===
        pin.sha256,
      "old archived file changed",
    );
    if (pin.path.endsWith(".js"))
      assert(
        sha(readFileSync(pin.path)) === pin.sha256,
        "old working emit changed",
      );
    if (
      pin.path.endsWith(".ts") &&
      pin.path !== "packages/clinical-core/src/digitalocean.ts"
    )
      assert(
        sha(readFileSync(pin.path)) ===
          (pin.path === "packages/clinic-api/src/adaptive-extraction-scoped.ts"
            ? currentScopedPin.sha256
            : pin.sha256),
        "current authoritative internal implementation/fixture changed",
      );
  }
}
const build = resolve(".extraction-grouped-v2-build"),
  files = readdirSync(build, { recursive: true })
    .filter((f) => typeof f === "string" && f.endsWith(".js"))
    .sort();
assert(files.length && files.length < 150, "bounded separate build required");
const fingerprints = files.map((f) => {
  const source = resolve(f.slice(0, -3) + ".ts"),
    dispatched = resolve(build, f);
  assert(
    statSync(dispatched).mtimeMs >= statSync(source).mtimeMs,
    "fresh emitted build required",
  );
  return {
    source: {
      path: relative(workspace, source),
      sha256: sha(readFileSync(source)),
    },
    dispatched: {
      path: relative(workspace, dispatched),
      sha256: sha(readFileSync(dispatched)),
    },
  };
});
for (const path of [
  "scripts/qualification/qualify-extraction-grouped-v2.mjs",
  "scripts/qualification/adaptive-full-reservation.mjs",
  "tsconfig.extraction-scoped.json",
  "tsconfig.extraction-scoped-v2.json",
  "tsconfig.extraction-scoped-final.json",
  "tsconfig.extraction-settlement.json",
  "tsconfig.extraction-grouped.json",
  "tsconfig.extraction-grouped-v2.json",
  "packages/clinic-api/test/adaptive-extraction-grouped-v2.test.ts",
  "packages/clinic-api/test/adaptive-extraction-grouped-session-v2.test.ts",
  "docs/implementation/evidence/S3-CLINICAL-ARCHITECTURE-RESET.md",
  "tsconfig.stream-domain.json",
  "tsconfig.foundation.json",
  "vitest.foundation.config.mts",
  "packages/clinic-api/test/adaptive-extraction-scoped.test.ts",
  "packages/clinic-api/test/adaptive-extraction-session.test.ts",
  "packages/clinic-api/test/adaptive-stream-session.test.ts",
  ...freezePaths,
])
  fingerprints.push({
    source: { path, sha256: sha(readFileSync(path)) },
    dispatched: { path, sha256: sha(readFileSync(path)) },
  });
const context = groupedCaseContext(caseId),
  labels = domainCaseLabels(caseId),
  manifest = createGroupedExtractionManifest(context),
  candidateSha256 = sha(JSON.stringify(fingerprints)),
  allLabels = domainLabelInventory();
const baseline = JSON.parse(
  readFileSync(
    `docs/implementation/evidence/${{ G3: "DO-AF40", P1: "DO-AF41", G7: "DO-AF39" }[caseId]}-PREFLIGHT.json`,
  ),
);
assert(
  baseline.sourceSha256 === sha(context.source.text) &&
    baseline.labelsSha256 === labels.historicalLabelsSha256,
  "source/labels changed",
);
const config = {
    endpoint: "https://inference.do-ai.run",
    model: "qwen3.8-max",
    timeoutMs: 30000,
    maxOutputTokens: 512,
    maxRequestBytes: 131072,
  },
  prepare = (m) =>
    prepareDigitalOceanStreamRequest(
      {
        ...config,
        apiKey: "offline-preflight-only",
        responseFormat: {
          type: "json-schema",
          name: groupedExtractionSchemaName,
          schema: m.jsonSchema,
        },
      },
      [...m.messages],
    );
const request = await prepare(manifest),
  scenarioMeasurements = {};
for (const scenario of [
  "first-intake",
  "pre-visit",
  "non-visit",
  "post-visit",
  "billing",
  "scheduling",
  "refill",
]) {
  const m = createGroupedExtractionManifest(
    groupedDevelopmentContext(scenario),
  );
  scenarioMeasurements[scenario] = {
    ...m.measurement,
    requestBytes: (await prepare(m)).requestBytes,
  };
}
const full = createFullReplyManifest(context),
  legacy = createDomainManifest(full),
  authoredLegacy = domainRepresentativeDraft(caseId, full, legacy),
  wire = encodeGroupedExtraction(authoredLegacy, manifest),
  compiled = compileGroupedExtraction(wire, manifest),
  oldDraft = decodeDomainDraft(authoredLegacy, legacy);
const sorted = (a) => a.map(canonicalJson).sort();
for (const key of ["claims", "items", "closures"])
  assert.deepEqual(sorted(compiled.draft[key]), sorted(oldDraft[key]));
assert.deepEqual(compiled.draft.residual, oldDraft.residual);
assert.deepEqual(compiled.draft.accounting, oldDraft.accounting);
const authoredChecks = {
  syntheticAuthored: true,
  providerCalls: 0,
  wire,
  expandedDraft: compiled.draft,
  preparedCapture: compiled.capture,
  internalDraftSha256: sha(canonicalJson(compiled.draft)),
  internalSemanticsIdentical: true,
  claimOrderingMayDiffer: true,
  outputBytes: Buffer.byteLength(JSON.stringify(wire)),
  conservativeOutputTokens: Math.ceil(
    Buffer.byteLength(JSON.stringify(wire)) * 0.5,
  ),
  actualTokenizerUsed: false,
  tokenEstimateMethod:
    "0.5 tokens per UTF-8 byte; conservative versus observed frozen Qwen receipts, not a universal tokenizer bound",
};
assert(
  authoredChecks.conservativeOutputTokens <= 400,
  "authored semantic-preserving budget exceeded",
);
const preflight = {
  id,
  caseId,
  purpose: "single-context-grouped-qwen-prospective-probe",
  syntheticOnly: true,
  protocol: groupedExtractionProtocol,
  model: config.model,
  callCount: 0,
  maximumCalls: 1,
  maximumOutputTokens: 512,
  timeoutMs: 30000,
  maxRequestBytes: 131072,
  requestBytes: request.requestBytes,
  requestBodySha256: sha(request.body),
  sourceSha256: sha(context.source.text),
  labelsSha256: sha(JSON.stringify(labels)),
  candidateSha256,
  developmentCaseIds: ["G3", "P1", "G7"],
  developmentSetSha256: sha(JSON.stringify(allLabels)),
  scenarioMeasurements,
  responseSchema: request.responseSchema,
  streamLimits: fullStreamLimits(512),
  manifest: {
    id: manifest.id,
    sha256: manifest.sha256,
    measurement: manifest.measurement,
  },
  implementationFingerprints: fingerprints,
  authoredChecks,
  displayContextRevision: "grouped-successor-display-v1",
  originalDisplayedPromptId:
    caseId === "P1" ? "W02" : context.displayed.promptId,
  displayed: context.displayed,
  exactWire: {
    max_tokens: 512,
    stream: true,
    response_format: "json_schema",
    reasoningParameterPresent: false,
  },
  semanticsQualified: false,
  latencyQualified: false,
  defaultEnabled: false,
  holdoutRead: false,
};
if (!live) {
  const folder = `docs/implementation/evidence/GROUPED-EXTRACTION-V2-CANDIDATE-${candidateSha256}`,
    pins = new Map(
      fingerprints
        .flatMap((p) => [p.source, p.dispatched])
        .map((p) => [p.path, p.sha256]),
    );
  if (!existsSync(folder)) {
    mkdirSync(folder);
    for (const [path, digest] of pins) {
      const dest = resolve(folder, "files", path);
      mkdirSync(resolve(dest, ".."), { recursive: true });
      copyFileSync(path, dest);
      assert(sha(readFileSync(dest)) === digest);
      chmodSync(dest, 0o444);
    }
    writeFileSync(
      folder + "/LABELS.json",
      JSON.stringify(allLabels, null, 2) + "\n",
      { flag: "wx" },
    );
    writeFileSync(
      folder + "/SNAPSHOT.json",
      JSON.stringify(
        {
          candidateSha256,
          developmentCaseIds: ["G3", "P1", "G7"],
          developmentSetSha256: preflight.developmentSetSha256,
          files: [...pins].map(([path, sha256]) => ({ path, sha256 })),
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    chmodSync(folder + "/LABELS.json", 0o444);
    chmodSync(folder + "/SNAPSHOT.json", 0o444);
  } else {
    const snapshot = JSON.parse(readFileSync(folder + "/SNAPSHOT.json"));
    assert(snapshot.candidateSha256 === candidateSha256);
    for (const pin of snapshot.files)
      assert(
        sha(readFileSync(resolve(folder, "files", pin.path))) === pin.sha256,
      );
  }
  writeFileSync(
    prefix + "-PREFLIGHT.json",
    JSON.stringify(preflight, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      id,
      state: "offline-preflight-only",
      callCount: 0,
      requestBytes: request.requestBytes,
      candidateSha256,
    }),
  );
} else {
  assert(
    JSON.stringify(JSON.parse(readFileSync(prefix + "-PREFLIGHT.json"))) ===
      JSON.stringify(preflight),
    "preflight changed, do not dispatch",
  );
  assert(
    allocation &&
      isAbsolute(allocation) &&
      statSync(allocation).size <= 16384 &&
      !(statSync(allocation).mode & 0o077),
    "private exact allocation required",
  );
  const reservation = validateFullDevelopmentAllocation(
    JSON.parse(readFileSync(allocation)),
    preflight,
  );
  assert(
    env && isAbsolute(env) && !(statSync(env).mode & 0o077),
    "private runtime environment required",
  );
  assert(
    readFileSync(
      "/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md",
      "utf8",
    ).includes(`| ${reservation.allocationId} /`),
    "root ledger reservation required",
  );
  loadEnvFile(env);
  const apiKey =
    process.env.DIGITALOCEAN_MODEL_ACCESS_KEY ||
    process.env.DIGITALOCEAN_MODEL_ACESS_KEY;
  assert(apiKey, "missing model key");
  const intent = {
    ...preflight,
    reservation,
    state: "dispatch-intent",
    outcome: "unknown",
    at: new Date().toISOString(),
  };
  writeFileSync(
    `docs/implementation/evidence/GROUPED-EXTRACTION-V2-${candidateSha256}-${caseId}-INTENT.json`,
    JSON.stringify(intent, null, 2) + "\n",
    { flag: "wx" },
  );
  writeFileSync(
    prefix + "-INTENT.json",
    JSON.stringify(intent, null, 2) + "\n",
    { flag: "wx" },
  );
  let calls = 0;
  const partial = createSyntheticPartialCapture();
  let result, evidence;
  try {
    result = await consumeGroupedExtraction({ ...config, apiKey }, manifest, {
      fetcher: async (url, init) => {
        assert(++calls === 1, "one-call limit");
        return fetch(url, init);
      },
      onSyntheticContent: (text) => partial.append(text),
    });
    evidence = {
      ...preflight,
      state: "compatibility-observed",
      callCount: calls,
      providerReceipt: result.receipt,
      draft: result.draft,
      normalizedCapture: result.capture,
      rawOutput: result.rawOutput,
      timings: result.timings,
      admission: result.admission,
      observedResultRequiresHumanSemanticReview: true,
    };
  } catch (error) {
    evidence = {
      ...preflight,
      state: "compatibility-failed",
      callCount: calls,
      errorCode:
        typeof error?.code === "string" ? error.code : "grouped-probe-failed",
      ...(error?.receipt ? { providerReceipt: error.receipt } : {}),
      note: "Unknown outcomes retain the reservation; no retry/fallback.",
    };
  }
  evidence.partialContentEvidence = partial.snapshot();
  try {
    evidence.appReadback = await groupedCaseReadback(caseId, {
      raw: result ? JSON.parse(result.rawOutput) : undefined,
      receipt: evidence.providerReceipt,
      errorCode: evidence.errorCode,
    });
  } catch {
    evidence.appReadback = {
      offlineResponseReplay: true,
      state: "readback-failed",
    };
  }
  evidence.reservation = { ...reservation, consumed: true, refund: false };
  writeFileSync(prefix + ".json", JSON.stringify(evidence, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      id,
      state: evidence.state,
      callCount: calls,
      receipt: prefix + ".json",
      semanticsQualified: false,
      latencyQualified: false,
    }),
  );
}
