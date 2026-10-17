import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { denied } from './access';
import { studyWelcome } from '../packages/research-core/src/welcome';
export async function welcomeForStudy(ctx: QueryCtx, study: Doc<'researchStudies'>, lifecycle: { expiresAt?: number; retainUntil?: number; purpose?: 'readiness-test' } = {}) {
  const client = await ctx.db.get(study.clientId), member = await ctx.db.query('researchOperators').withIndex('by_role', q => q.eq('role', 'operator')).unique();
  if (!client || client.ownerId !== study.ownerId) return denied();
  const scope = { clientId: study.clientId, projectId: study.projectId, studyId: study._id, studyVersion: study.version };
  return { ...studyWelcome({ scope, title: study.definition.title, introduction: study.definition.introduction, prototypeUrl: study.definition.prototypeUrl, clientName: client.name, operatorName: member?.userId === study.ownerId ? member.name : 'Corvo Labs', captureExpectation: study.definition.captureExpectation, ...lifecycle }), scope };
}
