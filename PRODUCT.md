# Unfiltered

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Corvo Labs' operator conducts research for separate clients. Participants complete interviews; clients read deliberately published reports and specifically shared sources. Separately deployed clinics have patients, assigned clinical care teams including registered dietitians, and administrative staff.

The flagship demonstration follows an adult synthetic patient before a booked first telehealth medical weight-loss visit at the fictional Corvo Clinic. Jake evaluates it as a forward-deployed product manager demonstrating delivery to AI-focused companies.

## Product Purpose

Turn a natural text or voice conversation into an accurate, inspectable handoff. A patient confirms their answers, staff sees their source statements, and later corrections preserve the earlier record. Research findings similarly resolve to their evidence and an explicit publication choice.

## Operating Context

The clinic supports first intake, pre-visit check-in, non-visit check-in, post-visit follow-up, billing assistance, scheduling assistance, and prescription-refill requests. All are required for the first full user test. Administrative completion is a staff-recorded outcome, never an invented payment, booking, or prescription.

Research supports project goals/scripts, prototype context, actual browser recording, instrumented DOM capture on controlled prototypes, private analysis, and password-protected client access. Ordinary third-party sites use screen capture, not invented DOM access.

## Capabilities and Constraints

- Text and voice continue one browser conversation on mobile and desktop. No telephone integration is required.
- Medplum is the clinical data authority. Full intake and sources are visible to every assigned clinical member, including RDs; that visibility does not grant medical decision authority. Administrative access is limited to logistics.
- Each intake section has minimum useful detail and gentle directed follow-ups. Resistance stops probing. Unknown, declined, negative, uncertain and unasked answers remain distinct.
- Height, last actual weight with units/date, and the required measurement context are necessary for a complete intake. Estimates remain separately labeled. An explicit partial handoff preserves missing values without fabricating answers.
- DigitalOcean hosts reasoning and vision; OpenAI, Anthropic and Arcee models are excluded. Existing speech providers are allowed. Credits come first; at most $25 extra project spend is a last resort after reasonable credit options are exhausted.
- Free hosting is the synthetic-demo target. A reproducible AWS package is locally validated; this delivery does not authorize real PHI or claim HIPAA compliance.
- The approved architecture uses separate static React clinic and research apps with a shared fetch-based API boundary. Convex is preferred for research, Medplum for clinical data, and protected object storage for research media.
- Jake explicitly selected the sourced PHQ-4 configuration with clinician review on October 9: exact items/options, complete-only scoring, and human follow-up. Other newly authored clinical details retain their recorded review status.

## Brand Commitments

Preserve Corvo Labs' identity and the approved restrained, direct product voice. Patient screens are calm and practical. Staff tools support work and evidence inspection. Neither experience should read as a generic AI chatbot or marketing landing page.

## Evidence on Hand

Jake approved the design proposal on October 9, 2026 with seven intake revisions. The source planning documents remain in the primary checkout at `/Volumes/rexy/GitHub/unfiltered/docs/rebuild/design/`; `APPROVAL.md` records authority, `EXPERIENCE.md` records approved screen structure and brand direction, and `CLINICAL-CONTENT.md` CC-0.2 contains the revised content. These files describe intended behavior, not proof that the app is complete.

Technical qualification is underway in this isolated worktree. Synthetic fixtures must be labeled. No real clinic, treatment outcome, live provider quality, or production deployment may be fabricated.

## Product Principles

1. An answer and its source stay connected.
2. Saving, confirming, delivery, review and external action mean different things.
3. Shared clinical context supports the whole assigned care team; action authority remains specific.
4. Recover uncertainty without duplicate work or invented certainty.
5. Complete each requested workflow and verify it before declaring the product ready.

## Accessibility & Inclusion

Keyboard and screen-reader operation, visible focus, readable contrast, responsive reflow, reduced motion, and a persistent text alternative are required. Voice must never be the only route to information or confirmation. Patient intake asks for microphone permission only when voice is selected; it does not request camera or screen access.
