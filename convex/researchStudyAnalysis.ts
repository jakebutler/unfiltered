import type { StudyRuntimeFacts } from '../packages/research-core/src/readiness';
import { v, ConvexError } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import { operator, denied } from './access';
import { gatewayProof } from './captureValidators';
import { reservation, selection } from './reportValidators';
import { runtimeFacts, savedScope } from './researchReadinessValidators';
import { admissionForStudy, checkReadinessRuntime, requireRunningStudyCapability, requireStudyCapability, savedReadinessStudy } from './researchReadiness';
import { resolveEvidence } from './reportAccess';
import { checkSelections, hashValue, type Selection } from '../packages/research-core/src/analysis';
import { canonical, verifyGateway } from '../packages/research-capture/src/proof';
import { requestId } from '../packages/research-core/src/limits';
import type { Id } from './_generated/dataModel';
declare const process: { env: Record<string, string | undefined> };
type Scope = { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; studyId: Id<'researchStudies'>; studyVersion: number };
export async function studyAnalysisContext(ctx: QueryCtx, ownerId: Id<'users'>, scope: Scope, selections: Selection[]) {
  const { study } = await savedReadinessStudy(ctx, scope, ownerId); checkSelections(selections);
  const evidence = [];
  for (const selection of selections) {
    const sessionId = ctx.db.normalizeId('researchSessions', selection.sessionId), session = sessionId && await ctx.db.get(sessionId);
    if (!session || session.purpose === 'readiness-test' || session.studyId !== study._id) return denied();
    evidence.push(await resolveEvidence(ctx, { ...scope, ownerId }, selection));
  }
  const studyContext = JSON.stringify([{ studyId: study._id, version: study.version, definition: study.definition }]);
  return { evidence, studyContext, contextHash: await hashValue({ evidence, studyContext }) };
}
/** Issue once inside already committed child call capacity; uncertainty never restores it. */
export const prepare = mutation({ args: { scope: savedScope, requestId: v.string(), selections: v.array(selection), runtime: runtimeFacts, proof: gatewayProof }, returns: reservation, handler: async (ctx, { proof, ...input }) => {
  await verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, 'readiness:prepareAnalysis', input, proof); checkReadinessRuntime(input.runtime); const actor = await operator(ctx); requestId(input.requestId);
  const material = await studyAnalysisContext(ctx, actor.userId, input.scope, input.selections);
  const prior = await ctx.db.query('researchStudyAnalysisReservations').withIndex('by_studyId_and_requestId', q => q.eq('studyId', input.scope.studyId).eq('requestId', input.requestId)).unique();
  if (prior) { if (prior.ownerId !== actor.userId || prior.contextHash !== material.contextHash) return denied(); return prior.reservation; }
  const binding = await admissionForStudy(ctx, input.scope.studyId), envelope = binding && await ctx.db.get(binding.envelopeId);
  if (!binding || !envelope?.enabled || envelope.expiresAt <= Date.now() || !binding.enabled.includes('analysis') || !input.runtime.analysis.enabled || !input.runtime.analysis.qualified || input.runtime.analysis.model !== envelope.model) return denied();
  if (binding.analysisCallsCharged >= binding.analysisCallLimit) throw new ConvexError('Study analysis allowance is exhausted');
  for (const state of ['admitted', 'dispatching', 'unknown'] as const) if (await ctx.db.query('researchAnalyses').withIndex('by_projectId_and_state', q => q.eq('projectId', input.scope.projectId).eq('state', state)).first()) throw new ConvexError('Check previous analysis work');
  if (new TextEncoder().encode(material.studyContext + JSON.stringify(material.evidence)).length > envelope.maxInputBytes) throw new ConvexError('Selected evidence exceeds study allowance');
  const childReservation = { id: `study-analysis-${(await hashValue({ scope: input.scope, requestId: input.requestId, contextHash: material.contextHash })).slice(0, 64)}`, model: envelope.model, maxInputBytes: envelope.maxInputBytes, maxOutputTokens: envelope.maxOutputTokens, expiresAt: envelope.expiresAt, live: true };
  await ctx.db.patch(binding._id, { analysisCallsCharged: binding.analysisCallsCharged + 1 });
  await ctx.db.insert('researchStudyAnalysisReservations', { ownerId: actor.userId, studyId: input.scope.studyId, requestId: input.requestId, contextHash: material.contextHash, reservation: childReservation });
  return childReservation;
} });
export const readPrepared = query({ args: { scope: savedScope, requestId: v.string(), selections: v.array(selection), proof: gatewayProof }, returns: reservation, handler: async (ctx, { proof, ...input }) => {
  await verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, 'readiness:readPreparedAnalysis', input, proof); const actor = await operator(ctx); requestId(input.requestId);
  const material = await studyAnalysisContext(ctx, actor.userId, input.scope, input.selections);
  const row = await ctx.db.query('researchStudyAnalysisReservations').withIndex('by_studyId_and_requestId', q => q.eq('studyId', input.scope.studyId).eq('requestId', input.requestId)).unique();
  if (!row || row.ownerId !== actor.userId || row.contextHash !== material.contextHash) return denied(); return row.reservation;
} });
export async function requirePreparedAnalysisEnabled(ctx: QueryCtx, reservationId: string, runtime?: StudyRuntimeFacts) {
  const prepared = await ctx.db.query('researchStudyAnalysisReservations').withIndex('by_reservationId', q => q.eq('reservation.id', reservationId)).unique();
  if (!prepared) return;
  const binding = await admissionForStudy(ctx, prepared.studyId), envelope = binding && await ctx.db.get(binding.envelopeId);
  if (!binding?.enabled.includes('analysis') || !envelope?.enabled || envelope.expiresAt <= Date.now() || !runtime) return denied();
  checkReadinessRuntime(runtime); if (!runtime.analysis.enabled || !runtime.analysis.qualified || runtime.analysis.model !== envelope.model) return denied();
}
/** Existing analysis dispatch consumes the prepared immutable reservation, never another child charge. */
export async function validateStudyAnalysisReservation(ctx: QueryCtx, ownerId: Id<'users'>, input: { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; requestId: string; selections: Selection[]; reservation: unknown; runtime?: StudyRuntimeFacts }) {
  const sessions = [];
  for (const selection of input.selections) { const id = ctx.db.normalizeId('researchSessions', selection.sessionId), session = id && await ctx.db.get(id); if (!session || session.purpose === 'readiness-test') return denied(); sessions.push(session); }
  const bindings = await Promise.all(sessions.map(s => admissionForStudy(ctx, s.studyId)));
  if (!bindings.some(Boolean)) {
    if (await ctx.db.query('researchReadinessEnvelopes').withIndex('by_ownerId_and_enabled', q => q.eq('ownerId', ownerId)).first()) return denied();
    return; // Preserve historical isolated reservation fixtures.
  }
  const studyId = sessions[0].studyId, study = await ctx.db.get(studyId); if (!study || sessions.some(s => s.studyId !== studyId)) return denied();
  for (const session of sessions) await requireRunningStudyCapability(ctx, session, 'analysis', input.runtime);
  const prepared = await ctx.db.query('researchStudyAnalysisReservations').withIndex('by_studyId_and_requestId', q => q.eq('studyId', studyId).eq('requestId', input.requestId)).unique();
  const material = await studyAnalysisContext(ctx, ownerId, { clientId: input.clientId, projectId: input.projectId, studyId, studyVersion: study.version }, input.selections);
  if (!prepared || prepared.ownerId !== ownerId || prepared.contextHash !== material.contextHash || canonical(prepared.reservation) !== canonical(input.reservation)) return denied();
}
