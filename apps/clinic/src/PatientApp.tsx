import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleHelp, ClipboardList, Clock3, LogOut, RefreshCw, Send, X } from 'lucide-react';
import type { AdaptiveTurnInput, AdaptiveTurnResult, ClinicConfig, ClinicSessionView, DeliveryView, PromptView, ReviewPreview, ScenarioId, SourceChannel, SourceTurn, TopicView, TurnInput } from '../../../packages/clinic-contract/src/index';
import { conversationSpeech } from '../../../packages/clinic-contract/src/index';
import { messageOf, request, RequestError } from './api';
import { Button, Header, Loading, Notice, SourceInspector, WorkHistory, TopicContent, dateTime, outcomeLabels, responsibilityLabels, workDeliveryLabels, time, topicLabels, type SourceSelection } from './components';
import { useAdaptiveConversation } from './useAdaptiveConversation';
import { isPendingInterpretation, metadataOnlyStreamAdvance } from './adaptive-state';
import { AdaptiveReadback, AdaptiveStatus, AssistantActivity, ChatTranscript, UnresolvedSources } from './AdaptiveViews';
import { useSpeechCapture, type CaptureMediaSource } from './useSpeechCapture';
import { useSpeechPlayback } from './useSpeechPlayback';
import { VoiceControls } from './VoiceControls';
import { useVoiceConversation } from './useVoiceConversation';
import { promptAllowsFreeText } from './prompt-input';
import type { VoiceChoiceCandidate } from './choice-voice';
import { choiceConfirmationSpeech } from '../../../packages/clinic-contract/src/choice-voice';
import type { CaptureScope } from './voice-capture';
import { SafetyReviewQueue } from './safety-review-client';

