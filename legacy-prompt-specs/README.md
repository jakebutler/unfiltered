# Legacy prompt specs and docs (V1 reference)

These files describe the V1 implementation of Unfiltered. They are preserved for reference because the prompt-engineering thinking inside them remains useful for the V2 rebuild — particularly:

- `behavioral-friction-signal-research.md` — research underpinning the friction-detection approach; informs analyzer prompts
- `camera-engagement-classifier.md` — original MiniMax-based camera classifier; informs the V2 Gemini Flash camera-signal prompt
- `decide-engine-policy-b-prompt.md` and `determinstic-decide-policy.md` — V1 decide-engine reasoning; informs V2 single-agent system prompt and tool-call discipline
- `multimodal-cross-reference-explainer.md` — V2 candidate (deferred); promote to live spec when implementing real-time cross-reference
- `post-session-candidate-finding-labeler.md` — informs analyzer's friction-extraction and finding-generation stages
- `DEPRECATED-spec.md` — original product spec; superseded by `docs/v2-architecture-spec.md`
- `legacy-docs/` — archived V1 docs (`spec.md`, `techspec.md`, `projectstatus.md`, `changelog.md`, plans, feature docs)

The canonical reference for V2 is `docs/v2-architecture-spec.md` at the repo root.
