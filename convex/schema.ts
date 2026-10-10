import { defineSchema, defineTable } from 'convex/server';
import { authTables } from '@convex-dev/auth/server';
import { v } from 'convex/values';
import { consent, lifecycle, sessionState, sourceFields, study } from './validators';

export default defineSchema({
  ...authTables,
  researchOperators: defineTable({ role: v.literal('operator'), userId: v.id('users'), name: v.string(), active: v.boolean() }).index('by_role', ['role']),
  researchClients: defineTable({ ownerId: v.id('users'), name: v.string(), state: lifecycle, revision: v.number(), updatedAt: v.number() }).index('by_ownerId', ['ownerId']),
  researchProjects: defineTable({ ownerId: v.id('users'), clientId: v.id('researchClients'), name: v.string(), state: lifecycle, revision: v.number(), latestStudyVersion: v.number(), updatedAt: v.number() }).index('by_ownerId_and_clientId', ['ownerId', 'clientId']),
  researchStudies: defineTable({ ownerId: v.id('users'), clientId: v.id('researchClients'), projectId: v.id('researchProjects'), version: v.number(), definition: study, createdAt: v.number() }).index('by_projectId_and_version', ['projectId', 'version']),
  researchInvitations: defineTable({ ownerId: v.id('users'), clientId: v.id('researchClients'), projectId: v.id('researchProjects'), studyId: v.id('researchStudies'), tokenHash: v.string(), sessionId: v.id('researchSessions'), expiresAt: v.number(), revokedAt: v.union(v.number(), v.null()), requestId: v.string() }).index('by_tokenHash', ['tokenHash']).index('by_projectId_and_requestId', ['projectId', 'requestId']),
  researchSessions: defineTable({ ownerId: v.id('users'), clientId: v.id('researchClients'), projectId: v.id('researchProjects'), studyId: v.id('researchStudies'), state: sessionState, revision: v.number(), nextQuestion: v.number(), sourceCount: v.number(), consent: v.union(consent, v.null()), consentAt: v.union(v.number(), v.null()), createdAt: v.number(), savedAt: v.number(), retainUntil: v.number() }).index('by_projectId', ['projectId']),
  researchSources: defineTable(sourceFields).index('by_sessionId_and_sequence', ['sessionId', 'sequence']).index('by_sessionId_and_requestId', ['sessionId', 'requestId']).index('by_sessionId_and_sourceId', ['sessionId', 'sourceId']).index('by_sessionId_and_supersedes', ['sessionId', 'supersedes']),
});
