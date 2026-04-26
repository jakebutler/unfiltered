# lib/ai

LLM clients that route through Cloudflare AI Gateway for caching, observability, and graceful fallback.

Wired in Phase 1 (GLM, OpenAI for guide creator + bot text mode) and Phase 2 (Gemini Flash/Pro for vision).

Expected files (added as features land):
- `gateway.ts` — base AI Gateway client (URL builder, header handling)
- `glm.ts` — GLM (Z.ai/Fireworks) chat completions
- `openai.ts` — OpenAI (chat + tts)
- `gemini.ts` — Gemini Flash + Pro (vision + reasoning)
- `claude.ts` — Claude Sonnet (cross-session synthesis)
