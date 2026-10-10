import { paginationOptsValidator } from 'convex/server';
import { v, ConvexError } from 'convex/values';
import { clientFor, operatorMutation, operatorQuery, pageResult, pageSize, projectFor, revision } from './access';
import { clientView, lifecycle, projectView, sessionState, sourcePage, study } from './validators';
import { assertContextSafe, boundedText, RESEARCH_LIMITS as LIMITS, safeReference } from '../packages/research-core/src/limits';

export const me = operatorQuery({ args: {}, returns: v.object({ name: v.string() }), handler: async ctx => ({ name: ctx.operator.name }) });
export const project = operatorQuery({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects') }, returns: v.object({ client: clientView, project: projectView }), handler: async (ctx, args) => {
  const { client, project } = await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId);
  return { client: { _id: client._id, name: client.name, state: client.state, revision: client.revision, updatedAt: client.updatedAt }, project: { _id: project._id, clientId: project.clientId, name: project.name, state: project.state, revision: project.revision, latestStudyVersion: project.latestStudyVersion, updatedAt: project.updatedAt } };
} });
export const clients = operatorQuery({ args: { paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(clientView), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  pageSize(args.paginationOpts.numItems);
  const result = await ctx.db.query('researchClients').withIndex('by_ownerId', q => q.eq('ownerId', ctx.operator.userId)).order('desc').paginate(args.paginationOpts);
  return { ...pageResult(result), page: result.page.map(({ _id, name, state, revision, updatedAt }) => ({ _id, name, state, revision, updatedAt })) };
} });
export const createClient = operatorMutation({ args: { name: v.string() }, returns: v.id('researchClients'), handler: async (ctx, args) => ctx.db.insert('researchClients', { ownerId: ctx.operator.userId, name: boundedText(args.name, 100, 'client name'), state: 'active', revision: 0, updatedAt: Date.now() }) });
export const updateClient = operatorMutation({ args: { clientId: v.id('researchClients'), expectedRevision: v.number(), name: v.string(), state: lifecycle }, returns: v.null(), handler: async (ctx, args) => {
  const client = await clientFor(ctx, ctx.operator.userId, args.clientId); revision(client.revision, args.expectedRevision);
  await ctx.db.patch(client._id, { name: boundedText(args.name, 100, 'client name'), state: args.state, revision: client.revision + 1, updatedAt: Date.now() }); return null;
} });
export const projects = operatorQuery({ args: { clientId: v.id('researchClients'), paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(projectView), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  await clientFor(ctx, ctx.operator.userId, args.clientId); pageSize(args.paginationOpts.numItems);
  const result = await ctx.db.query('researchProjects').withIndex('by_ownerId_and_clientId', q => q.eq('ownerId', ctx.operator.userId).eq('clientId', args.clientId)).order('desc').paginate(args.paginationOpts);
  return { ...pageResult(result), page: result.page.map(({ _id, clientId, name, state, revision, latestStudyVersion, updatedAt }) => ({ _id, clientId, name, state, revision, latestStudyVersion, updatedAt })) };
} });
export const createProject = operatorMutation({ args: { clientId: v.id('researchClients'), name: v.string() }, returns: v.id('researchProjects'), handler: async (ctx, args) => {
  const client = await clientFor(ctx, ctx.operator.userId, args.clientId); if (client.state !== 'active') throw new ConvexError('Client is archived');
  return ctx.db.insert('researchProjects', { ownerId: ctx.operator.userId, clientId: client._id, name: boundedText(args.name, 100, 'project name'), state: 'active', revision: 0, latestStudyVersion: 0, updatedAt: Date.now() });
} });
export const updateProject = operatorMutation({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), expectedRevision: v.number(), name: v.string(), state: lifecycle }, returns: v.null(), handler: async (ctx, args) => {
  const { project } = await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); revision(project.revision, args.expectedRevision);
  await ctx.db.patch(project._id, { name: boundedText(args.name, 100, 'project name'), state: args.state, revision: project.revision + 1, updatedAt: Date.now() }); return null;
} });
export const saveStudy = operatorMutation({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), expectedRevision: v.number(), definition: study }, returns: v.object({ studyId: v.id('researchStudies'), version: v.number(), projectRevision: v.number() }), handler: async (ctx, args) => {
  const { client, project } = await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); revision(project.revision, args.expectedRevision);
  if (client.state !== 'active' || project.state !== 'active') throw new ConvexError('Project is archived');
  const d = args.definition;
  if (d.goals.length < 1 || d.goals.length > LIMITS.goals || d.script.length < 1 || d.script.length > LIMITS.scriptQuestions) throw new ConvexError('A study needs 1–12 goals and 1–30 questions');
  const definition = { ...d, title: boundedText(d.title, 100, 'study title'), introduction: boundedText(d.introduction, 2000, 'introduction'), goals: d.goals.map(g => boundedText(g, 500, 'goal')), script: d.script.map(q => ({ id: boundedText(q.id, 80, 'question identifier'), question: boundedText(q.question, 2000, 'question') })), prototypeUrl: d.prototypeUrl === null ? null : safeReference(d.prototypeUrl) };
  if (new Set(definition.script.map(q => q.id)).size !== definition.script.length) throw new ConvexError('Question identifiers must be unique');
  if (d.repository) {
    if (d.repository.files.length > LIMITS.contextFiles) throw new ConvexError('At most eight context files');
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(d.repository.revision)) throw new ConvexError('Pin repository context to a full commit hash');
    const repo = { url: safeReference(d.repository.url), revision: boundedText(d.repository.revision, 128, 'repository revision'), files: d.repository.files.map(file => {
      const path = boundedText(file.path, 240, 'context path');
      if (path.startsWith('/') || path.includes('..') || /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key)$/i.test(path)) throw new ConvexError('Choose a safe relative source path');
      assertContextSafe(file.text); return { path, text: file.text };
    }) };
    if (new Set(repo.files.map(f => f.path)).size !== repo.files.length || new TextEncoder().encode(JSON.stringify(repo)).length > LIMITS.contextBytes) throw new ConvexError('Context is duplicated or exceeds 48 KB');
    definition.repository = repo;
  }
  assertContextSafe(JSON.stringify(definition));
  const version = project.latestStudyVersion + 1;
  const studyId = await ctx.db.insert('researchStudies', { ownerId: ctx.operator.userId, clientId: client._id, projectId: project._id, version, definition, createdAt: Date.now() });
  await ctx.db.patch(project._id, { latestStudyVersion: version, revision: project.revision + 1, updatedAt: Date.now() });
  return { studyId, version, projectRevision: project.revision + 1 };
} });
export const readStudy = operatorQuery({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), version: v.number() }, returns: v.union(v.object({ studyId: v.id('researchStudies'), version: v.number(), definition: study }), v.null()), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId);
  if (!Number.isSafeInteger(args.version) || args.version < 1) throw new ConvexError('Invalid study version');
  const row = await ctx.db.query('researchStudies').withIndex('by_projectId_and_version', q => q.eq('projectId', args.projectId).eq('version', args.version)).unique();
  return row ? { studyId: row._id, version: row.version, definition: row.definition } : null;
} });
export const sessionSources = operatorQuery({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), sessionId: v.id('researchSessions'), paginationOpts: paginationOptsValidator }, returns: sourcePage, handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); pageSize(args.paginationOpts.numItems);
  const session = await ctx.db.get(args.sessionId);
  if (!session || session.projectId !== args.projectId || session.clientId !== args.clientId || session.ownerId !== ctx.operator.userId || session.retainUntil <= Date.now()) throw new ConvexError('Access unavailable');
  return pageResult(await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', session._id)).paginate(args.paginationOpts));
} });
export const sessions = operatorQuery({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(v.object({ sessionId: v.id('researchSessions'), studyId: v.id('researchStudies'), state: sessionState, revision: v.number(), sourceCount: v.number(), savedAt: v.number(), retainUntil: v.number() })), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); pageSize(args.paginationOpts.numItems);
  const result = await ctx.db.query('researchSessions').withIndex('by_projectId', q => q.eq('projectId', args.projectId)).order('desc').paginate(args.paginationOpts);
  return { ...pageResult(result), page: result.page.map(({ _id, studyId, state, revision, sourceCount, savedAt, retainUntil }) => ({ sessionId: _id, studyId, state, revision, sourceCount, savedAt, retainUntil })) };
} });
