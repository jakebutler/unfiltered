# T2: questionnaire pack format, compiler and FHIR export

Parent: [PLAN-QUESTIONNAIRE-TEMPLATE.md](PLAN-QUESTIONNAIRE-TEMPLATE.md). Status lives in
[HANDOFF-CURRENT-WORK.md](HANDOFF-CURRENT-WORK.md). Start T2 only after T1.2 is `done`.

## Why, and the pattern we copy

Today's content is already *mostly* data:
- `content.ts` holds `topicText`, `promptText` and `supplementalPromptText` as JSON-like arrays
  transcribed from `docs/rebuild/design/CLINICAL-CONTENT.md`;
- `slots.ts` holds `coreSlots` and `mentalHealthSlots`;
- `branches.ts` holds `conditionBranches`;
- `scenarios.ts` holds `scenarios`.

They are assembled in code by `createClinicContent()` (`register.ts:31`). A pack is the
JSON-serialised union of those pieces plus a compiler that rebuilds the exact same
`ClinicContent`. This is the standard content-as-data pattern: a declarative source, a validating
compiler, and golden parity tests, as in SDC `$assemble`, LHC-Forms and SurveyJS JSON. Field names
mirror FHIR R4 `Questionnaire.item` where a FHIR concept exists. Corvo-only semantics live under a
`corvo` key.

**Invariant for all of T2.** For adult-intake, `compilePack(adultIntakePack, { mentalHealth })`
deep-equals `createClinicContent({ mentalHealth })` for `phq4`, `unscored` and `pending`. The
native digest therefore cannot change. If parity cannot be reached for some field, stop and
record it in the hub. Never change runtime content to make parity pass.

---

## T2.5 Pack schema: `packages/clinic-content/src/pack.ts`

zod schema plus inferred types. No runtime consumers yet.

```ts
export const PACK_SCHEMA_VERSION = 1 as const;
const wordingStatus = z.enum(['retained-approved-plan', 'accepted-user-direction', 'proposed-detail', 'locked-instrument']);
// Reject 'approved' or anything not listed: a pack can never self-approve wording.

const answerOption = z.object({ value: z.union([z.string(), z.number(), z.boolean()]), display: z.string().optional() }).strict();
const enableWhen = z.object({ question: z.string(), operator: z.enum(['positive', 'estimate-needed', 'uncertain']), alsoWhenTrue: z.string().optional(), orQuestions: z.array(z.string()).optional() }).strict();

const item: z.ZodType<PackItem> = z.lazy(() => z.object({
  linkId: z.string(),                       // SlotDefinition.id
  text: z.string(),                         // SlotDefinition.label
  type: z.enum(['text', 'positive-number', 'height-value', 'choice', 'presence', 'collection', 'configuration']), // SlotDefinition.kind (kept verbatim; FHIR type mapping happens in T2.7)
  required: z.boolean().optional(),         // inverse of SlotDefinition.optional
  answerOption: z.array(answerOption).optional(),
  enableWhen: enableWhen.optional(),
  item: z.array(item).optional(),           // SlotDefinition.fields
  corvo: z.object({ promptIds: z.array(z.string()), acceptsNegative: z.boolean().optional(), acceptsNotApplicable: z.boolean().optional(), acceptsUncertain: z.boolean().optional(), extractionNegativeScope: z.literal('composite').optional() }).strict(),
}).strict());

const topic = z.object({
  linkId: z.string(), openingPromptId: z.string(), presentation: z.enum(['R', 'R-value', 'O', 'C']),
  minimumDetailText: z.string(), stopWhen: z.array(z.enum([...stop reasons])), item: z.array(item),
  corvo: z.object({ wordingVersion: z.number().int().optional(), wordingStatus, purpose: z.string().optional(), branchAndClarification: z.string().optional(), workAccountability: z.string().optional(), scopedQuestions: z.record(z.string()).optional() }).strict(),
}).strict();

// Preserve the existing PHQ-4 stem/item status without changing source content.
// accepted-targeted-choice is accepted only on the exact retained locked prompts.
const promptStatus = z.enum([...wordingStatus.options, 'accepted-targeted-choice']);
const prompt = z.object({ id: z.string(), text: z.string(), origin: z.string(), wordingStatus: promptStatus }).strict();

const lockedInstrument = z.object({
  id: z.literal('phq4'), topicLinkId: z.string(), itemLinkIds: z.array(z.string()),
  attribution: z.string(), presentation: z.literal('buttons-only'), freeTextAnswerable: z.literal(false),
}).strict();

/** Branch applicability is a NAMED rule from a closed registry, never inline code. */
export const branchRuleIds = ['diabetes-explicit-status', 'slot-positive'] as const;
const branch = z.object({ id: z.string(), topic, trigger: z.string(), rule: /* optional strict discriminated union; slot-positive requires slot */ branchRule.optional(), /* exact remaining conditionBranches metadata fields */ }).strict();

const workflow = z.object({ /* exact ScenarioTemplate fields incl. behaviour (T1.2) */ }).strict();

export const questionnairePackSchema = z.object({
  schemaVersion: z.literal(PACK_SCHEMA_VERSION),
  id: z.string(), url: z.string().url(), version: z.string(), title: z.string(),
  provenance: z.record(z.unknown()),              // documentProvenance verbatim
  prompts: z.array(prompt), topics: z.array(topic), branches: z.array(branch),
  workflows: z.array(workflow), lockedInstruments: z.array(lockedInstrument),
  mentalHealth: z.object({
    options: z.object({ /* optional pending/phq4/unscored mentalHealthOptions entries, verbatim */ }).strict(),
    slots: z.object({ /* optional phq4/unscored arrays of pack items, from mentalHealthSlots */ }).strict(),
  }).strict(),
}).strict().superRefine(crossReferenceChecks);
export type QuestionnairePack = z.infer<typeof questionnairePackSchema>;
```

