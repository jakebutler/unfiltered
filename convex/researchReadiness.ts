import { cleanupAdmissionReady, captureCleanupCovered } from './cleanupAdmission';
import { captureLimits } from '../packages/research-capture/src/contracts';
import { getAuthSessionId } from '@convex-dev/auth/server';
import { STUDY_READINESS_MAX_AGE_MS } from '../packages/research-core/src/readiness';
import { checkTestCaptureBinding } from './researchTestBinding';
import { currentResearchPrompt } from './currentResearchPrompt';
import { ConvexError, v } from 'convex/values';
import { query, mutation, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { operator, projectFor, denied } from './access';
import { gatewayProof } from './captureValidators';
import { capacity, command as commandValidator, runtimeFacts, savedScope, snapshot as snapshotValidator, receipt as receiptValidator } from './researchReadinessValidators';
import { canonical, verifyGateway } from '../packages/research-capture/src/proof';
import { hashValue } from '../packages/research-core/src/analysis';
import { requestId } from '../packages/research-core/src/limits';
import type { StudyCapability, StudyCapabilityReadiness, StudyEnvelopeCapacity, StudyReadinessCommand, StudyReadinessSnapshot, StudyRuntimeFacts } from '../packages/research-core/src/readiness';

declare const process: { env: Record<string, string | undefined> };
const zero = (): StudyEnvelopeCapacity => ({ interviewCalls: 0, speechSeconds: 0, speechCharacters: 0, captureBytes: 0, analysisCalls: 0 });
const mutable: StudyCapability[] = ['goal-aware-interview', 'voice', 'private-capture', 'analysis'];
type Scope = { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; studyId: Id<'researchStudies'>; studyVersion: number };
async function authorize(name: string, input: unknown, proof: { at: number; signature: string }) { await verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, `readiness:${name}`, input, proof); }
export function checkReadinessRuntime(runtime: StudyRuntimeFacts) {
  if (!/^[a-f0-9]{64}$/.test(runtime.configurationDigest) || !/^[a-f0-9]{64}$/.test(runtime.revision) || !Number.isSafeInteger(runtime.observedAt) || Math.abs(Date.now() - runtime.observedAt) > 10_000) return denied();
}
export async function savedReadinessStudy(ctx: QueryCtx, scope: Scope, ownerId: Id<'users'>) {
  const { client, project } = await projectFor(ctx, ownerId, scope.clientId, scope.projectId), study = await ctx.db.get(scope.studyId);
  if (!study || study.ownerId !== ownerId || study.clientId !== client._id || study.projectId !== project._id || study.version !== scope.studyVersion || !Number.isSafeInteger(scope.studyVersion)) return denied();
  return { study, active: client.state === 'active' && project.state === 'active', clientRevision: client.revision, projectRevision: project.revision };
}
async function envelopeFor(ctx: QueryCtx, ownerId: Id<'users'>) {
  const rows = await ctx.db.query('researchReadinessEnvelopes').withIndex('by_ownerId_and_enabled', q => q.eq('ownerId', ownerId).eq('enabled', true)).take(2);
  if (rows.length > 1) throw new ConvexError('Operator envelope is ambiguous');
  return rows[0] ?? null;
}
export async function admissionForStudy(ctx: QueryCtx, studyId: Id<'researchStudies'>) {
  return ctx.db.query('researchStudyAdmission').withIndex('by_studyId', q => q.eq('studyId', studyId)).unique();
}
/** New operator authority cannot fall back to old fixture policies. Historical records remain intact. */
export async function requireStudyCapability(ctx: QueryCtx, session: Doc<'researchSessions'>, capability: StudyCapability) {
  if (session.purpose === 'readiness-test') {
    if (capability !== 'private-capture') return denied();
    await checkTestCaptureBinding(ctx, session);
  }
  const binding = await admissionForStudy(ctx, session.studyId);
  if (!binding) {
    if (await ctx.db.query('researchReadinessEnvelopes').withIndex('by_ownerId_and_enabled', q => q.eq('ownerId', session.ownerId)).first()) return denied();
    return null; // Existing isolated qualification fixtures only.
  }
  const envelope = await ctx.db.get(binding.envelopeId);
  if (!envelope?.enabled || envelope.expiresAt <= Date.now() || !binding.enabled.includes(capability) || binding.ownerId !== session.ownerId || binding.projectId !== session.projectId || binding.clientId !== session.clientId) return denied();
  return binding;
}
export async function interviewPolicyForStudy(ctx: QueryCtx, session: Doc<'researchSessions'>) {
  const binding = await requireStudyCapability(ctx, session, 'goal-aware-interview');
  return binding ? binding.interviewPolicyId && await ctx.db.get(binding.interviewPolicyId) : ctx.db.query('researchInterviewPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
}
/** Prospective dispatch rechecks the running gateway inside this exact signed operation. */
export async function requireRunningStudyCapability(ctx: QueryCtx, session: Doc<'researchSessions'>, capability: StudyCapability, runtime?: StudyRuntimeFacts) {
  const binding = await requireStudyCapability(ctx, session, capability); if (!binding) return null;
  if (!runtime) return denied(); checkReadinessRuntime(runtime);
  const test = await checkTestCaptureBinding(ctx, session);
  if (test && (runtime.configurationDigest !== test.configurationDigest || runtime.revision !== test.runtimeRevision)) return denied();
  const gate = capability === 'goal-aware-interview' ? runtime.interview : capability === 'voice' ? runtime.voice : capability === 'private-capture' ? runtime.capture : runtime.analysis;
  const envelope = await ctx.db.get(binding.envelopeId);
  if (!gate.enabled || !gate.qualified || capability === 'goal-aware-interview' && runtime.interview.model !== envelope?.model || capability === 'analysis' && runtime.analysis.model !== envelope?.model) return denied();
  if (capability === 'private-capture') {
    const capture = await ctx.db.query('researchCaptures').withIndex('by_sessionId', q => q.eq('sessionId', session._id)).unique();
    if (!capture || runtime.capture.cleanupAllocationId !== process.env.RESEARCH_HOSTED_CLEANUP_ALLOCATION || !await captureCleanupCovered(ctx, capture)) return denied();
  }
  return binding;
}
const dimensions = (capability: StudyCapability): (keyof StudyEnvelopeCapacity)[] => capability === 'goal-aware-interview' ? ['interviewCalls'] : capability === 'voice' ? ['speechSeconds', 'speechCharacters'] : capability === 'private-capture' ? ['captureBytes'] : capability === 'analysis' ? ['analysisCalls'] : [];
const labels: Record<StudyCapability, string> = { 'scripted-text': 'Scripted text', 'goal-aware-interview': 'Goal-aware interview', voice: 'Voice', 'private-capture': 'Private capture and upload', analysis: 'Analysis', 'screen-baseline': 'Screen browser baseline', 'controlled-dom': 'Controlled DOM' };
function remaining(total: StudyEnvelopeCapacity, charged: StudyEnvelopeCapacity) { return Object.fromEntries(Object.keys(total).map(k => [k, Math.max(0, total[k as keyof StudyEnvelopeCapacity] - charged[k as keyof StudyEnvelopeCapacity])])) as StudyEnvelopeCapacity; }
async function compose(ctx: QueryCtx, scope: Scope, ownerId: Id<'users'>, runtime: StudyRuntimeFacts): Promise<StudyReadinessSnapshot & { scope: Scope }> {
  const source = await savedReadinessStudy(ctx, scope, ownerId), binding = await admissionForStudy(ctx, scope.studyId), envelope = binding ? await ctx.db.get(binding.envelopeId) : await envelopeFor(ctx, ownerId);
  if (binding && (binding.ownerId !== ownerId || binding.studyVersion !== scope.studyVersion || binding.clientId !== scope.clientId || binding.projectId !== scope.projectId)) return denied();
  const interview = binding?.interviewPolicyId ? await ctx.db.get(binding.interviewPolicyId) : null, voice = binding?.speechGrantId ? await ctx.db.get(binding.speechGrantId) : null;
  const free = envelope ? remaining(envelope.total, envelope.committed) : zero(), expiry = envelope?.expiresAt ?? null, expired = expiry !== null && expiry <= Date.now();
  const gateway = runtime.capture.gatewayAllocationId ? await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', runtime.capture.gatewayAllocationId!)).unique() : null;
  const cleanupAllocation = runtime.capture.cleanupAllocationId ? await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', runtime.capture.cleanupAllocationId!)).unique() : null;
  const cleanupReady = runtime.capture.cleanupAllocationId === process.env.RESEARCH_HOSTED_CLEANUP_ALLOCATION && await cleanupAdmissionReady(ctx, Date.now() + 30 * 86_400_000, captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON).segments);
  const deploymentAllowances = gateway ? [{ remaining: Math.max(0, gateway.requestLimit - gateway.requestsConsumed), unit: 'requests' as const, expiresAt: gateway.expiresAt }, { remaining: Math.max(0, gateway.readByteLimit - gateway.readBytesConsumed), unit: 'bytes' as const, expiresAt: gateway.expiresAt }, { remaining: Math.max(0, gateway.storageOperationLimit - gateway.storageOperationsConsumed), unit: 'storage-operations' as const, expiresAt: gateway.expiresAt }] : [];
  const activeSessions = await ctx.db.query('researchSessions').withIndex('by_studyId_and_purpose_and_state', q => q.eq('studyId', scope.studyId).eq('purpose', undefined).eq('state', 'active')).take(26);
  const largestPrompt = Math.max(1, ...source.study.definition.script.map(q => q.question.length), ...activeSessions.map(session => currentResearchPrompt(session, source.study)?.question.length ?? 0));
  const interviewOccupied = !!await ctx.db.query('researchInterviewAttempts').withIndex('by_active', q => q.eq('active', true)).first();
  const speechOccupied = [], scopedSpeechUnknown = [];
  for (const provider of ['deepgram', 'elevenlabs'] as const) {
    const attempts = await ctx.db.query('researchSpeechAttempts').withIndex('by_provider_and_active', q => q.eq('provider', provider).eq('active', true)).take(2);
    for (const attempt of attempts) {
      if (attempt.grantId === binding?.speechGrantId && ['unknown', 'interrupted'].includes(attempt.state)) scopedSpeechUnknown.push(attempt.requestId);
      const identity = attempt.transportLease, slot = identity ? await ctx.db.get(identity.leaseId) : null;
      const settled = !!identity && !!slot && (slot.generation > identity.generation || slot.generation === identity.generation && slot.requestId === identity.requestId && slot.owner === identity.owner && !slot.workStarted && slot.expiresAt === 0);
      if (!settled || !['unknown', 'interrupted'].includes(attempt.state)) speechOccupied.push(attempt.requestId);
    }
  }
  const analysisOccupied = [];
  for (const state of ['admitted', 'dispatching', 'unknown'] as const) if (await ctx.db.query('researchAnalyses').withIndex('by_projectId_and_state', q => q.eq('projectId', scope.projectId).eq('state', state)).first()) analysisOccupied.push(state);
  const enabled = binding?.enabled ?? [], capabilities: StudyCapabilityReadiness[] = [];
  for (const id of mutable) {
    const issued = binding?.issued.includes(id) ?? false, keys = dimensions(id), limits = issued ? {
      interviewCalls: Math.max(0, (interview?.allocatedCalls ?? 0) - (interview?.chargedCalls ?? 0)),
      speechSeconds: Math.max(0, (voice?.allocatedSeconds ?? 0) - (voice?.chargedSeconds ?? 0)),
      speechCharacters: Math.max(0, (voice?.allocatedCharacters ?? 0) - (voice?.chargedCharacters ?? 0)),
      captureBytes: Math.max(0, (binding?.captureByteLimit ?? 0) - (binding?.captureBytesCharged ?? 0)),
      analysisCalls: Math.max(0, (binding?.analysisCallLimit ?? 0) - (binding?.analysisCallsCharged ?? 0)),
    } : envelope ? envelope.partition : zero();
    const gate = id === 'goal-aware-interview' ? runtime.interview : id === 'voice' ? runtime.voice : id === 'private-capture' ? runtime.capture : runtime.analysis;
    const modelMatches = id === 'goal-aware-interview' ? runtime.interview.model === envelope?.model : id === 'analysis' ? runtime.analysis.model === envelope?.model : true;
    const occupied = id === 'goal-aware-interview' ? interviewOccupied : id === 'voice' ? speechOccupied.length > 0 || scopedSpeechUnknown.length > 0 : id === 'analysis' ? analysisOccupied.length > 0 : false;
    const enough = keys.every(k => limits[k] >= (k === 'speechSeconds' ? 60 : k === 'speechCharacters' ? largestPrompt : 1)) && (issued || keys.every(k => free[k] >= limits[k]));
    const gatewayReady = id !== 'private-capture' || cleanupReady && !!gateway && gateway.purpose !== 'cleanup' && gateway.expiresAt > Date.now() && gateway.requestsConsumed < gateway.requestLimit && gateway.storageOperationsConsumed + 3 <= gateway.storageOperationLimit;
    const setup = id === 'voice' && activeSessions.length > 25 || !gatewayReady || !source.active || !envelope?.enabled || !gate.enabled || !gate.qualified || !modelMatches;
    const state = occupied ? 'unresolved' : setup ? 'setup-required' : expired || !enough ? 'exhausted' : enabled.includes(id) ? 'ready' : 'off';
    capabilities.push({ id, label: labels[id], state, reason: occupied ? 'Check previous admitted work; charges are retained.' : setup ? 'Running server qualification and a finite operator envelope are required.' : expired ? 'The approved envelope has expired.' : !enough ? 'Remaining native allowance cannot admit the next operation.' : enabled.includes(id) ? 'Scoped opt-in is ready to request; provider success is not guaranteed.' : 'Explicit study opt-in is off.', allowances: envelope ? keys.map(k => ({ remaining: limits[k], unit: k === 'speechSeconds' ? 'seconds' : k === 'speechCharacters' ? 'characters' : k === 'captureBytes' ? 'bytes' : 'calls', expiresAt: expiry ?? 0 })) : [], canEnable: state === 'off', canDisable: enabled.includes(id) });
  }
  const dom = await ctx.db.query('researchDomPolicies').withIndex('by_studyId', q => q.eq('studyId', scope.studyId)).unique();
  capabilities.unshift({ id: 'scripted-text', label: labels['scripted-text'], state: source.active ? 'ready' : 'setup-required', reason: source.active ? 'Saved script is available with participant consent.' : 'Client or project is archived.', allowances: [], canEnable: false, canDisable: false });
  capabilities.push({ id: 'screen-baseline', label: labels['screen-baseline'], state: runtime.screenBaselineQualified ? 'ready' : 'setup-required', reason: 'Qualified browser baseline is not proof of the participant device.', allowances: [], canEnable: false, canDisable: false }, { id: 'controlled-dom', label: labels['controlled-dom'], state: dom ? 'ready' : 'setup-required', reason: dom ? 'Controlled origin is authorized; no received event is implied.' : 'Authorize a controlled prototype origin separately.', allowances: [], canEnable: false, canDisable: false });
  const revision = await hashValue({ scope, clientRevision: source.clientRevision, projectRevision: source.projectRevision, binding: binding ?? null, envelope: envelope ?? null, runtimeRevision: runtime.revision, interview, voice, interviewOccupied, speechOccupied, scopedSpeechUnknown, analysisOccupied, expired, dom, gateway, ...(runtime.capture.cleanupAllocationId ? {cleanupAllocation, cleanupReady}:{}), largestPrompt, activeSessionOverflow: activeSessions.length > 25 });
  const observedAt = Date.now(), authSessionId = await getAuthSessionId(ctx), authSession = authSessionId ? await ctx.db.get(authSessionId) : null;
  const validUntil = Math.max(observedAt, Math.min(observedAt + STUDY_READINESS_MAX_AGE_MS, authSession?.expirationTime ?? observedAt));
  return { scope, revision, runtimeConfigurationDigest: runtime.configurationDigest, observedAt, validUntil, expiresAt: expiry, deploymentAllowances, fallback: 'Continue with the saved text script. Capture and voice require matching participant consent.', capabilities, ...(envelope ? { envelope: { name: envelope.name, expiresAt: envelope.expiresAt, committed: envelope.committed, remainingUncommitted: free } } : {}) };
}
export const snapshot = query({ args: { scope: savedScope, runtime: runtimeFacts, proof: gatewayProof }, returns: snapshotValidator, handler: async (ctx, { proof, ...input }) => { await authorize('snapshot', input, proof); checkReadinessRuntime(input.runtime); const actor = await operator(ctx); return compose(ctx, input.scope, actor.userId, input.runtime); } });

