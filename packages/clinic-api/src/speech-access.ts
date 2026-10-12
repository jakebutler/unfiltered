import { z } from 'zod';
import { choiceConfirmationSpeech } from '../../clinic-contract/src/choice-voice.js';
import { cookies } from './cookies.js';
import { conversation } from './conversation.js';
import { readDraft } from './store.js';
import { requireNoPendingInterpretation } from './adaptive-session.js';
import { streamSpeechScopeDigest } from './adaptive-stream-session.js';
import { ApiFailure, type ClinicApiConfig } from './types.js';
import type { Runtime } from './runtime.js';
import { conversationSpeech, type ScenarioId } from '../../clinic-contract/src/index.js';
import type { SpeechOutputRequest, SpeechTurnScope } from '../../speech/src/contracts.js';

export const speechInputPath = '/api/clinic/speech/input';
export const speechOutputPath = '/api/clinic/speech/output';
export const speechTranscriptionPath = '/api/clinic/speech/transcriptions';
const common = { requestId: z.string().uuid(), sessionId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() };
export const speechStartSchema = z.object({ ...common, type: z.literal('start'), promptId: z.string().min(1).max(300) }).strict();
export const speechOutputSchema = z.object({ ...common, sourceId: z.string().min(1).max(300), choiceConfirmation: z.object({ value: z.string().min(1).max(300) }).strict().optional() }).strict();

/** Verified current clinic scope, never a caller-selected FHIR resource or provider text. */
export function createSpeechAccess(config: ClinicApiConfig, options: { runtime(): Promise<Runtime>; enabled: boolean; adaptiveAvailable: boolean }) {
  const origin = new URL(config.origin).origin;
  if (origin !== config.origin) throw new Error('clinic-origin-must-be-origin');
  const jar = cookies(config.cookieSecret, origin.startsWith('https:')), content = conversation(config);
  async function authenticate(request: Request) {
    if (!options.enabled) throw new ApiFailure('speech-unavailable', 503);
    if (request.headers.get('origin') !== origin) throw new ApiFailure('origin-denied', 403);
    const claims = await jar.read(request, 'clinic_patient');
    if (claims.kind !== 'patient' || !Object.hasOwn(config.patients, claims.scenario)
      || config.patients[claims.scenario as ScenarioId].reference !== claims.patient) throw new ApiFailure('session-scope-denied', 403);
    if (!claims.identityConfirmed) throw new ApiFailure('identity-confirmation-required', 403);
    return claims;
  }
  async function current(request: Request, scope: { sessionId: string; expectedRevision: number }) {
    const claims = await authenticate(request);
    if (scope.sessionId !== claims.sessionId) throw new ApiFailure('session-scope-denied', 403);
    const { draft } = await readDraft((await options.runtime()).client, claims.sessionId, claims.patient);
    if (draft.scenario !== claims.scenario || draft.id !== claims.sessionId) throw new ApiFailure('session-scope-denied', 403);
    if (draft.phase !== 'conversation' || draft.safety?.paused) throw new ApiFailure('speech-conversation-required', 409);
    const active = draft.adaptive?.activeOperationId && draft.adaptive.operations[draft.adaptive.activeOperationId];
    const savedReply = active && active.stream?.reply === 'saved' && active.stream.replyScope;
    if (draft.revision !== scope.expectedRevision && !(savedReply && savedReply.revision === scope.expectedRevision
      && draft.revision > scope.expectedRevision && savedReply.sha256 === streamSpeechScopeDigest(draft))) throw new ApiFailure('stale-session', 409);
    // Only a durably saved early question can authorize speech while its tail
    // is pending. Accepted/queued/unsaved operations still deny speech.
    requireNoPendingInterpretation(draft, !!savedReply);
    return { ...content.view(draft, true, options.adaptiveAvailable), revision: scope.expectedRevision };
  }
  return {
    authenticate,
    async capture(request: Request, input: SpeechTurnScope) {
      const parsed = speechStartSchema.safeParse({ type: 'start', ...input });
      if (!parsed.success) throw new ApiFailure('invalid-speech-request');
      const view = await current(request, input);
      if (!view.currentPrompt || view.currentPrompt.id !== input.promptId) throw new ApiFailure('stale-prompt', 409);
      return { sessionId: view.id, promptId: view.currentPrompt.id, revision: view.revision };
    },
    /** Push-to-talk transcription only fills the patient's unsent answer box, so a question that changed during
     * recording does not invalidate it; the session must still be the patient's own, open and not paused. */
    async upload(request: Request, input: SpeechTurnScope) {
      if (!speechStartSchema.safeParse({ type: 'start', ...input }).success) throw new ApiFailure('invalid-speech-request');
      const claims = await authenticate(request);
      if (input.sessionId !== claims.sessionId) throw new ApiFailure('session-scope-denied', 403);
      const { draft } = await readDraft((await options.runtime()).client, claims.sessionId, claims.patient);
      if (draft.scenario !== claims.scenario || draft.id !== claims.sessionId) throw new ApiFailure('session-scope-denied', 403);
      if (draft.phase !== 'conversation' || draft.safety?.paused || draft.confirmed) throw new ApiFailure('speech-conversation-required', 409);
      return { sessionId: draft.id, promptId: input.promptId, revision: draft.revision };
    },
    async output(request: Request, input: SpeechOutputRequest) {
      if (!speechOutputSchema.safeParse(input).success) throw new ApiFailure('invalid-speech-request');
      const view = await current(request, input);
      if (input.choiceConfirmation) {
        if (input.sourceId !== view.currentPrompt?.id) throw new ApiFailure('speech-source-denied', 403);
        const text = choiceConfirmationSpeech(view.currentPrompt, input.choiceConfirmation.value);
        if (!text) throw new ApiFailure('speech-source-denied', 403);
        return { sessionId: view.id, sourceId: input.sourceId, revision: view.revision, text };
      }
      const combined = conversationSpeech(view);
      const source = input.sourceId === 'conversation-current' && combined?.id === input.sourceId ? combined
        : view.currentPrompt?.id === input.sourceId ? combined?.id === input.sourceId ? combined : view.currentPrompt
        : view.adaptive?.reply?.id === input.sourceId ? view.adaptive.reply : undefined;
      if (!source) throw new ApiFailure('speech-source-denied', 403);
      return { sessionId: view.id, sourceId: source.id, revision: view.revision, text: source.text };
    },
  };
}
