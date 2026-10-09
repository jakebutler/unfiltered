# Corvo product design contract

This records the visual direction and screen structure already approved by Jake in `docs/rebuild/design/EXPERIENCE.md` in the primary discovery checkout. It is an implementation contract, not a claim of rendered verification. The approved conversation and confirmation wireframes establish the structure; implementation proceeds directly from them without reopening identity or concept selection.

## Identity

Body and controls: self-hosted Inter. Product names and short headings: self-hosted Space Grotesk. Existing Corvo brand evidence is recorded in the discovery grounding document. Do not invent a new logo or use the white-backed wordmark on a dark field.

| Token | Value | Purpose |
| --- | --- | --- |
| Ink | #1A1A1A | Main text and primary clinical action |
| Surface | #FFFFFF | Content |
| Surround | #FAFAFA | Page and quiet toolbar |
| Secondary ink | #525252 | Supporting labels |
| Accent | #FF6B47 | Small brand fields and active markers; dark text |
| Active/link ink | #993319 | Accessible coral text |
| Control border | #71717A | Required visible boundaries |
| Rule | #E5E5E5 | Decorative separation |
| Focus | #0B62D6 | Visible outline with white separation |

Use 16/24px body and inputs, 14/20px metadata, 18/26px current question, 24/30px page titles, and 32/38px welcome/report titles. Use an 8px spacing rhythm, 8px controls and 12px purposeful groups. Do not surround every fact with a card. Status combines a literal label and optional icon; color alone is insufficient.

## Clinic surfaces

Mode: Operate. The first viewport puts the patient's current question or staff's current work ahead of product explanation. A compact Corvo Clinic identity and synthetic-demo notice frame the actual task.

Patient desktop: readable conversation column (640–720px), with a quiet topic/answer outline where space permits. Mobile: one column, composer remains usable with the keyboard, and answer review is one deliberate action away. No completion percentage or promised duration before measured evidence.

Staff desktop: work list beside a handoff workspace. The signature interaction is selecting a summarized answer to inspect its exact source without losing context. Review status and role-attributed actions are visible separately from EHR receipt. An RD can inspect the full assigned intake; the action list still respects responsibility.

## Interaction and state

The patient can correct answers, stop a topic, save and leave, inspect sources, and explicitly confirm a version. Required missing measurements keep intake partial. Delivery timeout shows a status-check action, not a second submission. Corrections after delivery produce an amendment.

Voice continues the same conversation with text available. Show actual microphone, transcription and playback states. Reduced motion removes decorative transitions; normal transitions last about 150–200ms and explain a change rather than decorate waiting.

Every shipped control must perform its named action. No simulated receipt, disabled primary route or browser-only save may be presented as a working integration. Rendered desktop/mobile and independent design review follow each complete user-visible slice.
