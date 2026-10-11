import type { AdaptiveOperationView, AdaptiveTurnResult, ClinicSessionView, PromptView } from '../../../packages/clinic-contract/src/index';
import { exactChoiceConfirmation, exactSpokenChoice, type VoiceChoiceCandidate } from './choice-voice';
import type { RecognitionSegment } from '../../../packages/speech/src/index';
import type { CaptureScope } from './voice-capture';

export type ConversationVoiceState = { active: boolean; status: 'off' | 'connecting' | 'listening' | 'finishing' | 'saving' | 'thinking' | 'speaking' | 'paused'; message: string; choice?: VoiceChoiceCandidate };
export type CaptureEvent =
  | { type: 'ready' | 'voice'; scope: CaptureScope }
  | { type: 'recognition'; scope: CaptureScope; segment: RecognitionSegment; interim: string }
  | { type: 'completed'; scope: CaptureScope; text: string; clean: boolean }
  | { type: 'interrupted'; scope: CaptureScope; reason: string };
export interface ConversationVoiceContext {
  scope?: CaptureScope; eligible: boolean; blocked: boolean;
  speech?: { id: string; text: string }; pauseReason?: string;
  choicePrompt?: PromptView;
}
export interface ConversationVoicePorts {
  context(): ConversationVoiceContext;
  startCapture(): void; finishCapture(): void; stopCapture(reason: string, preservePlayback?: boolean): void;
  stopPlayback(): void; speak(sourceId: string): void;
  save(text: string, scope: CaptureScope): Promise<AdaptiveTurnResult | undefined>;
  interpret(operation: AdaptiveOperationView): Promise<AdaptiveTurnResult | undefined>;
  prepareChoiceCapture?(): void;
  abandonCapture?(): void;
  speakChoiceConfirmation?(value: string): void;
  saveChoice?(candidate: VoiceChoiceCandidate, scope: CaptureScope, confirmation: { method: 'voice' | 'control'; transcript: string }): Promise<ClinicSessionView | undefined>;
  restoreChoiceDraft?(candidate: VoiceChoiceCandidate): void;
  saveChoiceAttempt?(text: string, scope: CaptureScope, priorChoiceTranscript?: string): Promise<ClinicSessionView | undefined>;
  changed(state: ConversationVoiceState): void;
}
interface Clock { after(ms: number, fn: () => void): unknown; clear(timer: unknown): void; }
const browserClock: Clock = { after: (ms, fn) => setTimeout(fn, ms), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
const sameScope = (a?: CaptureScope, b?: CaptureScope) => Boolean(a && b && a.sessionId === b.sessionId && a.promptId === b.promptId && a.expectedRevision === b.expectedRevision && a.requestId === b.requestId);

/** Explicit opt-in coordinator. Speech final events alone never submit in dictation mode. */
export class VoiceConversation {
  state: ConversationVoiceState = { active: false, status: 'off', message: '' };
  private generation = 0;
  private scope?: CaptureScope;
  private grace?: unknown;
  private idle?: unknown;
  private submitted = new Set<string>();
  private finals = new Map<string, string>();
  private latestFinalEnd = -1;
  private endpointEnd?: number;
  private heardVoice = false;
  private awaiting?: { sessionId: string; revision: number; promptId?: string };
  private interpretation?: { id: string; sessionId: string; generation: number; early: boolean };
  private startingSpeech = false;
  private choice?: { candidate: VoiceChoiceCandidate; scope: CaptureScope };
  private choiceCapturePending = false;
  constructor(private ports: ConversationVoicePorts, private clock = browserClock) {}
  private set(status: ConversationVoiceState['status'], message = '') { this.state = { active: !['off', 'paused'].includes(status), status, message, ...(this.choice ? { choice: this.choice.candidate } : {}) }; this.ports.changed(this.state); }
  private clearTimers() { this.clock.clear(this.grace); this.clock.clear(this.idle); this.grace = undefined; this.idle = undefined; }
  start() {
    if (this.state.active) return;
    const context = this.ports.context();
    if (!context.eligible || context.blocked || !context.scope) { this.set('paused', context.pauseReason || 'Check the current question and saved status before resuming voice.'); return; }
    if (this.submitted.has(context.scope.requestId)) { this.set('paused', 'Review or clear the unsent answer before starting another conversation turn.'); return; }
    this.generation++; this.awaiting = undefined; this.interpretation = undefined; this.begin(context);
  }
  private begin(context: ConversationVoiceContext) {
    this.clearTimers(); this.scope = context.scope; this.finals.clear(); this.latestFinalEnd = -1; this.endpointEnd = undefined; this.heardVoice = false; this.startingSpeech = false;
    this.set('connecting', 'Connecting the microphone…'); this.ports.startCapture();
  }
  stop(reason = 'Voice conversation paused. Your available words remain in the draft.', preservePlayback = false) {
    const candidate = this.choice?.candidate;
    this.generation++; this.awaiting = undefined; this.interpretation = undefined; this.choice = undefined; this.choiceCapturePending = false; this.clearTimers(); this.set('paused', reason);
    if (!preservePlayback) this.ports.stopPlayback(); this.ports.stopCapture(reason, preservePlayback);
    if (candidate) this.ports.restoreChoiceDraft?.(candidate);
  }
  dispose() { this.generation++; this.awaiting = undefined; this.interpretation = undefined; this.clearTimers(); this.state = { active: false, status: 'off', message: '' }; }
  /** Guarded durable-session events from the browser status/interpretation
   * boundary. Early speech uses its saved scope; a terminal tail is bookkeeping. */
  operation(result: AdaptiveTurnResult) {
    const pending = this.interpretation;
    if (!this.state.active || !pending || pending.generation !== this.generation || pending.id !== result.operation.id || pending.sessionId !== result.session.id) return;
    const early = result.operation.status === 'processing' && result.operation.stream?.reply === 'saved';
    if (early && !pending.early) {
      pending.early = true;
      this.awaiting = { sessionId: result.session.id, revision: result.session.revision, promptId: result.session.currentPrompt?.id };
      this.ports.changed({ ...this.state }); return;
    }
    if (pending.early) {
      // If React has already installed a newer bookkeeping-only scope before
      // capture starts, await that installed scope. Never rebase active audio/STT.
      const scope = this.ports.context().scope;
      if (this.awaiting && scope?.sessionId === result.session.id && scope.expectedRevision === result.session.revision
        && scope.promptId === this.awaiting.promptId && scope.promptId === result.session.currentPrompt?.id) this.awaiting.revision = scope.expectedRevision;
      return;
    }
    if (result.operation.queuedWaiting || result.operation.status === 'accepted' || result.operation.status === 'processing') return;
    if (result.operation.status !== 'applied') { this.stop('Your words are saved. Check the interpretation status before resuming voice.'); return; }
    this.awaiting = { sessionId: result.session.id, revision: result.session.revision, promptId: result.session.currentPrompt?.id };
    this.ports.changed({ ...this.state });
  }
  private valid(scope: CaptureScope) { return this.state.active && sameScope(scope, this.scope) && sameScope(scope, this.ports.context().scope); }
  event(event: CaptureEvent) {
    if (!this.valid(event.scope)) return;
    if (event.type === 'interrupted') { this.stop(event.reason); return; }
    if (event.type === 'ready') {
      if (this.state.status !== 'connecting') return;
      if (this.choice) {
        this.startingSpeech = true; this.set('speaking', `Confirm “${this.choice.candidate.label}”: say Yes or Confirm; say Retry to choose again.`);
        this.ports.speakChoiceConfirmation?.(this.choice.candidate.value); return;
      }
      const speech = this.ports.context().speech;
      if (speech && speech.text.length > 1200) { this.stop('Voice is paused. Read the complete reply and question on screen before continuing by text or dictation.'); return; }
      this.set('listening', 'Listening. A brief pause after your answer lets the conversation continue.');
      if (speech && speech.text.length <= 1200) { this.startingSpeech = true; this.set('speaking', 'Listening while the question is read aloud.'); this.ports.speak(speech.id); }
      else this.armIdle();
      return;
    }
    if (event.type === 'voice') {
      this.heardVoice = true; this.startingSpeech = false; this.endpointEnd = undefined; this.clock.clear(this.grace); this.grace = undefined; this.clock.clear(this.idle); this.idle = undefined;
      this.ports.stopPlayback();
      if (this.state.status === 'speaking') this.set('listening', 'Listening…');
      return;
    }
    if (event.type === 'recognition') {
      if (!['listening', 'speaking'].includes(this.state.status)) return;
      const { segment } = event;
      if (segment.text.trim()) { this.heardVoice = true; this.clock.clear(this.idle); this.idle = undefined; }
      const key = `${segment.start}:${segment.duration}`;
      const changedFinal = segment.isFinal && this.finals.get(key) !== JSON.stringify([segment.text, segment.speechFinal]);
      if (segment.isFinal) this.finals.set(key, JSON.stringify([segment.text, segment.speechFinal]));
      // Network delivery order is not audio order. Only a new latest final or
      // unresolved words in the production reducer invalidate an existing endpoint.
      if (changedFinal && segment.start + segment.duration >= this.latestFinalEnd) {
        this.latestFinalEnd = segment.start + segment.duration;
        this.endpointEnd = segment.speechFinal && segment.text.trim() ? this.latestFinalEnd : undefined;
        this.clock.clear(this.grace); this.grace = undefined;
      }
      if (event.interim) { this.clock.clear(this.grace); this.grace = undefined; }
      if (this.endpointEnd !== undefined && !event.interim && this.grace === undefined) {
        this.grace = this.clock.after(600, () => {
          this.grace = undefined;
          if (!this.valid(event.scope) || !['listening', 'speaking'].includes(this.state.status)) return;
          this.clearTimers(); this.set('finishing', 'Finishing your words · microphone off'); this.ports.stopPlayback(); this.ports.finishCapture();
        });
      }
      return;
    }
    if (event.type === 'completed') {
      if (this.submitted.has(event.scope.requestId)) return;
      if (this.state.status !== 'finishing' || !event.clean || !event.text.trim()) { this.stop('Check the available transcript before sending. Voice conversation is paused.'); return; }
      const choicePrompt = this.ports.context().choicePrompt;
      if (this.choice) {
        const action = exactChoiceConfirmation(event.text);
        if (action === 'confirm') { void this.confirmChoice('voice', event.text); return; }
        if (action === 'retry') { this.retryChoice(); return; }
        if (!action) { const prior = this.choice.candidate.optionTranscript; this.choice = undefined; this.submitted.add(event.scope.requestId); void this.retainChoiceAttempt(event.text, event.scope, prior); return; }
        this.stop(action === 'text' ? 'Voice paused. Choose an answer on screen.' : action === 'stop' ? 'Voice stopped. This item remains unsaved.' : 'Confirmation was unclear. This item remains unsaved; choose an answer on screen or try again.'); return;
      }
      if (choicePrompt) {
        const command = exactChoiceConfirmation(event.text);
        if (command === 'stop' || command === 'text') { this.stop(command === 'stop' ? 'Voice stopped. This item remains unsaved.' : 'Voice paused. Choose an answer on screen.'); return; }
        const selected = exactSpokenChoice(choicePrompt, event.text);
        if (!selected) { this.submitted.add(event.scope.requestId); void this.retainChoiceAttempt(event.text, event.scope); return; }
        this.choice = { candidate: { ...selected, optionTranscript: event.text }, scope: event.scope };
        // The completed option utterance is not a confirmation utterance.
        this.heardVoice = false;
        this.choiceCapturePending = true; this.set('thinking', 'Your choice is not saved yet. Confirm it by voice or with the controls below.'); this.ports.prepareChoiceCapture?.(); return;
      }
      this.submitted.add(event.scope.requestId); void this.submit(event.text, event.scope);
    }
  }
  private async retainChoiceAttempt(text: string, scope: CaptureScope, priorChoiceTranscript?: string) {
    const generation = this.generation;
    this.set('saving', 'Saving your recognized words without recording an answer choice · microphone off');
    try {
      const next = await this.ports.saveChoiceAttempt?.(text, scope, priorChoiceTranscript);
      if (generation !== this.generation || !this.state.active) return;
      this.stop(next ? 'Your words are saved without an answer choice. This item remains unscored; read any safety message, then choose on screen or resume voice to try again.' : 'Saving your words needs attention. No answer choice was inferred. Check the save status before continuing.');
    } catch { if (generation === this.generation) this.stop('Saving your words needs attention. No answer choice was inferred. Check the save status before continuing.'); }
  }
  retryChoice() {
    if (!this.choice || !this.state.active || this.state.status === 'saving') return;
    this.clearTimers(); this.ports.stopPlayback(); this.ports.abandonCapture?.(); this.choice = undefined;
    this.choiceCapturePending = true; this.set('thinking', 'Choose again from the exact options.'); this.ports.prepareChoiceCapture?.();
  }
  async confirmChoice(method: 'voice' | 'control', transcript = '') {
    const selected = this.choice, context = this.ports.context();
    if (!selected || !this.state.active || this.state.status === 'saving' || context.blocked || !context.eligible
      || context.scope?.sessionId !== selected.scope.sessionId || context.scope.promptId !== selected.scope.promptId || context.scope.expectedRevision !== selected.scope.expectedRevision
      || this.submitted.has(selected.scope.requestId) || method === 'voice' && exactChoiceConfirmation(transcript) !== 'confirm') return;
    // A control gesture cannot discard a patient utterance already in progress.
    // Drain it first; its exact words determine confirmation, retry or safety.
    if (method === 'control' && this.heardVoice) {
      if (this.state.status === 'finishing') return;
      if (!['listening', 'speaking'].includes(this.state.status)) return;
      this.clearTimers(); this.set('finishing', 'Finishing your confirmation words before saving · microphone off');
      this.ports.stopPlayback(); this.ports.finishCapture(); return;
    }
    const generation = this.generation;
    this.submitted.add(selected.scope.requestId);
    if (method === 'voice' && context.scope) this.submitted.add(context.scope.requestId);
    this.clearTimers(); this.set('saving', 'Saving your explicitly confirmed choice · microphone off');
    this.ports.stopPlayback(); this.ports.abandonCapture?.();
    try {
      const next = await this.ports.saveChoice?.(selected.candidate, selected.scope, { method, transcript });
      if (!this.state.active || generation !== this.generation) return;
      if (!next || next.id !== selected.scope.sessionId || next.revision <= selected.scope.expectedRevision) { this.stop('Saving this choice needs your attention. Check its saved status before resuming voice.'); return; }
      this.choice = undefined; this.choiceCapturePending = false;
      this.awaiting = { sessionId: next.id, revision: next.revision, promptId: next.currentPrompt?.id }; this.set('thinking', 'Your confirmed choice is saved.');
    } catch { if (generation === this.generation) this.stop('The save was interrupted. Check its saved status before trying again.'); }
  }
  private async submit(text: string, scope: CaptureScope) {
    const generation = this.generation; let operationId: string | undefined; this.clearTimers(); this.set('saving', 'Saving your draft answer · microphone off');
    try {
      const saved = await this.ports.save(text, scope);
      if (!this.state.active || generation !== this.generation) return;
      if (!saved || saved.operation.requestId !== scope.requestId || saved.session.id !== scope.sessionId || saved.operation.status !== 'accepted') { this.stop('Saving this turn needs your attention. Check its saved status before resuming voice.'); return; }
      operationId = saved.operation.id;
      this.interpretation = { id: operationId, sessionId: saved.session.id, generation, early: false };
      this.set('thinking', saved.operation.queuedWaiting ? 'Your words are saved. Waiting for the previous draft · microphone off' : 'Your words are saved. Thinking · microphone off');
      if (saved.operation.queuedWaiting) return; // Status hook owns its one initial dispatch when ready.
      const result = await this.ports.interpret(saved.operation);
      if (!this.state.active || generation !== this.generation || this.interpretation?.id !== saved.operation.id) return;
      if (!result) { if (!this.interpretation.early) this.stop('Your words are saved. Check the interpretation status before resuming voice.'); return; }
      this.operation(result);
    } catch { if (this.state.active && generation === this.generation && (!operationId || this.interpretation?.id === operationId)) this.stop('The conversation was interrupted. Check the saved status before resuming voice.'); }
  }
  reconcile() {
    if (!this.state.active) return;
    const context = this.ports.context();
    if (!context.eligible) { this.stop(context.pauseReason || 'Voice is paused. Review your answers or use the choices for this question.'); return; }
    if (this.choiceCapturePending) {
      if (context.blocked) return;
      if (!context.scope || !this.scope || context.scope.sessionId !== this.scope.sessionId || context.scope.promptId !== this.scope.promptId || context.scope.expectedRevision !== this.scope.expectedRevision) { this.stop('The question changed. This choice remains unsaved.'); return; }
      if (context.scope.requestId === this.scope.requestId) return;
      this.choiceCapturePending = false; this.begin(context); return;
    }
    if (this.awaiting) {
      const next = this.awaiting;
      if (context.blocked) return;
      if (context.scope?.sessionId !== next.sessionId || context.scope.expectedRevision !== next.revision || context.scope.promptId !== next.promptId) { this.stop('The question changed. Check the current conversation before resuming voice.'); return; }
      this.awaiting = undefined; this.begin(context); return;
    }
    if (['connecting', 'listening', 'speaking', 'finishing'].includes(this.state.status) && (!context.eligible || !sameScope(this.scope, context.scope))) this.stop(context.pauseReason || 'The question changed. Your available words remain unsent.');
  }
  playback(status: string) {
    if (!this.state.active || !['listening', 'speaking'].includes(this.state.status)) return;
    if (status === 'blocked' || status === 'error') { this.stop(status === 'blocked' ? 'Your browser needs a playback gesture. Continue by typing or use dictation.' : 'Audio could not continue. Your available words remain in the draft.', status === 'blocked'); return; }
    if (status === 'playing' || status === 'loading') { this.startingSpeech = false; this.set('speaking', 'Listening while the clinic speaks. You can interrupt.'); }
    if (status === 'finished' || status === 'idle' && !this.startingSpeech) { this.set('listening', 'Listening…'); if (!this.heardVoice) this.armIdle(); }
  }
  private armIdle() { if (this.idle !== undefined) return; this.idle = this.clock.after(15000, () => this.stop('Voice paused after a quiet moment. Resume when you’re ready, or keep typing.')); }
}