async function issue(ctx: MutationCtx, scope: Scope, ownerId: Id<'users'>, id: StudyCapability) {
  let binding = await admissionForStudy(ctx, scope.studyId);
  const envelope = binding ? await ctx.db.get(binding.envelopeId) : await envelopeFor(ctx, ownerId);
  if (!envelope?.enabled || envelope.expiresAt <= Date.now()) return denied();
  if (!binding) {
    const bindingId = await ctx.db.insert('researchStudyAdmission', { ...scope, ownerId, envelopeId: envelope._id, revision: 0, enabled: [], issued: [], interviewPolicyId: null, speechGrantId: null, captureByteLimit: 0, captureBytesCharged: 0, analysisCallLimit: 0, analysisCallsCharged: 0 });
    binding = (await ctx.db.get(bindingId))!;
  }
  if (binding.issued.includes(id)) return binding;
  const committed = { ...envelope.committed };
  for (const key of dimensions(id)) { committed[key] += envelope.partition[key]; if (committed[key] > envelope.total[key]) return denied(); }
  const changes: Partial<Doc<'researchStudyAdmission'>> = { issued: [...binding.issued, id] };
  if (id === 'goal-aware-interview') changes.interviewPolicyId = await ctx.db.insert('researchInterviewPolicy', { name: `study-${scope.studyId}`, studyId: scope.studyId, enabled: true, qualification: 'root-reviewed-research-interview', allocatedCalls: envelope.partition.interviewCalls, chargedCalls: 0, maxSessionCalls: Math.min(60, envelope.partition.interviewCalls), model: envelope.model, maxInputBytes: envelope.maxInputBytes, maxOutputTokens: envelope.maxOutputTokens, expiresAt: envelope.expiresAt });
  if (id === 'voice') changes.speechGrantId = await ctx.db.insert('researchSpeechGrants', { name: `study-${scope.studyId}`, studyId: scope.studyId, enabled: true, purpose: 'continuous-research-study', qualification: 'root-reviewed-continuous-research-speech', allocatedSeconds: envelope.partition.speechSeconds, allocatedCharacters: envelope.partition.speechCharacters, chargedSeconds: 0, chargedCharacters: 0, maxSessionSeconds: envelope.partition.speechSeconds, maxSessionCharacters: envelope.partition.speechCharacters, expiresAt: envelope.expiresAt, createdAt: Date.now() });
  if (id === 'private-capture') changes.captureByteLimit = envelope.partition.captureBytes;
  if (id === 'analysis') changes.analysisCallLimit = envelope.partition.analysisCalls;
  await ctx.db.patch(envelope._id, { committed }); await ctx.db.patch(binding._id, changes);
  return (await ctx.db.get(binding._id))!;
}
export const command = mutation({ args: { command: commandValidator, runtime: runtimeFacts, proof: gatewayProof }, returns: receiptValidator, handler: async (ctx, { proof, ...input }) => {
  await authorize('command', input, proof); checkReadinessRuntime(input.runtime); const actor = await operator(ctx), cmd = input.command; requestId(cmd.requestId); await savedReadinessStudy(ctx, cmd.scope, actor.userId);
  const prior = await ctx.db.query('researchReadinessReceipts').withIndex('by_ownerId_and_requestId', q => q.eq('ownerId', actor.userId).eq('requestId', cmd.requestId)).unique();
  if (prior) { if (canonical(prior.receipt.command) !== canonical(cmd)) return denied(); return { ...prior.receipt, snapshot: await compose(ctx, cmd.scope, actor.userId, input.runtime) }; }
  let view = await compose(ctx, cmd.scope, actor.userId, input.runtime), reason = 'accepted', accepted = false;
  const row = view.capabilities.find(c => c.id === cmd.capability)!;
  if (view.revision !== cmd.expectedRevision) reason = 'stale-revision';
  else if (!mutable.includes(cmd.capability)) reason = 'read-only-capability';
  else if (cmd.enabled ? !row.canEnable : !row.canDisable) reason = row.state === 'unresolved' ? 'unresolved-work' : 'capability-unavailable';
  else {
    const binding = cmd.enabled ? await issue(ctx, cmd.scope, actor.userId, cmd.capability) : await admissionForStudy(ctx, cmd.scope.studyId);
    if (!binding) return denied();
    await ctx.db.patch(binding._id, { enabled: cmd.enabled ? [...binding.enabled.filter(id => id !== cmd.capability), cmd.capability] : binding.enabled.filter(id => id !== cmd.capability), revision: binding.revision + 1 });
    accepted = true; view = await compose(ctx, cmd.scope, actor.userId, input.runtime);
  }
  const receipt = { requestId: cmd.requestId, command: cmd, state: accepted ? 'accepted' as const : 'denied' as const, reason, snapshot: view };
  await ctx.db.insert('researchReadinessReceipts', { ownerId: actor.userId, requestId: cmd.requestId, receipt }); return receipt;
} });
/** Read-only reconciliation remains available with runtime OFF or expired envelopes. */
export const receipt = query({ args: { command: commandValidator, runtime: runtimeFacts, proof: gatewayProof }, returns: v.union(v.object({ state: v.literal('found'), receipt: receiptValidator }), v.object({ state: v.literal('unresolved') })), handler: async (ctx, { proof, ...input }) => {
  await authorize('receipt', input, proof); checkReadinessRuntime(input.runtime); const actor = await operator(ctx); requestId(input.command.requestId); await savedReadinessStudy(ctx, input.command.scope, actor.userId);
  const row = await ctx.db.query('researchReadinessReceipts').withIndex('by_ownerId_and_requestId', q => q.eq('ownerId', actor.userId).eq('requestId', input.command.requestId)).unique();
  if (!row) return { state: 'unresolved' as const }; if (canonical(row.receipt.command) !== canonical(input.command)) return denied(); return { state: 'found' as const, receipt: { ...row.receipt, snapshot: await compose(ctx, input.command.scope, actor.userId, input.runtime) } };
} });
/** Root alone creates prospective parent capacity. Operator endpoints cannot call this internal function. */
export const provision = internalMutation({ args: { name: v.string(), ownerId: v.id('users'), expiresAt: v.number(), total: capacity, partition: capacity, model: v.union(v.literal('qwen3.8-max'), v.literal('glm-5.3-flash')), maxInputBytes: v.number(), maxOutputTokens: v.number() }, returns: v.id('researchReadinessEnvelopes'), handler: async (ctx, input) => {
  requestId(input.name); const now = Date.now();
  const maxima: StudyEnvelopeCapacity = { interviewCalls: 1000, speechSeconds: 5400, speechCharacters: 108000, captureBytes: 4_000_000_000, analysisCalls: 100 };
  if (!await ctx.db.get(input.ownerId) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 30 * 86400000 || !Number.isSafeInteger(input.maxInputBytes) || input.maxInputBytes < 1 || input.maxInputBytes > 64000 || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 512) return denied();
  for (const key of Object.keys(maxima) as (keyof StudyEnvelopeCapacity)[]) if (![input.total[key], input.partition[key]].every(n => Number.isSafeInteger(n) && n >= 0) || input.total[key] > maxima[key] || input.partition[key] > input.total[key]) return denied();
  if (await ctx.db.query('researchReadinessEnvelopes').withIndex('by_name', q => q.eq('name', input.name)).first() || await envelopeFor(ctx, input.ownerId)) throw new ConvexError('Existing operator envelope cannot be reset or ambiguously superseded');
  return ctx.db.insert('researchReadinessEnvelopes', { ...input, enabled: true, committed: zero(), createdAt: now });
} });
export const disable = internalMutation({ args: { name: v.string() }, returns: v.null(), handler: async (ctx, args) => { const row = await ctx.db.query('researchReadinessEnvelopes').withIndex('by_name', q => q.eq('name', args.name)).unique(); if (!row) return denied(); await ctx.db.patch(row._id, { enabled: false }); return null; } });
