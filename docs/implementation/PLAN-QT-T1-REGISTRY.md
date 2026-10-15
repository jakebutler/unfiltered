# T1: one workflow registry, no digest change

Parent: [PLAN-QUESTIONNAIRE-TEMPLATE.md](PLAN-QUESTIONNAIRE-TEMPLATE.md). Status lives in
[HANDOFF-CURRENT-WORK.md](HANDOFF-CURRENT-WORK.md). The workspace, commands and rules are also
defined there.

## Acceptance shared by every T1 task

1. The native digest test (`packages/clinic-content/test/native-questionnaire.test.ts:30`,
   `45ece585…a8ae4d352c0617edc24a267b50925686e60a8f`) passes **unedited**.
2. The per-scenario counts in `packages/clinic-api/test/provisional-full-intake.test.ts:325`
   pass **unedited**: `{first-intake:131, pre-visit:24, non-visit:57, post-visit:22, billing:9,
   scheduling:16, refill:20}`.
3. No existing test expectation is edited. The only exception is an import path that moved, and
   the commit message must say so.
4. All six commands in the hub are green.
5. Behaviour is identical. The task is a refactor unless its spec says otherwise.

Import style: packages import each other by relative path with a `.js` suffix, e.g.
`'../../clinic-content/src/workflows.js'`. There are no package aliases. `apps/clinic`
(`tsconfig.clinic.json`) can only see `apps/clinic/src` and `packages/clinic-contract/src`.

---

## T1.1 Workflow registry

**Goal.** One source for the list of workflow (scenario) ids, their patient-facing titles and the
administrative choice labels.

### Create `packages/clinic-content/src/workflows.ts`

```ts
/** Ordered list of clinic workflows. The order is load-bearing (UI order, seed order). */
export const scenarioIds = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'] as const;
export type ScenarioId = typeof scenarioIds[number];
export const isScenarioId = (value: unknown): value is ScenarioId => typeof value === 'string' && (scenarioIds as readonly string[]).includes(value);
/** Patient-facing workflow titles (moved verbatim from clinic-api/src/conversation.ts:22). */
export const scenarioTitles: Readonly<Record<ScenarioId, string>> = { /* copy exactly */ };
```

### Move the choice labels into `packages/clinic-contract/src/index.ts`

The browser can only import from clinic-contract, which stays dependency-free (pure data is
allowed).

```ts
/** Display labels for structured administrative choices. Values not listed display as-is. */
export const administrativeChoiceLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = { /* move verbatim from apps/clinic/src/StaffApp.tsx:289-295 */ };
```

### Replace the duplicates

| File:line | Today | Change to |
|---|---|---|
| `packages/clinic-content/src/types.ts:5` | literal union | `export type { ScenarioId } from './workflows.js';` |
| `packages/clinic-content/src/index.ts` | — | re-export `./workflows.js` |
| `packages/clinical-core/src/domain.ts:8` | `export const scenarios = [...] as const` | `export { scenarioIds as scenarios } from '../../clinic-content/src/workflows.js';` plus a local `import` for use at `submissionSchema`. Keep the exported name `scenarios`. |
| `packages/clinical-core/src/questionnaire-response.ts:223-231` | inline `z.enum([...])` | `z.enum(scenarioIds)` |
| `packages/clinic-api/src/handler.ts:24` | inline `z.enum([...])` | `z.enum(scenarioIds)` |
| `packages/clinic-api/src/conversation.ts:22` | `scenarioTitles` literal | `export { scenarioTitles } from '../../clinic-content/src/workflows.js'` (keep the export; it is imported elsewhere, so check with grep) |
| `packages/clinic-api/src/conversation.ts:23` | flat `choiceLabels` literal | `const choiceLabels: Record<string,string> = Object.assign({}, ...Object.values(administrativeChoiceLabels));` imported from clinic-contract |
| `apps/clinic/src/StaffApp.tsx:289-295` | `administrativeChoiceLabels` literal | import from `'../../../packages/clinic-contract/src/index'` |
| `infra/cloud/vercel/hosted-config.ts:9` | `const scenarios = [...]` | `import { scenarioIds as scenarios } from '../../../packages/clinic-content/src/workflows.js'` (the file already imports clinic-content) |
| `infra/aws/clinic/config.ts:9,17` | literal + explicit `z.object` keys | Import `scenarioIds`. Line 17 becomes `z.object(Object.fromEntries(scenarioIds.map(id => [id, patient])) as Record<ScenarioId, typeof patient>).strict()`. Check it is typechecked: if no tsconfig includes it, leave it and add it to the equality test instead. |
| `scripts/dev/local-mock-clinic.mts:52` | literal array | import `scenarioIds` |