`crossReferenceChecks` adds a zod issue for each of these:
- a duplicate topic or prompt id;
- every `promptIds`, `openingPromptId` and workflow `openingPromptId`/`missingContextPromptId`
  must exist in `prompts`;
- every `enableWhen.question` must be a sibling linkId;
- every workflow's `reusableTopicIds` must exist in `topics`;
- every locked instrument's item ids must exist under its topic. **Any pack that defines items
  with ids in `itemLinkIds` outside the locked instrument, or alters their text or answerOption,
  fails.** The PHQ-4 stem, items and choices are compared against `mental-health.ts` and
  `mentalHealthOptions.phq4` constants.

The variant slots are logically children of Q16. Validate each variant together with the base
Q16 item list so compilation cannot introduce duplicate sibling ids. The strict schemas retain
all current authoring metadata, including optional branch facts/slots and T1.2 workflow behaviour.
The existing source's `accepted-targeted-choice` PHQ prompt status must survive export/compile
verbatim; the four-status sketch above was incomplete. It does not authorize new wording.

Named-rule registry in `packages/clinic-content/src/pack-rules.ts`:

```ts
export const branchRules = {
  'diabetes-explicit-status': (answers, evidence) => diabetesBranchApplicability(answers, evidence) === 'applicable',
  'slot-positive': (answers, evidence, slot) => /* the positive() helper from scenarios.ts:52 */,
} as const;
```

`scenarioTopics` (`scenarios.ts:44`) and `nativeScenarioTopics` (`native-questionnaire.ts:~1090`)
are refactored to iterate `register.branches` and use `branchRules[rule.id]`. The native adapter
also retains its existing source-qualified context, reviewed-fact and tri-state decisions;
the simpler boolean rules must not discard those published behaviours. Today they
hard-code diabetes, sleepApnea and digestive in a fixed order. Keep the push order identical:
diabetes, sleepApnea, digestive. `otherCondition` has no automatic rule today; give it no `rule`
(`rule` is optional), so it is never auto-pushed.

**Residual code-level rules** (documented, not moved, in a comment block in `pack.ts`):
- W07 medication label/actual role checks (`adaptive-validation.ts:478-484`);
- the refill `help` projection (`:829-843`);
- the billing phrase synonyms (`:548`);
- per-workflow scoped question copy (`packages/clinic-api/src/dialogue.ts`). This one is moved: add
  `corvo.scopedQuestions: Record<slotId, string>` on the workflow topic and have `dialogue.ts`
  read it. The parity test covers it. This dialogue-only metadata is excluded from both native
  topic serialization sites (definition payload and FHIR topic extension), preserving the
  published native definition and digest.

Tests (`packages/clinic-content/test/pack.test.ts`):
1. A minimal valid pack parses.
2. Each cross-reference check rejects a crafted bad pack with the expected issue path.
3. `wordingStatus: 'approved'` is rejected.
4. A pack that rewords `MH01` or adds a fifth PHQ choice is rejected.
5. `branchRuleIds` is closed: `rule.id: 'custom-js'` is rejected.

---

## T2.6 Compiler, exporter and parity

### `packages/clinic-content/src/pack-compile.ts`

```ts
export function compilePack(pack: QuestionnairePack, configuration: { mentalHealth: MentalHealthChoice }): ClinicContent
```

- It must return **exactly** what `createClinicContent(configuration)` returns today: the same
  keys, the same `as const` shapes and the same array order. Each step is the inverse of the
  exporter.
- `ClinicContent` remains `ReturnType<typeof createClinicContent>` and `compilePack` returns
  that type. At switchover, annotate `createClinicContent` with the explicit legacy
  `ClinicContentDefinition` shape to break recursive return-type inference across the wrapper
  and compiler. That shape retains the existing readonly fields and authoring constant types.
- The compiler validates input, preserves optional property presence and array order, and
  accepts PHQ items either in the `mentalHealth.slots.phq4` variant or directly under Q16.
  Direct PHQ declarations require the canonical locked order. Selecting another mode replaces
  direct PHQ slots; merged duplicate IDs or references to removed slots fail closed.

