import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { denied } from './access';
import { hashValue } from '../packages/research-core/src/analysis';
export async function studyCaptureIdentity(ctx: QueryCtx, study: Doc<'researchStudies'>) {
  const policy = await ctx.db.query('researchDomPolicies').withIndex('by_studyId', q => q.eq('studyId', study._id)).unique();
  return { policy, identity: await hashValue({ studyId: study._id, version: study.version, definition: study.definition, policy: policy ? { id: policy._id, origin: policy.origin, componentIds: policy.componentIds, approvedAt: policy.approvedAt } : null }) };
}
export async function testForSession(ctx: QueryCtx, sessionId: Id<'researchSessions'>) {
  return ctx.db.query('researchCaptureTests').withIndex('by_sessionId', q => q.eq('sessionId', sessionId)).unique();
}
/** A test's immutable saved study/policy identity must still match before new capture work. */
export async function checkTestCaptureBinding(ctx: QueryCtx, session: Doc<'researchSessions'>) {
  if (session.purpose !== 'readiness-test') return null;
  const test = await testForSession(ctx, session._id), study = await ctx.db.get(session.studyId), project = await ctx.db.get(session.projectId);
  if (!test || !study || test.ownerId !== session.ownerId || test.scope.studyId !== study._id || test.scope.clientId !== session.clientId || test.scope.projectId !== session.projectId || project?.latestStudyVersion !== study.version || test.studyIdentity !== (await studyCaptureIdentity(ctx, study)).identity) return denied();
  return test;
}