### Do not change (record why in the code comment and the test)

- `packages/clinic-contract/src/index.ts:2` keeps its literal union, because the contract is
  dependency-free.
- `infra/cloud/clinic-manifest.mjs:14` `SCENARIOS` and `infra/local/seed-clinic.mjs:65` are plain
  `.mjs` scripts run directly with node.
- Everything under `scripts/qualification/**`. These are historical qualification evidence
  scripts; editing them changes evidence.

### Tests: create `packages/clinic-content/test/workflows.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { scenarioIds, scenarioTitles, type ScenarioId } from '../src/workflows.js';
import type { ScenarioId as ContractScenarioId } from '../../clinic-contract/src/index.js';
import { scenarios } from '../src/scenarios.js';
// compile-time two-way equality; tsc -p tsconfig.foundation.json fails if they diverge
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const contractMatches: Equal<ScenarioId, ContractScenarioId> = true;
```

Cases:
1. `contractMatches` is `true`. This is a type assertion; also `expect(contractMatches).toBe(true)`.
2. `Object.keys(scenarios)` equals `scenarioIds` in order.
3. Every `scenarios[id].id === id`, and the `workflowId`s are `W01..W07` in order.
4. `Object.keys(scenarioTitles)` equals `scenarioIds`.
5. `infra/cloud/clinic-manifest.mjs` `SCENARIOS` deep-equals `scenarioIds`. Use dynamic
   `await import('../../../infra/cloud/clinic-manifest.mjs')`. If vitest cannot import it
   because of a side effect, read the file as text and match
   `/SCENARIOS = Object.freeze\((\[.*?\])\)/`.
6. `infra/local/seed-clinic.mjs` contains the literal `const scenarios=['first-intake',…]` in
   the same order. Use a text match, because the file has top-level side effects and must not be
   imported.

### Done when

The shared T1 acceptance holds, and `grep -rn "'first-intake', 'pre-visit'" packages apps/clinic/src infra/cloud/vercel scripts/dev` only matches `workflows.ts` and the clinic-contract union.

Commit pathspecs:
- `packages/clinic-content/src/{workflows,types,index}.ts`
- `packages/clinic-contract/src/index.ts`
- `packages/clinical-core/src/{domain,questionnaire-response}.ts`
- `packages/clinic-api/src/{handler,conversation}.ts`
- `apps/clinic/src/StaffApp.tsx`
- `infra/cloud/vercel/hosted-config.ts`
- (`infra/aws/clinic/config.ts`)
- `scripts/dev/local-mock-clinic.mts`
- `packages/clinic-content/test/workflows.test.ts`

**Coordination:** `handler.ts` and `apps/clinic/src/api.ts` carry uncommitted latency (D-d) work.
Start T1.1 only after D-d is committed, because interactive hunk staging is not available.

---

## T1.2 Declarative workflow behaviour

**Goal.** Every `topic.id === 'W0x'` and `d.scenario === 'billing'` branch in the runtime reads a
field on `ScenarioTemplate` instead. A new workflow then needs no runtime code.

### Extend `ScenarioTemplate` (`packages/clinic-content/src/scenarios.ts:8`)

```ts
readonly behaviour?: {
  /** Slot ids (paths in the workflow's own topic) that hold an ISO calendar date YYYY-MM-DD. */
  readonly dateSlotIds?: readonly string[];
  /** Care owners always added to the handoff in addition to `owners` (e.g. medical review of billing/scheduling). */
  readonly alwaysOwners?: readonly ('medical' | 'nutrition')[];
  /** Structured administrative projection. Field set must equal the persisted schema in clinical-core/domain.ts. */
  readonly logistics?: { readonly kind: 'billing' | 'scheduling'; readonly slotIds: readonly string[] };
  /** Opening prompt swap when trusted server context is missing (native mode). */
  readonly contextPrompts?: { readonly slotId: string; readonly verifiedPromptId: string; readonly missingPromptId: string; readonly requires: 'appointment' | 'plan' };
  /** Slots that only trusted server context may fill; never extracted from patient prose. */
  readonly extractionBlockedSlotIds?: readonly string[];
};
```

Values, which must reproduce today's behaviour exactly. The topic id is the workflow id: W02 for
pre-visit, and so on.

| Scenario | `behaviour` |
|---|---|
| pre-visit | `{ contextPrompts: { slotId: 'appointmentContext', verifiedPromptId: 'S01', missingPromptId: 'S01a', requires: 'appointment' }, extractionBlockedSlotIds: ['appointmentContext'] }` |
| post-visit | `{ contextPrompts: { slotId: 'planContext', verifiedPromptId: 'S03', missingPromptId: 'S03a', requires: 'plan' }, extractionBlockedSlotIds: ['planContext'] }` |
| billing | `{ dateSlotIds: ['serviceDate'], alwaysOwners: ['medical'], logistics: { kind: 'billing', slotIds: ['issueType', 'serviceDate', 'requestedResolution'] } }` |
| scheduling | `{ dateSlotIds: ['requestedDate'], alwaysOwners: ['medical'], logistics: { kind: 'scheduling', slotIds: ['intent', 'visitCategory', 'preferredDay', 'preferredWindow', 'requestedDate', 'timezone'] } }` |
| others | omit |

Add a helper in `scenarios.ts`:

```ts
/** The scenario whose own (additional) topic has this id, e.g. 'W05' → billing. */
export function scenarioForWorkflowTopic(topicId: string): ScenarioTemplate | undefined
```

Implement it as a lookup over `scenarios` where `additionalTopics.some(t => t.id === topicId)`.

### Replace the hard-coded sites

| Site | Replace with |
|---|---|
| `clinic-api/src/conversation.ts:152` (S01→S01a / S03→S03a) | `const cp = scenarioForWorkflowTopic(topic.id)?.behaviour?.contextPrompts; const selectedPromptId = native && cp && field.promptIds[0] === cp.verifiedPromptId && !nativeContext(d)?.[cp.requires] ? cp.missingPromptId : field.promptIds[0];` Leave the placeholder fills at `:155-156` as they are; T3.9 generalises them. |
| `clinic-api/src/conversation.ts:343` (W05 serviceDate / W06 requestedDate validation) | `scenarioForWorkflowTopic(c.topic.id)?.behaviour?.dateSlotIds?.includes(c.field.path)` |
| `clinic-api/src/provisional-draft.ts:145` | same predicate on `target.topicId` / `target.path` |
| `clinic-api/src/conversation.ts:380` `['billing','scheduling'].includes(d.scenario) ? ['medical'] : []` | `scenario.behaviour?.alwaysOwners ?? []`, merged into the same `Set` (keep the `d.safety` / `safetyReviewTopics` medical rule as it is) |
| `clinic-api/src/conversation.ts:380` logistics `kind` and `tv.find(topic => topic.id === (d.scenario === 'billing' ? 'W05' : 'W06'))` | `const lg = scenario.behaviour?.logistics; const logistics = { kind: lg?.kind ?? 'other' }; for (const detail of lg ? tv.find(t => t.id === scenario.workflowId)?.details ?? [] : [])`. Today non-admin scenarios iterate W06 details but never emit logistics (`owners.includes('admin')`), so this is behaviour-identical. Confirm that with the existing tests. |
| `clinic-api/src/handoffs.ts:23` `logistics.kind === 'billing' ? 'W05' : 'W06'` | `const template = scenarios[logistics.kind]; const id = template.workflowId; …` |
| `clinic-api/src/adaptive-group-manifest.ts:28-29` W02/W04 forbidden slots | `|| !!scenarioForWorkflowTopic(topic)?.behaviour?.extractionBlockedSlotIds?.includes(definition.id)` |
| `clinic-api/src/dialogue.ts:72-77` per-workflow scoped question copy | **Leave as is.** It is copy, not behaviour, and T2.5 moves it into the pack (`corvo.scopedQuestion`). |
| `clinic-api/src/adaptive-validation.ts:478-484, 829-843` (W07 medication roles, refill `help` projection) | **Leave as is.** It is refill-specific evidence logic, documented as a known residual in T2.5 (`corvo.projectionRule` named-rule registry). |
| `clinical-core/src/domain.ts:36-39` billing/scheduling field allow-lists | **Do not derive** from content. The persisted submission schema must stay byte-stable. Add a test (below) asserting equality with `behaviour.logistics.slotIds` instead. |

### `completion` and `contextRequirement` are visible to staff

- `clinic-contract/src/index.ts` `StaffHandoffView` gains `workflow?: { completion: string; contextRequirement: string }`. It is optional, so older clients are unaffected.
- `clinic-api/src/handoffs.ts`: wherever `StaffHandoffView` is built, add
  `workflow: { completion: scenarios[v.scenario].completion, contextRequirement: scenarios[v.scenario].contextRequirement }`.
- `apps/clinic/src/StaffApp.tsx`: in the handoff detail, render a collapsed `<details>` labelled
  "About this workflow" with two `<p>`s ("What counts as done", "Context this workflow expects").
  Use the existing `metadata` class. There are no new styles.
- Tests:
  - an existing handoffs test file in `packages/clinic-api/test/` (grep `StaffHandoffView`)
    asserts `workflow.completion === scenarios['billing'].completion`;
  - `apps/clinic/test/` gets a render test only if a StaffApp render test already exists. If not,
    check visually during D-e.

### Tests: append to `packages/clinic-content/test/workflows.test.ts`

1. For billing and scheduling, `behaviour.logistics.slotIds` equals the field arrays inside
   `administrativeLogisticsSchema`'s `superRefine`. Export those two arrays from `domain.ts` as
   `billingLogisticsFields` / `schedulingLogisticsFields`; that move is behaviour-neutral.
2. Every `behaviour.dateSlotIds` / `extractionBlockedSlotIds` / `contextPrompts.slotId` names a
   slot that exists on that scenario's additional topic.
3. Every `contextPrompts.{verified,missing}PromptId` exists in `register.promptsById` (use
   `createClinicContent()` from `register.ts`).
4. `scenarioForWorkflowTopic('W05')?.id === 'billing'`, and the same for `'Q04'` returns
   `undefined`.

### Done when

- The shared T1 acceptance holds.
- `grep -nE "topic\.id === 'W0[2-6]'|\['billing', 'scheduling'\]\.includes" packages/clinic-api/src` returns nothing.
- `grep -n "=== 'W0[2-6]'" packages/clinic-api/src/{conversation,provisional-draft,handoffs,adaptive-group-manifest}.ts` is empty.

---

## T1.3 PHQ-4 coding only for the locked block

**Bug.** `packages/clinical-core/src/questionnaire-response.ts:~955` `scalarAnswer` returns
`valueCoding { system: 'urn:corvo:phq4-response', display: PHQ labels }` for **any** numeric
`choice` slot. The first non-PHQ numeric choice item would be mislabeled in FHIR.

**Fix.**
- Emit the PHQ coding only when the slot id matches `/^MH0[1-4]$/` and the topic is `Q16`. Use
  the same predicate as `conversation.ts:157`, exported as
  `isPhq4ItemSlot(topicId, slotId)` from `packages/clinic-content/src/mental-health.ts` (already added by the T1.3 WIP, with `PHQ4_TOPIC_ID`, `PHQ4_ITEM_IDS` and `PHQ4_RESPONSE_SYSTEM`).
- Any other numeric choice gets `{ valueInteger: value }`.
- Do not change string or boolean paths.

**Tests** in `packages/clinical-core/test/questionnaire-response.test.ts`:
1. The existing golden QuestionnaireResponse output is byte-identical (the existing tests pass
   unedited).
2. A new case: a synthetic topic `ZZ` with a `choice` slot `score` (`choices: [0, 1, 2]`) answered
   `1` serialises to `valueInteger: 1`, with no `urn:corvo:phq4-response`.

If the synthetic topic cannot pass the native definition validation, test `scalarAnswer` directly
by exporting it as `/** @internal */`.

---

## T1.4 Coverage (tests only)

New bugs are recorded as `it.fails` with a `// BUG:` comment and added to the hub bug table.
Never edit runtime code in T1.4.

