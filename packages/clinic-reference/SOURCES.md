# Reference data sources (synthetic clinic-intake demo)

Built by `scripts/reference/build-reference.mjs`, which writes `src/*.generated.ts`. Downloads are cached in `.cache/reference/`, which is gitignored. Lookups run offline in the server process, and no patient text is sent to any of these services.

## RxNorm Current Prescribable Content: `src/medications.generated.ts`

- Release: 2026-10-05. File: https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_10052026.zip
- Terms: https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html says NLM "provides this subset without any licensing restrictions", and the license table reads "No license required; public domain".
- Used: unsuppressed RXNORM names with TTY IN, PIN, MIN or BN. Brands are kept only when RXNREL links them to an ingredient (`has_tradename`/`tradename_of`, falling back to `precise_ingredient_of`/`has_precise_ingredient`). Names over 120 characters are dropped.
- Not used:
  - drug classes, because WHO ATC names carry redistribution limits and the plan needs no class-based variants (D6);
  - SNOMED CT;
  - anything requiring a UMLS licence.
- Attribution, required by NLM and repeated in each generated file: "This product uses publicly available data from the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product."

## Condition terms: `authored/condition-terms.json` → `src/conditions.generated.ts`

- The names and everyday synonyms are authored for this demo and are our own content.
- Each code is checked against the CMS ICD-10-CM FY2027 tabular order file: https://www.cms.gov/files/zip/2027-code-descriptions-tabular-order.zip. The build fails if a code is missing from it, and it attaches the CMS short description.
- ICD-10-CM is maintained by CDC/NCHS and distributed by CMS. In the UMLS it is a restriction-level-0 source, meaning no additional restrictions. We redistribute only the codes and short descriptions of the terms we authored.
- The Clinical Tables conditions list was evaluated and not used. Its dataset terms (a Regenstrief derivative) give no explicit redistribution grant for a public repository.

## Rules of use

- A code is attached only to an exact name or authored-synonym match of the patient's own words, or to a spelling the patient confirmed.
- A close spelling is only offered to the patient as a question.
- The patient's words are always kept verbatim. The deterministic rules in `packages/clinic-content/src/specificity.ts` decide whether an answer counts as specific. A lookup affects that in one way only: an exact name or authored synonym in the patient's own words makes a name answer specific ("asthma problems" names asthma). A close spelling counts as specific for grading, because the patient is then asked to confirm it; no code attaches unless they say yes.
- Names that normalize to the same text but carry different codes (stereoisomers such as "limonene, (-)-" and "limonene, (+)-") keep the plain-name row; with no plain-name row, the name is ambiguous and is never coded.
- This is a synthetic demo, not a medical device, and it makes no clinical decision support claims.