export function PatientApp({ captureMediaSource }: { captureMediaSource?: CaptureMediaSource } = {}) {
  const [config, setConfig] = useState<ClinicConfig>();
  const [session, setSessionState] = useState<ClinicSessionView>();
  const sessionRef = useRef<ClinicSessionView | undefined>(undefined);
  const setSession = useCallback((next: SetStateAction<ClinicSessionView | undefined>) => {
    const value = typeof next === 'function' ? next(sessionRef.current) : next;
    sessionRef.current = value; setSessionState(value);
  }, []);
  const getSession = useCallback(() => sessionRef.current, []);
  const [preview, setPreview] = useState<ReviewPreview>();
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState('');
  const operation = useRef(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [verified, setVerified] = useState(false);
  const [leftAt, setLeftAt] = useState('');
  const [identityRejected, setIdentityRejected] = useState(false);
  const [text, setText] = useState('');
  const [answerChannel, setAnswerChannel] = useState<SourceChannel>('text');
  const answerRequestId = useRef(crypto.randomUUID());
  const textRef = useRef(text); textRef.current = text;
  const [fields, setFields] = useState<Record<string, string>>({});
  const [heldPrompt, setHeldPrompt] = useState<PromptView>();
  const [pendingTurn, setPendingTurn] = useState<TurnInput>();
  const [pendingAdaptive, setPendingAdaptive] = useState<AdaptiveTurnInput>();
  const [confirmationUnknown, setConfirmationUnknown] = useState(false);
  const [previousReceiptChecked, setPreviousReceiptChecked] = useState<{ reference: string; at: string }>();
  const [topicOutline, setTopicOutline] = useState(false);
  const [returnToReview, setReturnToReview] = useState(false);
  const [reviewTopic, setReviewTopic] = useState('');
  const [readAloud, setReadAloud] = useState(false);
  const questionRef = useRef<HTMLHeadingElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const outlineTrigger = useRef<HTMLButtonElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const activePrompt = heldPrompt ?? session?.currentPrompt;
  const naturalAnswer = session?.adaptive?.mode === 'adaptive' && activePrompt?.mode !== 'guided';
  const exactChoicePrompt = activePrompt?.choices?.length && !activePrompt.fields?.length && !promptAllowsFreeText(activePrompt, false) ? activePrompt : undefined;
  const canCaptureAnswer = Boolean(exactChoicePrompt) || Boolean(activePrompt && promptAllowsFreeText(activePrompt, naturalAnswer) && !activePrompt.choices?.some(choice => choice.value === text) && !/^Q16:MH0[1-4](?:$|:)/.test(activePrompt.id));
  const voiceScopeKey = `${verified}:${session?.id}:${session?.revision}:${activePrompt?.id}:${Boolean(preview)}:${Boolean(leftAt)}:${confirmationUnknown}`;
  const playback = useSpeechPlayback(`${voiceScopeKey}:${session?.adaptive?.reply?.id}`);
  const currentCaptureScope = (): CaptureScope | undefined => {
    const current = sessionRef.current;
    if (!verified || !current?.currentPrompt || !canCaptureAnswer || heldPrompt || preview || leftAt || pendingTurn || pendingAdaptive || config?.voice.available !== true) return;
    return { sessionId: current.id, promptId: current.currentPrompt.id, expectedRevision: current.revision, requestId: answerRequestId.current };
  };
  const voice = useVoiceConversation({
    context: () => ({
      scope: currentCaptureScope(), eligible: Boolean(verified && (exactChoicePrompt || naturalAnswer && session?.adaptive?.available) && canCaptureAnswer && !preview && !leftAt && !confirmationUnknown && session?.phase === 'conversation'),
      blocked: Boolean(busy || stale || heldPrompt || pendingTurn || pendingAdaptive || adaptive.answerBlocked),
      choicePrompt: exactChoicePrompt,
      speech: conversationSpeech({ currentPrompt: activePrompt, adaptive: session?.adaptive }),
      pauseReason: activePrompt?.mode === 'guided' ? 'Voice is paused. Use the exact answer choices or fields below, then resume when the guided questions are complete.' : 'Voice is paused. Review your answers or check the current conversation before resuming.',
    }),
    startCapture: () => { void capture.start({ conversation: true }); }, finishCapture: () => capture.finish(),
    stopCapture: (reason, preserve) => capture.stop(reason, true, preserve), stopPlayback: playback.stop, speak: sourceId => listen(sourceId),
    prepareChoiceCapture: () => { answerRequestId.current = crypto.randomUUID(); textRef.current = ''; setText(''); setAnswerChannel('text'); },
    abandonCapture: () => capture.stop('', false),
    speakChoiceConfirmation: value => listen(activePrompt!.id, value),
    restoreChoiceDraft: candidate => { const value = candidate.optionTranscript + (textRef.current ? `\nConfirmation attempt: ${textRef.current}` : ''); textRef.current = value; setText(value); setAnswerChannel('unreviewed-transcript'); },
    saveChoiceAttempt: (value, scope, prior) => saveVoiceChoiceAttempt(value, scope, prior),
    saveChoice: (candidate, scope, confirmation) => saveVoiceChoice(candidate, scope, confirmation),
    save: (value, scope) => saveAdaptive({ text: value, scope }), interpret: savedOperation => adaptive.interpret(savedOperation),
  });
  const capture = useSpeechCapture({
    mediaSource: captureMediaSource,
    scopeKey: voiceScopeKey, getScope: currentCaptureScope, getText: () => textRef.current, input: config?.voice.input,
    onText: (value, hasTranscript, conversationCapture) => { textRef.current = value; setText(value); if (hasTranscript) setAnswerChannel(conversationCapture ? 'unreviewed-transcript' : 'confirmed-transcript'); },
    onInterruptPlayback: playback.stop, onEvent: event => voice.controller.event(event),
  });
  // Hosted upload voice is dictation only: no continuous conversation, and exact choices stay buttons.
  const uploadVoice = config?.voice.input === 'upload';
  const hasComposerDraft = Boolean(text.trim() || Object.values(fields).some(value => value.trim()) || pendingTurn || pendingAdaptive || capture.active);
  const hasDraft = hasComposerDraft || voice.active;
  const draftRef = useRef(hasComposerDraft);
  draftRef.current = hasComposerDraft;
  const keepSpeechScope = useRef(false);
  keepSpeechScope.current = hasComposerDraft || ['connecting', 'listening', 'speaking', 'finishing'].includes(voice.status) || ['loading', 'playing', 'ready'].includes(playback.status);
  const acceptAdaptiveSession = useCallback((next: ClinicSessionView) => {
    const displayed = sessionRef.current;
    if (displayed && keepSpeechScope.current && metadataOnlyStreamAdvance(displayed, next)) return;
    const previous = displayed?.currentPrompt;
    // A new question must not silently change the context of an answer already being typed.
    if (draftRef.current && previous && previous.id !== next.currentPrompt?.id) setHeldPrompt(held => held ?? previous);
    setSession(next);
  }, [setSession]);
  const adaptive = useAdaptiveConversation({ session, getSession, onSession: acceptAdaptiveSession, onOperation: result => voice.controller.operation(result) });
  /** Browser output reads the same words the provider path would, resolved on the client. */
  const browserSpeechText = (sourceId: string, choiceValue?: string): string | undefined => {
    const adaptive = sessionRef.current?.adaptive;
    if (choiceValue !== undefined) return activePrompt && choiceConfirmationSpeech(activePrompt, choiceValue);
    if (adaptive?.reply && sourceId === adaptive.reply.id) return adaptive.reply.text;
    const speech = conversationSpeech({ currentPrompt: activePrompt, adaptive });
    if (speech?.id === sourceId) return speech.text;
    return activePrompt && sourceId === activePrompt.id ? conversationSpeech({ currentPrompt: activePrompt })?.text : undefined;
  };
  const listen = (sourceId: string, choiceValue?: string) => {
    const current = sessionRef.current;
    if (!current || !verified || config?.voice.available !== true) return;
    if (config?.voice.output === 'browser') {
      const text = browserSpeechText(sourceId, choiceValue);
      if (text) playback.speakText(text);
      return;
    }
    void playback.start({ requestId: crypto.randomUUID(), sessionId: current.id, expectedRevision: current.revision, sourceId, ...(choiceValue !== undefined ? { choiceConfirmation: { value: choiceValue } } : {}) });
  };
  // Read-aloud speaks each newly displayed question once; it never talks over an active capture or conversation.
  useEffect(() => {
    const speech = activePrompt && conversationSpeech({ currentPrompt: activePrompt });
    if (!readAloud || config?.voice.output !== 'browser' || config.voice.available !== true || !speech || capture.active || voice.active) return;
    playback.speakText(speech.text);
  }, [activePrompt?.id]);
  useEffect(() => { voice.controller.playback(playback.status); }, [playback.status, voice.controller]);
  // Run after capture/playback scope cleanup, so a newly acknowledged turn cannot cancel its own next capture.
  useEffect(() => { voice.controller.reconcile(); });
  useEffect(() => {
    if (!voice.active && ['review', 'interrupted'].includes(capture.status) && !heldPrompt) document.getElementById('answer-text')?.focus({ preventScroll: true });
  }, [capture.status, heldPrompt, voice.active]);

  const boot = async () => {
    setBooting(true); setError('');
    try {
      setConfig(await request<ClinicConfig>('/api/clinic/config'));
      try { setSession(await request<ClinicSessionView>('/api/clinic/session')); }
      catch (e) { if (!(e instanceof RequestError) || ![401, 404].includes(e.status)) throw e; }
    } catch (e) { setError(messageOf(e)); }
    finally { setBooting(false); }
  };
  useEffect(() => { void boot(); }, []);
  // Background tier-2 safety reviews: no patient-facing text. An escalation returns the paused session
  // view itself (a session GET would drop identity confirmation); it never replaces a newer revision.
  const safetyQueue = useRef<SafetyReviewQueue | undefined>(undefined);
  const escalatedSession = useRef<ClinicSessionView | undefined>(undefined);
  const refreshAfterEscalation = () => {
    const value = escalatedSession.current, current = sessionRef.current;
    escalatedSession.current = undefined;
    if (value && current && value.id === current.id && value.revision >= current.revision) acceptAdaptiveSession(value);
  };
  useEffect(() => {
    const queue = new SafetyReviewQueue({
      post: async signalId => {
        const result = await request<{ signalId: string; state: 'pending' | 'reviewed'; escalated: boolean; session?: ClinicSessionView }>('/api/clinic/safety-reviews', { signalId });
        if (result.escalated && result.session) escalatedSession.current = result.session;
        return result;
      },
      escalated: refreshAfterEscalation,
    });
    safetyQueue.current = queue;
    return () => { queue.dispose(); safetyQueue.current = undefined; };
  }, []);
  const safetyIds = session?.safetyReview?.pendingSignalIds;
  const safetyReviewable = verified && (session?.phase === 'conversation' || session?.phase === 'review');
  useEffect(() => { if (safetyReviewable) safetyQueue.current?.sync(safetyIds ?? []); }, [safetyReviewable, safetyIds]);
  useEffect(() => {
    if (!hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDraft]);
  useEffect(() => {
    if (verified && !preview && session?.phase !== 'confirmed' && !confirmationUnknown && !draftRef.current) questionRef.current?.focus({ preventScroll: true });
  }, [session?.currentPrompt?.id, verified, preview, confirmationUnknown]);
  useEffect(() => {
    if (preview && reviewTopic) {
      const answer = document.getElementById(`answer-${reviewTopic}`);
      answer?.focus({ preventScroll: true }); answer?.scrollIntoView({ block: 'start' });
    } else if (verified && !preview && session?.phase === 'conversation' && session.currentPrompt) {
      questionRef.current?.focus({ preventScroll: true });
    } else headingRef.current?.focus({ preventScroll: true });
  }, [Boolean(preview), session?.phase, verified, leftAt, identityRejected, booting]);

  useEffect(() => {
    if (topicOutline) { outlineRef.current?.focus({ preventScroll: true }); outlineRef.current?.scrollIntoView({ block: 'start' }); }
  }, [topicOutline]);

  const run = async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (operation.current) return;
    operation.current = true; setBusy(name); setError('');
    try { return await fn(); }
    catch (e) {
      setError(messageOf(e));
      if (e instanceof RequestError && e.status === 409) setStale(true);
      if (e instanceof RequestError && [401, 403].includes(e.status)) setVerified(false);
    } finally { operation.current = false; setBusy(''); }
  };
  const clearComposer = () => { capture.stop(''); playback.stop(); answerRequestId.current = crypto.randomUUID(); setAnswerChannel('text'); draftRef.current = false; textRef.current = ''; setText(''); setFields({}); setHeldPrompt(undefined); };
  const start = (scenario: ScenarioId) => run('start', async () => {
    adaptive.invalidate();
    const value = await request<ClinicSessionView>('/api/clinic/sessions', { scenario, syntheticAcknowledged: true });
    setSession(value); setPreview(undefined); setVerified(false); setLeftAt(''); setIdentityRejected(false);
    setConfirmationUnknown(false); clearComposer(); setPendingTurn(undefined); setPendingAdaptive(undefined); setStale(false);
  });
  const confirmIdentity = () => run('identity', async () => {
    const value = await request<ClinicSessionView>('/api/clinic/confirm-identity', { confirmed: true });
    setSession(value); setVerified(value.phase !== 'identity'); setStale(false);
  });
  const rejectIdentity = () => run('reject', async () => {
    adaptive.invalidate();
    setVerified(false);
    await request('/api/clinic/reject-identity', {});
    setSession(undefined); setPreview(undefined); setIdentityRejected(true); clearComposer(); setPendingTurn(undefined); setPendingAdaptive(undefined);
  });
  const updateTurn = (action: TurnInput['action']) => run('answer', async () => {
    if (!session?.currentPrompt || heldPrompt || capture.active) return;
    playback.stop();
    const current = pendingTurn ? session : await adaptive.discardPending();
    if (!current?.currentPrompt) return;
    if (!pendingTurn && current.currentPrompt.id !== session.currentPrompt.id) throw new Error('The question changed while your saved answer was being interpreted. Check the current question before answering.');
    const input = pendingTurn ?? {
      requestId: action === 'answer' ? answerRequestId.current : crypto.randomUUID(), expectedRevision: current.revision, promptId: current.currentPrompt.id, action,
      ...(action === 'answer' ? { text, fields, channel: answerChannel === 'unreviewed-transcript' ? 'confirmed-transcript' : answerChannel } : {}),
    };
    setPendingTurn(input);
    let next: ClinicSessionView;
    try { next = await request<ClinicSessionView>('/api/clinic/turns', input); }
    catch (e) { if (e instanceof RequestError && !e.uncertain) setPendingTurn(undefined); throw e; }
    setSession(next); clearComposer(); setPendingTurn(undefined); setPreview(undefined); setStale(false);
    if (returnToReview) {
      const nextPreview = await request<ReviewPreview>('/api/clinic/review', { expectedRevision: next.revision });
      setPreview(nextPreview); setSession(nextPreview.session); setReturnToReview(false);
    }
  });
  const currentChoiceSaveSession = async (displayed: ClinicSessionView): Promise<ClinicSessionView> => {
    if (!displayed.adaptive?.operation?.stream) return displayed;
    const fresh = await request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${encodeURIComponent(displayed.adaptive.operation.id)}`);
    if (!metadataOnlyStreamAdvance(displayed, fresh.session)) throw new Error('The saved question or answers changed. Check the current conversation before confirming a choice.');
    return fresh.session;
  };
  const saveVoiceChoiceAttempt = (value: string, scope: CaptureScope, priorChoiceTranscript?: string): Promise<ClinicSessionView | undefined> => run('answer', async () => {
    const current = getSession();
    if (!current?.currentPrompt || current.id !== scope.sessionId || current.revision !== scope.expectedRevision || current.currentPrompt.id !== scope.promptId || heldPrompt || pendingTurn || pendingAdaptive) return;
    const saved = await currentChoiceSaveSession(current);
    const input: TurnInput = { requestId: scope.requestId, expectedRevision: saved.revision, promptId: scope.promptId, action: 'answer', text: value, channel: 'unreviewed-transcript', choiceTranscriptOnly: true, ...(priorChoiceTranscript ? { priorChoiceTranscript } : {}) };
    setPendingTurn(input);
    let next: ClinicSessionView;
    try { next = await request<ClinicSessionView>('/api/clinic/turns', input); }
    catch (e) { if (e instanceof RequestError && !e.uncertain) setPendingTurn(undefined); throw e; }
    if (getSession()?.id !== current.id || (getSession()?.revision ?? 0) > next.revision) throw new Error('The saved conversation changed. Check the save status before continuing.');
    setSession(next); clearComposer(); setPendingTurn(undefined); setStale(false); return next;
  });
  const saveVoiceChoice = (candidate: VoiceChoiceCandidate, scope: CaptureScope, confirmation: { method: 'voice' | 'control'; transcript: string }): Promise<ClinicSessionView | undefined> => run('answer', async () => {
    const current = getSession();
    if (!current?.currentPrompt || current.id !== scope.sessionId || current.revision !== scope.expectedRevision || current.currentPrompt.id !== scope.promptId || heldPrompt || pendingTurn || pendingAdaptive) return;
    const saved = await currentChoiceSaveSession(current);
    const input: TurnInput = { requestId: scope.requestId, expectedRevision: saved.revision, promptId: scope.promptId, action: 'answer', text: candidate.value, channel: 'confirmed-transcript', choiceConfirmation: { optionTranscript: candidate.optionTranscript, confirmationTranscript: confirmation.transcript, confirmationMethod: confirmation.method } };
    setPendingTurn(input);
    let next: ClinicSessionView;
    try { next = await request<ClinicSessionView>('/api/clinic/turns', input); }
    catch (e) { if (e instanceof RequestError && !e.uncertain) setPendingTurn(undefined); throw e; }
    if (getSession()?.id !== current.id || (getSession()?.revision ?? 0) > next.revision) throw new Error('The saved conversation changed. Check the save status before continuing.');
    setSession(next); clearComposer(); setPendingTurn(undefined); setPreview(undefined); setStale(false);
    if (returnToReview) {
      const nextPreview = await request<ReviewPreview>('/api/clinic/review', { expectedRevision: next.revision });
      setPreview(nextPreview); setSession(nextPreview.session); setReturnToReview(false); return nextPreview.session;
    }
    return next;
  });
  const saveAdaptive = (naturalTurn?: { text: string; scope: CaptureScope }): Promise<AdaptiveTurnResult | undefined> => run('answer', async () => {
    const displayed = getSession();
    if (!displayed || heldPrompt || (!naturalTurn && capture.active) || !(naturalTurn?.text ?? text).trim() || (!pendingAdaptive && displayed.adaptive?.available !== true)) return;
    if (naturalTurn && (pendingAdaptive || naturalTurn.scope.sessionId !== displayed.id || naturalTurn.scope.expectedRevision !== displayed.revision || naturalTurn.scope.promptId !== displayed.currentPrompt?.id || naturalTurn.scope.requestId !== answerRequestId.current)) throw new Error('The question changed. Your transcript remains unsent; check it before continuing.');
    playback.stop();
    const recoveringSave = Boolean(pendingAdaptive);
    let current = pendingAdaptive || naturalTurn || adaptive.canQueueNextSource ? displayed : await adaptive.discardPending();
    if (!current) return;
    if (!pendingAdaptive && displayed.adaptive?.operation?.stream) {
      const fresh = await request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${encodeURIComponent(displayed.adaptive.operation.id)}`);
      if (!metadataOnlyStreamAdvance(displayed, fresh.session)) throw new Error('The saved question or answers changed. Your words remain unsent; check the current conversation.');
      current = fresh.session;
    }
    if (!pendingAdaptive && (current.currentPrompt?.mode === 'guided' || current.adaptive?.mode !== 'adaptive')) throw new Error('The saved conversation now uses guided questions. Your unsent words are still here; check the current question before continuing.');
    const input: AdaptiveTurnInput = pendingAdaptive ?? { requestId: naturalTurn?.scope.requestId ?? answerRequestId.current, expectedRevision: current.revision, text: naturalTurn?.text ?? text, channel: naturalTurn ? 'unreviewed-transcript' : answerChannel === 'unreviewed-transcript' ? 'confirmed-transcript' : answerChannel };
    setPendingAdaptive(input);
    let result: AdaptiveTurnResult;
    try { result = await request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', input); }
    catch (e) { if (e instanceof RequestError && !e.uncertain) setPendingAdaptive(undefined); throw e; }
    if (result.session.id !== getSession()?.id || result.session.revision < (getSession()?.revision ?? 0)) throw new Error('The saved conversation changed. Reload saved answers before continuing. Your text is still here.');
    setSession(result.session); clearComposer(); setPendingAdaptive(undefined); setPreview(undefined); setStale(false);
    // Natural conversation coordinates the same one-attempt interpretation after the durable acknowledgement.
    if (!naturalTurn && !recoveringSave && result.operation.status === 'accepted' && result.session.adaptive?.operation?.id === result.operation.id) void adaptive.interpret(result.operation);
    return result;
  });
  const updateAdaptive = () => saveAdaptive();
  const changeMode = (mode: 'adaptive' | 'guided') => run('mode', async () => {
    if (hasDraft) return;
    const current = await adaptive.discardPending();
    if (!current) return;
    const next = await request<ClinicSessionView>('/api/clinic/conversation-mode', { expectedRevision: current.revision, mode });
    setSession(next); setPreview(undefined); setStale(false);
  });
  const review = () => run('review', async () => {
    if (!session || hasDraft) return;
    const current = await adaptive.discardPending();
    if (!current) return;
    const value = await request<ReviewPreview>('/api/clinic/review', { expectedRevision: current.revision });
    setSession(value.session); setPreview(value); setStale(false);
  });
  const changeTopic = (topicId: string, slotPath?: string) => run('topic', async () => {
    if (!session || hasDraft) return;
    const current = await adaptive.discardPending();
    if (!current) return;
    const next = await request<ClinicSessionView>('/api/clinic/topics', { expectedRevision: current.revision, topicId, ...(slotPath ? { slotPath } : {}) });
    setSession(next); setReturnToReview(Boolean(preview) || session.phase === 'confirmed'); setReviewTopic(topicId);
    setPreview(undefined); clearComposer(); setTopicOutline(false); setStale(false);
  });
  const checkReceipt = () => run('receipt', async () => {
    adaptive.invalidate();
    const value = await request<ClinicSessionView>('/api/clinic/receipt');
    if (hasDraft && activePrompt && value.currentPrompt?.id !== activePrompt.id) setHeldPrompt(activePrompt);
    setSession(value); setStale(false);
    if (value.phase === 'confirmed') { setConfirmationUnknown(false); setPreview(undefined); }
    else if (confirmationUnknown) {
      setConfirmationUnknown(false); setPreview(undefined);
      setError('No confirmed handoff was found. Review your saved answers before sending.');
    } else setPreview(undefined);
  });
  const checkPreviousReceipt = () => run('previous-receipt', async () => {
    if (!session?.previousDelivery || pendingTurn || pendingAdaptive) return;
    const value = await request<ClinicSessionView>('/api/clinic/receipt');
    if (value.id !== session.id || !value.previousDelivery) {
      throw new Error('The earlier receipt could not be refreshed. Your update is unchanged. Try checking its status again.');
    }
    // Reconciliation refreshes the earlier receipt, never the amendment or its composer.
    setSession(current => current?.id === value.id ? { ...current, previousDelivery: value.previousDelivery } : current);
    setPreview(current => current?.session.id === value.id ? { ...current, session: { ...current.session, previousDelivery: value.previousDelivery } } : current);
    setPreviousReceiptChecked({ reference: value.previousDelivery.reference, at: new Date().toISOString() });
    if (value.revision > (getSession()?.revision ?? session.revision) && !adaptive.pending) {
      setStale(true);
      setError('The earlier receipt was refreshed, but your saved draft changed elsewhere. Reload saved answers before continuing. Your unsent answer is still here.');
    }
  });
  const retryDelivery = () => run('retry-delivery', async () => {
    if (session?.delivery?.canRetryDelivery !== true || confirmationUnknown) return;
    try {
      const value = await request<ClinicSessionView>('/api/clinic/retry-delivery', {});
      setSession(value); setPreview(undefined); setConfirmationUnknown(false);
    } catch (e) { if (e instanceof RequestError && e.uncertain) setConfirmationUnknown(true); throw e; }
  });
  const confirm = () => run('confirm', async () => {
    if (!preview) return;
    try {
      const value = await request<ClinicSessionView>('/api/clinic/confirm', { expectedRevision: preview.session.revision, digest: preview.digest });
      setSession(value); setPreview(undefined); setConfirmationUnknown(false); setStale(false);
    } catch (e) { if (e instanceof RequestError && e.uncertain) setConfirmationUnknown(true); throw e; }
  });
  const leave = () => run('leave', async () => {
    adaptive.invalidate();
    const value = await request<{ savedAt: string }>('/api/clinic/leave', {});
    setLeftAt(value.savedAt); setVerified(false); setPreview(undefined);
  });
  const restore = () => run('restore', async () => {
    adaptive.invalidate();
    setSession(await request<ClinicSessionView>('/api/clinic/session'));
    setPreview(undefined); setLeftAt(''); setVerified(false); setIdentityRejected(false);
  });

  if (booting) return <Loading />;
  if (!config) return <><Header /><main id="main" tabIndex={-1} className="narrow-page"><h1 ref={headingRef} tabIndex={-1}>We couldn’t open the clinic</h1><Notice tone="attention" action={<Button onClick={boot}><RefreshCw size={16} />Try again</Button>}>{error || 'The clinic service is unavailable.'}</Notice></main></>;
  if (!session || leftAt || identityRejected) return <><Header><a className="text-link" href="/staff">Staff sign in<ArrowRight size={15} aria-hidden="true" /></a></Header><main id="main" tabIndex={-1} className="entry-page">
    {leftAt ? <><div className="saved-mark"><CheckCheck size={26} aria-hidden="true" /></div><h1 ref={headingRef} tabIndex={-1}>Your saved answers are here</h1><p className="lead">Saved at {time(leftAt)}. Return in this browser to continue or check your request status.</p><Button variant="primary" onClick={restore} disabled={Boolean(busy)}>Return to my conversation<ArrowRight size={17} aria-hidden="true" /></Button></>
      : identityRejected ? <><h1 ref={headingRef} tabIndex={-1}>Let’s stop here</h1><p className="lead">This browser’s access to that conversation has been cleared. Its saved answers have not been deleted. You can choose a new synthetic scenario below.</p><Button variant="primary" onClick={() => setIdentityRejected(false)}>Return to demo launcher<ArrowRight size={17} aria-hidden="true" /></Button></>
        : <ScenarioEntry config={config} busy={Boolean(busy)} start={start} />}
    {error && <Notice tone="attention">{error}</Notice>}
  </main></>;
  if (!verified || session.phase === 'identity') return <><Header /><main id="main" tabIndex={-1} className="identity-page"><h1 ref={headingRef} tabIndex={-1}>Before we begin</h1><p className="lead">Use the provided fictional patient for this conversation. Keep real personal and medical information out of the demo.</p><section className="persona"><h2>{session.persona.displayName}</h2><p>{session.persona.description}</p><p className="metadata">{session.title}</p></section><div className="button-row"><Button variant="primary" disabled={Boolean(busy)} onClick={confirmIdentity}>{busy === 'identity' ? 'Opening your conversation…' : `Continue as ${session.persona.displayName.split(' ')[0]}`}<ArrowRight size={17} aria-hidden="true" /></Button><Button variant="text" disabled={Boolean(busy)} onClick={rejectIdentity}>{busy === 'reject' ? 'Clearing browser access…' : 'This isn’t me'}</Button></div>{error && <Notice tone="attention">{error}</Notice>}</main></>;

  const isStatus = session.phase === 'confirmed' || confirmationUnknown;
  const liveOperation = session.adaptive?.operation;
  const operationPending = isPendingInterpretation(liveOperation);
  // A reply shown during a new reading would belong to the previous message, unless the stream already saved the new one.
  const replyFresh = !operationPending || liveOperation?.stream?.reply === 'saved';
  const thinking = operationPending && !replyFresh && !adaptive.uncertain && (adaptive.working || Boolean(liveOperation?.queuedWaiting));
  const updatingAnswers = operationPending && replyFresh && liveOperation?.stream?.capture === 'pending';
  const addedCount = liveOperation?.status === 'applied' ? liveOperation.updates?.length ?? 0 : 0;
  const disclosure = 'You’ll check everything before it’s sent. Gaps are fine, and this isn’t a diagnosis.';
  return <><Header><span className="header-patient">{session.persona.displayName}</span><Button variant="text" onClick={leave} disabled={Boolean(busy) || hasDraft || confirmationUnknown}><LogOut size={16} aria-hidden="true" />{busy === 'leave' ? 'Saving…' : 'Save and leave'}</Button></Header>
    <main id="main" tabIndex={-1} className={`patient-shell ${isStatus ? 'patient-shell--status' : ''}`}>
      <aside ref={outlineRef} tabIndex={-1} id="topic-outline" className={`topic-outline ${topicOutline ? 'is-open' : ''}`} aria-label="Your answer topics"><div className="outline-heading"><h2>About your answers</h2><Button variant="text" className="mobile-only" onClick={() => { setTopicOutline(false); outlineTrigger.current?.focus(); }} aria-label="Close topic outline"><X size={19} aria-hidden="true" /></Button></div><p className="metadata">{session.title}</p><ol>{session.topics.map(topic => <li key={topic.id}><button className={`topic-link ${session.currentPrompt?.topicId === topic.id && !preview ? 'is-current' : ''}`} aria-current={session.currentPrompt?.topicId === topic.id && !preview ? 'step' : undefined} disabled={Boolean(busy) || hasDraft || confirmationUnknown || (isStatus && session.delivery?.state !== 'received')} onClick={() => changeTopic(topic.id)}><span className="topic-indicator">{topic.status === 'ready-for-review' && <Check size={13} aria-hidden="true" />}</span><span><span className="topic-title">{topic.title}</span><span className="topic-caption">{topicLabels[topic.status]}</span></span></button></li>)}</ol><div className="outline-footer"><span className="save-status" role="status">{busy === 'answer' ? 'Saving your answer…' : (pendingTurn || pendingAdaptive) ? 'Latest answer not yet confirmed saved' : `Saved at ${time(session.savedAt)}`}</span><p className="metadata">{session.completeness === 'partial' ? 'Some details are still missing.' : 'Required details recorded.'}</p></div></aside>
      <div className="patient-workspace">
        <div className="mobile-topic-bar"><button ref={outlineTrigger} type="button" className="button button--secondary" onClick={() => setTopicOutline(!topicOutline)} aria-controls="topic-outline" aria-expanded={topicOutline}><ClipboardList size={16} aria-hidden="true" />Your topics</button><span className="metadata">{(pendingTurn || pendingAdaptive) ? 'Save unconfirmed' : `Saved ${time(session.savedAt)}`}</span></div>
        <div className="workspace-meta"><span>{isStatus ? 'Request status' : preview ? 'Answer review' : 'Your conversation'}</span><span className="mode-label">{session.adaptive?.mode === 'adaptive' ? activePrompt?.mode === 'guided' ? 'AI intake assistant · standard questions' : 'AI intake assistant' : 'Set questions'}</span></div>
        {session.notice && <Notice tone={session.notice.tone}>{session.notice.text}</Notice>}
        {error && <Notice tone="attention" action={pendingAdaptive ? <Button onClick={updateAdaptive} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Check and retry saving this answer</Button> : pendingTurn ? <Button onClick={() => updateTurn(pendingTurn.action)} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Retry saving this answer</Button> : stale ? <Button onClick={checkReceipt} disabled={Boolean(busy)}><RefreshCw size={16} aria-hidden="true" />Reload saved answers</Button> : undefined}>{error}{(pendingTurn || pendingAdaptive) && <p>Your answer is still below. Retrying won’t send it twice.</p>}</Notice>}
        {session.previousDelivery && <PreviousDelivery delivery={session.previousDelivery} currentState={confirmationUnknown ? 'uncertain' : session.phase === 'confirmed' ? 'confirmed' : 'draft'} busy={Boolean(busy)} checking={busy === 'previous-receipt'} saveUnconfirmed={Boolean(pendingTurn || pendingAdaptive)} checkedAt={previousReceiptChecked?.reference === session.previousDelivery.reference ? previousReceiptChecked.at : undefined} onCheck={checkPreviousReceipt} />}
        {isStatus ? <Delivery session={session} uncertain={confirmationUnknown} busy={Boolean(busy)} onCheck={checkReceipt} onRetry={retryDelivery} onChange={changeTopic} /> : preview ? <section className="review-workspace">
          <h1 ref={headingRef} tabIndex={-1}>{session.previousDelivery ? 'Check your update' : 'Check your answers'}</h1><p className="lead">{session.previousDelivery ? 'Your changes have not been sent. Your care team will receive this updated version after you confirm.' : 'Your care team will receive this version after you confirm.'} Use Change to fix anything, or Your words to see exactly what you said.</p>
          <div className="review-state"><span className="status-label">Saved · not sent yet</span><span>{session.completeness === 'partial' ? 'Some details missing · you can still send' : 'All required details recorded'}</span></div>
          {session.completeness === 'partial' && <Notice tone="attention">Some details are still missing, and that’s OK. Go back to add them, or send what you have as a partial intake. Your care team will see what’s missing.</Notice>}
          <UnresolvedSources session={session} expanded />{session.turns.some(turn => turn.channel === 'unreviewed-transcript') && <Notice>Some of your messages came from speech-to-text. Check names, medicines, amounts, units, dates, and words like “not” against what you meant. Use Change to fix an answer, or Back to conversation to add more. Confirming sends this summary; it doesn’t mark every transcript as exact.</Notice>}
          {session.topics.map(topic => <PatientTopic key={topic.id} topic={topic} sources={session.turns} onChange={slotPath => changeTopic(topic.id, slotPath)} disabled={Boolean(busy) || stale} />)}
          <div className="confirmation-block"><p>{preview.confirmationText}</p><Button variant="primary" onClick={confirm} disabled={Boolean(busy) || stale}>{busy === 'confirm' ? 'Sending your confirmed answers…' : session.previousDelivery ? 'Confirm and send update to Corvo Clinic' : 'Confirm and send to Corvo Clinic'}<Send size={17} aria-hidden="true" /></Button><Button variant="text" onClick={() => { setPreview(undefined); setReturnToReview(false); }} disabled={Boolean(busy)}><ArrowLeft size={16} aria-hidden="true" />Back to conversation</Button></div>
        </section> : <section className="conversation">
          <div className="conversation-heading"><h1 ref={headingRef} tabIndex={-1}>{session.title}</h1><p>{session.adaptive?.mode === 'adaptive' ? `An AI assistant turns your words into intake answers. ${disclosure}` : `Your care team will review what you share. ${disclosure}`}</p></div>
          <details className="persona-details"><summary>Synthetic patient details</summary><p><strong>{session.persona.displayName}</strong> — {session.persona.description}</p></details>
          <ChatTranscript turns={session.turns} />
          <AdaptiveReadback session={session} disabled={Boolean(busy) || hasDraft || stale} onChange={changeTopic} />
          {session.adaptive && <AssistantActivity thinking={thinking} updating={updatingAnswers} reply={replyFresh ? session.adaptive.reply : undefined} added={addedCount} />}
          {session.adaptive?.operation && <AdaptiveStatus operation={session.adaptive.operation} working={adaptive.working} slow={adaptive.slow} uncertain={adaptive.uncertain} message={adaptive.message} canInterpret={adaptive.canInterpret && session.adaptive.available && !stale} busy={Boolean(busy)} hasDraft={hasDraft} onCheck={() => run('adaptive-status', adaptive.checkStatus)} onInterpret={() => void adaptive.interpret(session.adaptive!.operation!)} onStop={() => run('stop-interpretation', async () => { await adaptive.discardPending(); })} onGuided={() => changeMode('guided')} />}
          <UnresolvedSources session={session} />
          {heldPrompt && <Notice tone="attention">The saved conversation has moved on. Your unsent answer for the earlier question is still shown below. Copy any text you need, then clear it to continue.</Notice>}
          {activePrompt ? <form className="answer-form" onSubmit={event => { event.preventDefault(); void (naturalAnswer ? updateAdaptive() : updateTurn('answer')); }}>
            <div className="question-block"><h2 ref={questionRef} tabIndex={-1}>{activePrompt.text}</h2><p className="current-topic">{session.topics.find(topic => topic.id === activePrompt.topicId)?.title}</p>{activePrompt.purpose && <details className="question-purpose"><summary><CircleHelp size={15} aria-hidden="true" />Why we’re asking</summary><p>{activePrompt.purpose}</p></details>}</div>
            <VoiceControls available={config.voice.available} explanation={config.voice.explanation} conversation={voice} conversationAllowed={!uploadVoice && Boolean(exactChoicePrompt || naturalAnswer && session.adaptive?.available)} exactChoices={Boolean(exactChoicePrompt)} captureAllowed={uploadVoice ? canCaptureAnswer && !exactChoicePrompt : canCaptureAnswer} disabled={Boolean(busy || pendingTurn || pendingAdaptive || heldPrompt) || stale || adaptive.answerBlocked || (naturalAnswer && !session.adaptive?.available)} capture={capture} playback={playback} onListen={() => listen(activePrompt.id)} onListenReply={session.adaptive?.reply ? () => listen(session.adaptive!.reply!.id) : undefined} questionTooLong={(conversationSpeech({ currentPrompt: activePrompt })?.text.length ?? 0) > 1200} replyTooLong={(session.adaptive?.reply?.text.length ?? 0) > 1200} />
            {config.voice.available && config.voice.output === 'browser' && <label className="voice-consent"><input type="checkbox" checked={readAloud} onChange={event => { setReadAloud(event.target.checked); if (!event.target.checked) playback.stop(); }} /><span>Read new questions aloud</span></label>}
            {exactChoicePrompt && voice.choice && <section className="voice-choice-confirmation" aria-label="Confirm recognized choice"><p>{choiceConfirmationSpeech(exactChoicePrompt, voice.choice.value)}</p><p className="metadata">Recognized answer: {voice.choice.optionTranscript}</p><Button disabled={Boolean(busy) || stale || voice.status === 'saving'} onClick={() => void voice.controller.confirmChoice('control')}>Confirm choice</Button><Button disabled={Boolean(busy) || voice.status === 'saving'} onClick={() => voice.controller.retryChoice()}>Choose again</Button></section>}
            {exactChoicePrompt && text && !voice.choice && <Notice tone="attention">Recognized words: {text}. No choice has been recorded. Clear these words to try again, or choose an exact answer below.</Notice>}
            <fieldset disabled={Boolean(busy) || Boolean(pendingTurn || pendingAdaptive) || capture.active || voice.active} className="composer-fields"><legend className="sr-only">Answer the current question</legend>
              {!naturalAnswer && activePrompt.fields?.map(field => <div className="field" key={field.id}><label htmlFor={`field-${field.id}`}>{field.label}{field.required && <span className="required-label">Required for a complete answer</span>}</label>{field.kind === 'choice' ? <select id={`field-${field.id}`} value={fields[field.id] ?? ''} onChange={event => setFields({ ...fields, [field.id]: event.target.value })} aria-describedby={field.hint ? `hint-${field.id}` : undefined}><option value="">Choose an answer</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input id={`field-${field.id}`} type={field.kind === 'number' ? 'number' : 'text'} inputMode={field.kind === 'number' ? 'decimal' : undefined} step={field.kind === 'number' ? 'any' : undefined} value={fields[field.id] ?? ''} onChange={event => setFields({ ...fields, [field.id]: event.target.value })} aria-describedby={field.hint ? `hint-${field.id}` : undefined} autoComplete="off" />}{field.hint && <p className="field-hint" id={`hint-${field.id}`}>{field.hint}</p>}</div>)}
              {!naturalAnswer && Boolean(activePrompt.choices?.length) && <div className="choice-list" role="group" aria-label="Answer choices">{activePrompt.choices!.map(choice => <button type="button" key={choice.value} className={`choice ${text === choice.value ? 'is-selected' : ''}`} aria-pressed={text === choice.value} onClick={() => { playback.stop(); setAnswerChannel('text'); const value = text === choice.value ? '' : choice.value; textRef.current = value; setText(value); }}>{choice.label}{text === choice.value && <Check size={16} aria-hidden="true" />}</button>)}</div>}
              {promptAllowsFreeText(activePrompt, naturalAnswer) && <div className="field message-field"><label htmlFor="answer-text">{answerChannel !== 'text' ? 'Your transcript' : 'Your answer'}</label><textarea id="answer-text" value={!naturalAnswer && activePrompt.choices?.some(choice => choice.value === text) ? '' : text} onChange={event => { playback.stop(); textRef.current = event.target.value; setText(event.target.value); }} rows={naturalAnswer ? 4 : 3} maxLength={8000} placeholder={naturalAnswer ? 'Reply in your own words. Several details, a question, or a correction are all fine.' : 'Type your answer here…'} /></div>}
              <div className="composer-actions"><span className="draft-label">{pendingTurn || pendingAdaptive ? 'Save not confirmed' : hasDraft ? 'Unsent answer' : !naturalAnswer && activePrompt.choices?.length ? 'Choose an answer' : 'Answer in your own words'}</span><Button type="submit" variant="primary" disabled={!hasDraft || Boolean(busy) || Boolean(heldPrompt) || stale || (naturalAnswer && !session.adaptive?.available)}>{busy === 'answer' ? 'Saving…' : returnToReview ? 'Save correction' : answerChannel !== 'text' ? 'Send reviewed answer' : 'Send answer'}<ArrowRight size={17} aria-hidden="true" /></Button></div>
              {hasDraft && !pendingTurn && !pendingAdaptive && <Button className="clear-answer" variant="text" onClick={clearComposer}>Clear unsent answer</Button>}
            </fieldset>
            <div className="alternative-actions" role="group" aria-label="Other ways to answer this question"><Button variant="text" disabled={Boolean(busy) || hasDraft || Boolean(heldPrompt) || stale} onClick={() => updateTurn('unknown')}>I don’t know</Button><Button variant="text" disabled={Boolean(busy) || hasDraft || Boolean(heldPrompt) || stale} onClick={() => updateTurn('decline')}>I’d rather not say</Button><Button variant="text" disabled={Boolean(busy) || hasDraft || Boolean(heldPrompt) || stale} onClick={() => updateTurn('move-on')}>Skip for now</Button></div>
          </form> : <div className="conversation-ready"><CheckCheck size={28} aria-hidden="true" /><h2>{session.notice?.tone === 'urgent' ? 'Routine questions are paused' : 'Your answers are ready to review'}</h2><p>{session.notice?.tone === 'urgent' ? 'Read the message above. You can review what you’ve already shared.' : 'Check what you’ve shared, make any changes, and decide what to send.'}</p></div>}
          <div className="conversation-bottom"><Button onClick={review} disabled={Boolean(busy) || hasDraft || stale}><ClipboardList size={17} aria-hidden="true" />{busy === 'review' ? 'Opening your answers…' : adaptive.pending ? 'Stop and review my answers' : 'Review my answers'}</Button>
            {session.adaptive && <div className="conversation-mode">{!session.adaptive.available && <p className="metadata">The AI assistant isn’t available right now, so you’ll get set questions instead.</p>}{(session.adaptive.mode === 'adaptive' || session.adaptive.available) && <Button variant="text" disabled={Boolean(busy) || hasDraft || stale} onClick={() => changeMode(session.adaptive!.mode === 'adaptive' ? 'guided' : 'adaptive')}>{session.adaptive.mode === 'adaptive' ? 'Prefer set questions? Switch' : 'Switch back to conversation'}</Button>}</div>}
          </div>
          {hasDraft && <p className="metadata unsent-guidance">{pendingTurn || pendingAdaptive ? 'We couldn’t confirm this answer was saved. Retry above to check before continuing.' : 'Send or clear your reply first. It isn’t saved until you send it.'}</p>}
          {!session.adaptive && config.conversation.explanation && <details className="runtime-detail"><summary>About these questions</summary><p>{config.conversation.explanation}</p></details>}
        </section>}
      </div>
    </main>
  </>;
}