### `scripts/dev/export-intake-pack.mts`

Run as `npx tsx scripts/dev/export-intake-pack.mts`. It imports `topicText`, `promptText`,
`supplementalPromptText`, `coreSlots`, `mentalHealthSlots`, `conditionBranches`, `scenarios`,
`documentProvenance` and `mentalHealthOptions`, maps them to the pack schema, validates them, and
writes `packages/clinic-content/packs/adult-intake.pack.json` (stable key order, 2-space indent,
trailing newline). Running it twice produces a byte-identical file.

### Load the pack in TS without `import.meta` or JSON imports

The foundation build is CommonJS-style with no `resolveJsonModule`. Generate
`packages/clinic-content/src/packs/adult-intake.ts` with
`export const adultIntakePack = { ... } as const satisfies QuestionnairePack;`. The exporter
writes the `.json` and also this `.ts` mirror. A test asserts the two are identical.

### Parity test (`packages/clinic-content/test/pack-parity.test.ts`)

1. For each `mentalHealth` in `['phq4', 'unscored', 'pending']`, both
   `compilePack(questionnairePackSchema.parse(adultIntakePack), { mentalHealth })` and
   `createClinicContent({ mentalHealth })` strictly equal `createAuthoredClinicContent({ mentalHealth })`.
   The independent oracle retains the former assembly in `scripts/dev/export-intake-pack.mts`
   and imports authoring modules directly; it never calls the wrapper or compiler.
2. The native digest of the compiled content equals the pinned digest
   (`45ece585…60a8f`). A test-only mock supplies compiled content to the unchanged native
   publisher's register factory, then calls `getNativeQuestionnaireDefinition` and verifies
   the factory was used. Existing native digest/count tests remain unedited.
3. Running the exporter in-process, converting its output to JSON and comparing it with the
   committed `.json` gives equality. This drift guard fails if someone edits `content.ts` without
   re-exporting.

### Switch over (separate commit, after parity is green)

- `register.ts`'s `createClinicContent` becomes `return compilePack(adultIntakePack, configuration)`,
  and the old assembly code moves into the exporter's independent
  `createAuthoredClinicContent` function. Runtime code does not import the `.mts` exporter.
- Pure shared constants live in `packages/clinic-content/src/content-constants.ts` and remain
  re-exported by `register.ts`; schema/compiler imports avoid a runtime cycle through the wrapper.
- `content.ts` / `slots.ts` / `branches.ts` / `scenarios.ts` stay as the **authoring source**
  for adult-intake until the owner decides to make the JSON canonical. Note that decision in the
  hub as an owner decision. Do not delete them.
- Acceptance: all six commands are green, and the digest and counts tests are unedited.

---

## T2.7 FHIR R4 export for new packs

`packages/clinic-content/src/pack-fhir.ts`:

```ts
export function packToFhirQuestionnaire(pack: QuestionnairePack, workflowId: string): Questionnaire // @medplum/fhirtypes
```

Mapping:

| Pack | FHIR `Questionnaire.item` |
|---|---|
| topic | `type: 'group'`, `linkId = topic.linkId`, `text` = opening prompt text |
| `type: 'text'` | `string` |
| `positive-number` | `decimal` with `minValue` extension `0` (exclusive is noted in `corvo` ext) |
| `height-value` | `group` of `decimal` feet/inches/cm per today's native builder (mirror `native-questionnaire.ts`) |
| `choice` | `choice` + `answerOption.valueString` / `valueInteger` / `valueBoolean` |
| `presence` | `boolean` |
| `collection` | `group` + `repeats: true` |
| `configuration` | omitted |
| `required` | `required` |
| `enableWhen` | `enableWhen` with `operator: 'exists'` or `'='` as the condition requires; `enableBehavior: 'any'` when `orQuestions` |
| locked instrument | `item.code = [{ system: 'http://loinc.org', code: '69724-3' }]` (believed to be the PHQ-4 panel; **verify against loinc.org before use**) on the group, and `readOnly` wording via the `corvo` extension; `answerOption.valueCoding.system = 'urn:corvo:phq4-response'` |
| `corvo.*` | `extension: [{ url: 'https://corvo.example/fhir/StructureDefinition/<name>', value… }]` |

- `Questionnaire.url = pack.url + '/' + workflowId`, `version = pack.version`,
  `status = 'draft'`, `title`.
- **Do not** use this for adult-intake. The published native questionnaire keeps
  `native-questionnaire.ts` until a planned re-qualification.

Tests (`packages/clinic-content/test/pack-fhir.test.ts`):
- structural validity via Medplum's validator. Check
  `node_modules/@medplum/core` for `validateResource`. If it is unavailable offline, assert the
  required fields and linkId uniqueness by hand;
- every pack slot appears exactly once;
- PHQ items carry the coding;
- enableWhen references resolve.
