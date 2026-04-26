# lib/prompts

System prompts for the bot, the guide creator, the persona LLM, and each analyzer stage.

Reference material in `legacy-prompt-specs/` (V1 prompts) — these are inspiration, not direct ports.

Expected files (added as features land):
- `bot-interviewer.ts` — bot's system prompt (single agent + tool calls)
- `guide-creator.ts` — chat agent system prompt + tool definitions
- `persona.ts` — synthetic persona system prompt
- `analyzer/camera-signal.ts` — Gemini Flash camera-frame classification
- `analyzer/screen-signal.ts` — Gemini Flash screen-frame analysis
- `analyzer/friction-extraction.ts` — friction moment extraction (multimodal cross-reference)
- `analyzer/quote-extraction.ts`
- `analyzer/theme-synthesis.ts`
- `analyzer/finding-generation.ts`
- `analyzer/cross-session.ts` — Claude Sonnet study-wide synthesis