function ScenarioEntry({ config, busy, start }: { config: ClinicConfig; busy: boolean; start: (id: ScenarioId) => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [selected, setSelected] = useState<ScenarioId>();
  return <><div className="entry-heading"><h1>Start a clinic conversation</h1><p className="lead">Share what matters, check your answers, and send them to the right people at {config.clinicName}.</p></div><section className="scenario-section"><h2>Choose a demo conversation</h2><p className="section-intro">Each scenario uses a fictional patient. Nothing you submit is medical advice, a booking, or a prescription.</p><fieldset disabled={busy}><legend className="sr-only">Demo conversation</legend><div className="scenario-list">{config.scenarios.map(scenario => <label className={`scenario-option ${selected === scenario.id ? 'is-selected' : ''}`} key={scenario.id}><input type="radio" name="scenario" value={scenario.id} checked={selected === scenario.id} onChange={() => setSelected(scenario.id)} /><span className="scenario-copy"><strong>{scenario.title}</strong><span>{scenario.description}</span></span><ArrowRight size={20} aria-hidden="true" /></label>)}</div><label className="acknowledgement"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I’ll use only the provided synthetic patient details.</label><Button variant="primary" disabled={!selected || !acknowledged || busy} onClick={() => selected && start(selected)}>{busy ? 'Opening your conversation…' : 'Start conversation'}<ArrowRight size={17} aria-hidden="true" /></Button></fieldset></section><p className="entry-footnote">Your answers stay a draft until you review and confirm them.</p></>;
}

function PatientTopic({ topic, sources, onChange, disabled }: { topic: TopicView; sources: SourceTurn[]; onChange?: (slotPath?: string) => void; disabled?: boolean }) {
  const [source, setSource] = useState<SourceSelection>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  return <article className="answer-section" id={`answer-${topic.id}`} tabIndex={-1} aria-label={topic.title}>
    <TopicContent topic={topic} onChange={onChange} disabled={disabled} audience="patient" onSource={(selection, element) => { trigger.current = element; setSource(selection); }} />
    {source && <SourceInspector title={source.title} ids={source.ids} sources={sources} provenance={source.provenance} audience="patient" onClose={() => { setSource(undefined); trigger.current?.focus(); }} />}
  </article>;
}

export function PreviousDelivery({ delivery, currentState, busy, checking, saveUnconfirmed, checkedAt, onCheck }: {
  delivery: DeliveryView; currentState: 'draft' | 'uncertain' | 'confirmed'; busy: boolean; checking: boolean;
  saveUnconfirmed: boolean; checkedAt?: string; onCheck: () => void;
}) {
  const receiptLabels: Record<DeliveryView['state'], string> = {
    pending: 'Delivery pending', unknown: 'Delivery not confirmed', incomplete: 'Handoff incomplete',
    received: 'Received by Corvo Clinic', conflict: 'Delivery needs attention',
  };
  return <section className="previous-delivery" aria-labelledby="previous-delivery-title">
    <div className="section-heading"><h2 id="previous-delivery-title">Earlier confirmed version {delivery.version}</h2><span className="status-label">{receiptLabels[delivery.state]}</span></div>
    <p className="previous-delivery-context">{currentState === 'draft' ? 'You’re editing an update that has not been sent.' : currentState === 'uncertain' ? 'The result of sending your update is not yet confirmed.' : 'The status of your current version is shown separately below.'} This receipt and these care-team outcomes belong to the earlier version.</p>
    <details className="previous-delivery-details"><summary>Earlier receipt and care-team outcomes</summary>
      <dl className="previous-receipt-facts"><div><dt>Reference</dt><dd className="break-anywhere">{delivery.reference}</dd></div><div><dt>Received</dt><dd>{dateTime(delivery.receivedAt)}</dd></div></dl>
      {delivery.work.length ? delivery.work.map(work => <article className="work-item" key={work.id}><div className="section-heading"><h3>{work.title}</h3><span className="status-label">{outcomeLabels[work.status]}</span></div><p className="metadata">{responsibilityLabels[work.responsibility]} · {workDeliveryLabels[work.delivery ?? 'unknown']} · Earlier version {delivery.version}</p>{work.status !== 'external-change' && work.outcome ? <><p className="work-outcome">{work.outcome}</p><p className="metadata">{work.author || 'Care team'} · {dateTime(work.at)}</p></> : <p className="work-waiting">No staff-recorded outcome for this earlier version yet.</p>}<WorkHistory work={work} /></article>) : <p className="metadata">No care-team work is available for this earlier receipt.</p>}
    </details>
    <div className="previous-receipt-actions"><Button onClick={onCheck} disabled={busy || saveUnconfirmed}><RefreshCw size={16} aria-hidden="true" />{checking ? 'Checking earlier status…' : 'Check earlier version status'}</Button>{checkedAt && <span className="metadata" role="status">Earlier receipt checked at {time(checkedAt)}. Your update is unchanged.</span>}</div>
    {saveUnconfirmed && <p className="metadata">Resolve the unconfirmed answer save before checking the earlier receipt.</p>}
  </section>;
}

export function Delivery({ session, uncertain, busy, onCheck, onRetry, onChange }: { session: ClinicSessionView; uncertain: boolean; busy: boolean; onCheck: () => void; onRetry: () => void; onChange: (id: string, slotPath?: string) => void }) {
  const delivery = session.delivery;
  const received = !uncertain && delivery?.state === 'received';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const title = heading.current;
    title?.focus({ preventScroll: true });
    // Start at the workspace so a delivery error remains visible above the receipt.
    title?.closest('.patient-workspace')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    title?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [received, uncertain, delivery?.state]);
  const title = received ? 'Received by Corvo Clinic' : delivery?.state === 'conflict' ? 'Your delivery needs attention' : 'Delivery not yet confirmed';
  return <section className="delivery-workspace"><div className={`receipt-mark ${received ? 'is-received' : ''}`}>{received ? <CheckCheck size={29} aria-hidden="true" /> : <Clock3 size={29} aria-hidden="true" />}</div><h1 ref={heading} tabIndex={-1}>{title}</h1><p className="lead">{received ? 'Your care team can now review this version. Sending your answers does not mean they have been reviewed or that treatment has been approved.' : uncertain ? 'We couldn’t confirm the result of your send request. Check its status before taking another action.' : 'Your confirmed answers are saved. Check delivery status to see whether the clinic has received the complete handoff.'}</p>
    <div className="receipt-facts"><div><span>Handoff</span><strong>{session.completeness === 'partial' ? 'Partial · detail missing' : 'Required details recorded'}</strong></div>{delivery && <><div><span>Version</span><strong>{delivery.version}</strong></div><div><span>Reference</span><strong className="break-anywhere">{delivery.reference}</strong></div>{delivery.receivedAt && <div><span>Received</span><strong>{dateTime(delivery.receivedAt)}</strong></div>}</>}</div>
    <div className="button-row"><Button onClick={onCheck} disabled={busy}><RefreshCw size={16} aria-hidden="true" />{busy ? 'Working…' : received ? 'Refresh care-team status' : 'Check delivery status'}</Button>{!uncertain && delivery?.canRetryDelivery === true && <Button variant="primary" onClick={onRetry} disabled={busy}>Complete delivery of saved answers<Send size={16} aria-hidden="true" /></Button>}</div>
    {!uncertain && delivery?.canRetryDelivery === true && <p className="metadata retry-explanation">This completes delivery of the same confirmed answers and any remaining care-team work. Already saved parts keep the same reference.</p>}
    {Boolean(delivery?.work.length) && <section className="work-status"><h2>With your care team</h2>{delivery!.work.map(work => <article className="work-item" key={work.id}><div className="section-heading"><h3>{work.title}</h3><span className="status-label">{outcomeLabels[work.status]}</span></div><p className="metadata">{responsibilityLabels[work.responsibility]} · {workDeliveryLabels[work.delivery ?? 'unknown']}</p>{work.status === 'external-change' && <p className="work-waiting">This work item changed outside a recorded clinic action. Earlier recorded outcomes are kept separately.</p>}{work.status !== 'external-change' && work.outcome ? <><p className="work-outcome">{work.outcome}</p><p className="metadata">{work.author || 'Care team'} · {dateTime(work.at)}</p></> : <p className="work-waiting">No staff-recorded outcome yet.</p>}<WorkHistory work={work} /></article>)}</section>}
    <section className="sent-answers"><div className="section-heading"><h2>{uncertain ? 'Answers in this send request' : 'Your confirmed answers'}</h2>{received && <span className="metadata">A correction creates an update</span>}</div>{session.topics.map(topic => <PatientTopic key={topic.id} topic={topic} sources={session.turns} onChange={received ? slotPath => onChange(topic.id, slotPath) : undefined} disabled={busy} />)}</section>
  </section>;
}