### T1.4a Guided walk tests: `packages/clinic-api/test/guided-workflows.test.ts`

For each of `pre-visit, non-visit, post-visit, billing, scheduling, refill`, and for both
`nativeContext` present and absent where the workflow has `contextPrompts`:

1. Create a session via the handler, following an existing guided test such as
   `grep -ln "conversation: { mode: 'guided'" packages/clinic-api/test`.
2. Answer each displayed prompt with a fixed synthetic answer appropriate to the slot kind:
   - text: "Synthetic answer";
   - choice: the first choice;
   - date slots: `2026-11-03`.
3. Do this until `prompt` is undefined, with at most 60 turns as a loop guard.
4. Then request review and confirm.

Assert:
- no thrown `ApiFailure`;
- the review lists every slot of the workflow topic as answered;
- the confirmed submission's `work` owners equal the expected set (pre-visit with no context
  includes admin);
- billing and scheduling include `administrativeLogistics` with the answered fields.

Settle the open question: does `W02.followup.1` (which has `[previously reported item]` and
`[date]` placeholders and is gated on `context.pre-visit`) throw `prompt-rule-inactive` or show
unfilled brackets without `nativeContext`?
- Assert the patient-visible prompt text never contains `[`.
- If it does, mark it `it.fails` with `// BUG: unfilled placeholder in W02.followup.1` and add it
  to the bug table. T3.9 owns the fix.

### T1.4b Voice-mode tests: `packages/clinic-api/test/workflow-voice.test.ts`

Follow the existing first-intake voice tests (`grep -ln "confirmed-transcript" packages/clinic-api/test`). For billing and scheduling:
- a spoken exact choice ("a bill question", "Tuesday") produces the choice confirmation flow
  (`exactSpokenChoice` / `exactChoiceConfirmation` from `clinic-contract/src/choice-voice.ts`);
- confirming records the choice with `channel: 'confirmed-transcript'`;
- an `unreviewed-transcript` source never satisfies a choice slot.

For non-visit, a spoken PHQ answer such as "several days" during Q16 MH01–04 is **not** recorded,
because PHQ is buttons-only.

---

## Haiku implementation notes

Each T1 task is sized for one Haiku 5.5 agent. Give the agent:
- this file's section;
- the hub's rules and commands;
- the instruction: "Do not commit; report the diff summary and test results."

The Opus orchestrator reviews, then commits with explicit pathspecs.
