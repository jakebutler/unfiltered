import { v } from 'convex/values';
import { captureExpectation } from './researchWelcomeValidators';

export const lifecycle = v.union(v.literal('active'), v.literal('archived'));
export const sessionState = v.union(v.literal('invited'), v.literal('active'), v.literal('paused'), v.literal('completed'), v.literal('partial'));
export const consent = v.object({
  version: v.literal('research-consent-1'), storage: v.boolean(), analysis: v.boolean(),
  microphone: v.boolean(), camera: v.boolean(), screen: v.boolean(),
  dom: v.optional(v.boolean()), shareDom: v.optional(v.boolean()),
  shareTranscript: v.boolean(), shareAudio: v.boolean(), shareCamera: v.boolean(), shareScreen: v.boolean(),
  retainApprovedExcerpts: v.boolean(),
});
export const study = v.object({
  title: v.string(), introduction: v.string(), goals: v.array(v.string()),
  script: v.array(v.object({ id: v.string(), question: v.string() })),
  captureExpectation: v.optional(captureExpectation),
  prototypeUrl: v.union(v.string(), v.null()),
  repository: v.union(v.object({ url: v.string(), revision: v.string(), files: v.array(v.object({ path: v.string(), text: v.string() })) }), v.null()),
});
export const sourceFields = {
  sessionId: v.id('researchSessions'), clientId: v.id('researchClients'), projectId: v.id('researchProjects'),
  sequence: v.number(), sourceId: v.string(), requestId: v.string(), questionId: v.string(),
  author: v.union(v.literal('participant'), v.literal('interviewer')),
  intent: v.optional(v.union(v.literal('answer'), v.literal('skip'))),
  channel: v.union(v.literal('text'), v.literal('confirmed-transcript'), v.literal('unreviewed-transcript'), v.literal('spoken-answer'), v.literal('script'), v.literal('follow-up')),
  text: v.string(), recordedAt: v.number(), supersedes: v.union(v.string(), v.null()),
};
export const sourceView = v.object({ ...sourceFields, _id: v.id('researchSources'), _creationTime: v.number() });
export const clientView = v.object({ _id: v.id('researchClients'), name: v.string(), state: lifecycle, revision: v.number(), updatedAt: v.number() });
export const projectView = v.object({ _id: v.id('researchProjects'), clientId: v.id('researchClients'), name: v.string(), state: lifecycle, revision: v.number(), latestStudyVersion: v.number(), updatedAt: v.number() });
export const sourcePage = v.object({ page: v.array(sourceView), isDone: v.boolean(), continueCursor: v.string() });
