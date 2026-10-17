import { expect, it, vi } from 'vitest';
import { createFullReplyManifest, prepareFullCapture, type FullReplyDraft } from '../src/adaptive-reply-full.js';
import { createFullCompactManifest, encodeFullCompactDraft, decodeFullCompactDraft, consumeFullCompactStream, fullCompactStreamProposer, fullCompactSchemaName } from '../src/adaptive-reply-full-compact.js';
import { createCompactReplyManifest } from '../src/adaptive-reply-compact.js';
import { prepareDigitalOceanStreamRequest } from '../../clinical-core/src/digitalocean-stream.js';
import { fullDevelopmentContext, representativeFullDraft } from '../../../scripts/qualification/fixtures/adaptive-full-development.js';
import { scenarios } from '../../clinical-core/src/domain.js';
import { conversation } from '../src/conversation.js';
import { adaptiveSession } from '../src/adaptive-session.js';
import { document, readDraft, DRAFT_SYSTEM } from '../src/store.js';
import { ApiFailure, type ClinicApiConfig, type Draft, type StoredDraft } from '../src/types.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import { fullDevelopmentSource } from '../../../scripts/qualification/fixtures/adaptive-full-development.js';
import type { FullReplyManifest } from '../src/adaptive-reply-full.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import { context as legacyContext } from './fixtures/adaptive.js';
const config = { endpoint: 'https://inference.do-ai.run' as const, model: 'qwen3.8-max' as const, apiKey: 'offline-only', timeoutMs: 1000, maxOutputTokens: 4096, maxRequestBytes: 131072 };
function fixture() {
  const context = fullDevelopmentContext(), full = createFullReplyManifest(context), manifest = createFullCompactManifest(full), draft = representativeFullDraft(full);
  return { context, full, manifest, draft, advance: { manifestId: full.id, actionId: full.actions.at(-1)!.id, controls: [], defer: [] } };
}
function event(content: string | null, finish: string | null = null) { return `data: ${JSON.stringify({ id: 'full-offline', model: config.model, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`; }
function response(text: string) { return new Response(event(text) + event(null,'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); }
it('roundtrips all full semantics and reduces authored representative bytes', () => {
  const { draft, full } = fixture();
  draft.claims[0].correctsSourceIds = ['earlier-source']; draft.claims[0].scope.period = 'current report';
  const wire = encodeFullCompactDraft(draft); expect(decodeFullCompactDraft(wire)).toEqual(draft);
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(Buffer.byteLength(JSON.stringify(draft)) * .7);
  expect(full.targets.some(target => /^MH0[1-4]$/.test(target.path))).toBe(false);
});
it('retains all560 possible unique full evidence addresses under128k', () => {
  const { draft } = fixture(), addresses = (kind: string, i: number, n: number) => Array.from({ length: n },(_,j) => ({ statementId: `s-${kind}-${i}`, quote: `unique ${kind} ${i} ${j}` }));
  const boundary: FullReplyDraft = { ...draft, claims: Array.from({ length: 64 },(_,i) => { const a = addresses('claim',i,6); return { ...draft.claims[0], targetId: `t${i}`, valueEvidence: a[4], evidence: a.slice(0,4), scope: { ...draft.claims[0].scope, predicate: a[5] } }; }),
    items: Array.from({ length: 16 },(_,i) => ({ collectionId: 't0', key: `item${i}`, entity: `entity${i}`, evidence: addresses('item',i,4) })),
    closures: Array.from({ length: 16 },(_,i) => ({ collectionId: `t${i}`, evidence: addresses('closure',i,4) })),
    acts: Array.from({ length: 4 },(_,i) => ({ kind: 'answer', targetTopicId: null, replyId: null, evidence: addresses('act',i,4) })),
    residual: Array.from({ length: 8 },(_,i) => ({ reason: 'ambiguous', evidence: addresses('gap',i,4) })) };
  const wire = encodeFullCompactDraft(boundary); expect(wire.a).toHaveLength(560); expect(decodeFullCompactDraft(wire)).toEqual(boundary); expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(128000);
});
it('rejects duplicate, unused, invalid anchor references and item keys', () => {
  const { draft } = fixture(), wire = encodeFullCompactDraft(draft);
  expect(() => decodeFullCompactDraft({ ...wire, a: [...wire.a,wire.a[0]] })).toThrow('duplicate-full-compact-anchor');
  expect(() => decodeFullCompactDraft({ ...wire, a: [...wire.a,{ s: 'unused',q: 'unused' }] })).toThrow('unused-full-compact-anchor');
  expect(() => decodeFullCompactDraft({ ...wire, c: [{ ...wire.c[0], f: 559 }] })).toThrow('invalid-full-compact-reference');
  expect(() => decodeFullCompactDraft({ ...wire, i: [{ ...wire.i[0], k: 'unsafe.key' }] })).toThrow();
});
it('uses actual full-only factory and exact full source admission, once', async () => {
  const { context,full,advance,draft } = fixture(), onAdvance = vi.fn(), fetcher = vi.fn<Fetch>().mockResolvedValue(response(JSON.stringify({ advance,draft: encodeFullCompactDraft(draft) })));
  const result = await fullCompactStreamProposer(config,{ fetcher }).propose(context,full,{ onAdvance,signal: new AbortController().signal });
  expect(onAdvance).toHaveBeenCalledWith(advance); expect(result.draft).toEqual(draft); expect(result.receipt).toMatchObject({ outcome: 'complete',providerExecution: 'completed',usage: 'unknown' });
  expect(prepareFullCapture(result.draft,full)).toMatchObject({ policy: 'provisional-intake-v2',items: [{ entity: 'Vitamin C' }],closures: [{ collection: 'medicines' }] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body)); expect(body).toMatchObject({ stream: true,max_tokens: 4096,response_format: { type: 'json_schema' } });
  await expect(fullCompactStreamProposer(config,{ fetcher }).propose(context,createCompactReplyManifest(legacyContext('I am unsure.', ['Q04','Q05'])),{ onAdvance,signal: new AbortController().signal })).rejects.toMatchObject({ code: 'full-stream-manifest-required' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects invented quotes and changed context with no semantic admission', async () => {
  const { context,manifest,advance,draft } = fixture(), wire = encodeFullCompactDraft(draft); wire.a[0].q = 'invented quote';
  const fetcher = vi.fn<Fetch>().mockResolvedValue(response(JSON.stringify({ advance,draft: wire })));
  await expect(consumeFullCompactStream(config,manifest,{ fetcher })).rejects.toMatchObject({ code: 'source-quote-not-found',receipt: { outcome: 'rejected' } });
  context.source.text += 'changed';
  await expect(consumeFullCompactStream(config,manifest,{ fetcher })).rejects.toMatchObject({ code: 'unissued-or-stale-full-manifest' }); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('binds supplied proposer context to issued patient/session/operation/source before dispatch', async () => {
  const { context,full,advance,draft } = fixture(), fetcher = vi.fn<Fetch>().mockResolvedValue(response(JSON.stringify({advance,draft:encodeFullCompactDraft(draft)})));
  const proposer = fullCompactStreamProposer(config,{fetcher}), run = {onAdvance:vi.fn(),signal:new AbortController().signal};
  for (const other of [
    { ...context,binding:{...context.binding,patient:'Patient/other'} },
    { ...context,binding:{...context.binding,sessionId:'other-session'} },
    { ...context,binding:{...context.binding,operationId:'other-operation'} },
    { ...context,source:{...context.source,id:'other-source'} },
    { ...context,source:{...context.source,text:'Different exact saved words.'} },
  ]) await expect(proposer.propose(other,full,run)).rejects.toMatchObject({code:'full-reply-context-manifest-mismatch'});
  expect(fetcher).not.toHaveBeenCalled(); expect(run.onAdvance).not.toHaveBeenCalled();
  expect((await proposer.propose(structuredClone(context),full,run)).draft).toEqual(draft); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('emits a closed advance while fragmented tail remains pending, never retracts on bad tail', async () => {
  const { manifest,advance } = fixture(), emitted = vi.fn(); let controller!: ReadableStreamDefaultController<Uint8Array>, release!: () => void;
  const early = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response(new ReadableStream({ start(c) { controller = c; } }),{ headers: { 'Content-Type':'text/event-stream' } }));
  const result = consumeFullCompactStream(config,manifest,{ fetcher,onAdvance: packet => { emitted(packet); release(); } });
  const bytes = new TextEncoder().encode(event('{"advance":'+JSON.stringify(advance)+',"draft":'));
  for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); await early; expect(emitted).toHaveBeenCalledTimes(1);
  controller.enqueue(new TextEncoder().encode(event('{"m":"bad"}')+event(null,'stop')+'data: [DONE]\n\n')); controller.close();
  await expect(result).rejects.toMatchObject({ receipt: { outcome:'rejected',providerExecution:'unknown' } }); expect(emitted).toHaveBeenCalledTimes(1);
});
it('known semantic finish plus incomplete tail rejects capture and keeps unknown usage distinct', async () => {
  const { manifest,advance } = fixture(), emitted = vi.fn();
  await expect(consumeFullCompactStream(config,manifest,{ fetcher: async () => response('{"advance":'+JSON.stringify(advance)+',"draft":{"m":'),onAdvance: emitted })).rejects.toMatchObject({ code:'action-object-truncated',receipt: { providerExecution:'completed',usage:'unknown',outcome:'rejected' } });
  expect(emitted).toHaveBeenCalledTimes(1);
});
it('measures exact all7 request sizes and authored representative output ceiling without dispatch', async () => {
  const sizes: Record<string,number> = {};
  for (const scenario of scenarios) { const full = createFullReplyManifest(fullDevelopmentContext(scenario)), manifest = createFullCompactManifest(full);
    sizes[scenario] = (await prepareDigitalOceanStreamRequest({ ...config,responseFormat:{ type:'json-schema',name:fullCompactSchemaName,schema:manifest.jsonSchema } },[...manifest.messages])).requestBytes;
  }
  expect(Object.keys(sizes)).toHaveLength(7); expect(Math.max(...Object.values(sizes))).toBeLessThan(config.maxRequestBytes);
  const { draft } = fixture(), expandedBytes = Buffer.byteLength(JSON.stringify(draft)), compactBytes = Buffer.byteLength(JSON.stringify(encodeFullCompactDraft(draft)));
  console.log(JSON.stringify({ syntheticOnly:true,requestBytes:sizes,representative:{ expandedBytes,compactBytes,estimatedTokensFourBytesEach:Math.ceil(compactBytes/4),actualTokenizerUsed:false },candidateMaxOutputTokens:4096,timeoutMs:12000,callCount:0 }));
});


it.each([true,false])('actual transport→session preserves early prompt and durable readback when full tail valid=%s', async valid => {
  const patient = { reference:'Patient/test',displayName:'Synthetic',description:'Offline',careTeams:{medical:'CareTeam/md',nutrition:'CareTeam/rd',administrative:'CareTeam/admin'} };
  const content = conversation({ mentalHealth:'phq4',patients:Object.fromEntries(scenarios.map(id => [id,patient])) } as ClinicApiConfig);
  let finish!: () => void, notify!: () => void;
  const early = new Promise<void>(resolve => { notify = resolve; });
  const fetcher = vi.fn<Fetch>(async (_url,init) => {
    const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
    const full = { id:payload.manifestId,messages:body.messages,targets:payload.targets } as FullReplyManifest;
    const draft = representativeFullDraft(full), advance = { manifestId:full.id,actionId:payload.actions.at(-1).id,controls:[],defer:[] };
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(event('{"advance":'+JSON.stringify(advance)+',"draft":')));
      finish = () => { c.enqueue(new TextEncoder().encode(event(valid ? JSON.stringify(encodeFullCompactDraft(draft))+'}' : '{"m":')+event(null,'stop')+'data: [DONE]\n\n')); c.close(); };
    } }),{ headers:{'Content-Type':'text/event-stream'} });
  });
  const api = adaptiveSession(content,undefined,{fullCapture:true,streamProposer:fullCompactStreamProposer(config,{fetcher}),timeoutMs:1000,onReplySaved:notify});
  const now = new Date().toISOString(), initial = api.initialize({schema:1,id:crypto.randomUUID(),patient:'Patient/test',scenario:'first-intake',revision:0,createdAt:now,savedAt:now,phase:'conversation',turns:[],topics:{},requests:{},version:1} as Draft);
  let stored: StoredDraft = { draft:initial,versionId:'1',resource:{...document(DRAFT_SYSTEM,initial.id,initial.patient,initial),id:'offline',meta:{versionId:'1'}} };
  const client = { request:async () => ({body:{resourceType:'Bundle',type:'searchset',total:1,entry:[{resource:structuredClone(stored.resource)}]}}) } as unknown as MedplumClient;
  const store = { read:() => readDraft(client,initial.id,initial.patient),save:async (previous:StoredDraft,next:Draft) => {
    if (previous.versionId !== stored.versionId) throw new ApiFailure('stale-session',409);
    const versionId = String(Number(stored.versionId)+1); stored={draft:structuredClone(next),versionId,resource:{...document(DRAFT_SYSTEM,initial.id,initial.patient,next),id:'offline',meta:{versionId}}}; return readDraft(client,initial.id,initial.patient);
  }};
  const accepted = await api.accept(store,{requestId:crypto.randomUUID(),expectedRevision:0,text:fullDevelopmentSource.text,channel:'text'});
  const running = api.interpret(store,accepted.operation.id); await early;
  const earlySaved = await store.read(), question = structuredClone(earlySaved.draft.adaptive!.exchange);
  expect(earlySaved.draft.adaptive!.operations[accepted.operation.id].stream).toMatchObject({reply:'saved',capture:'pending'});
  const queued = await api.accept(store,{requestId:crypto.randomUUID(),expectedRevision:earlySaved.draft.revision,text:'Another source saved during extraction.',channel:'text'});
  expect(queued.operation.queuedWaiting).toBe(true); finish(); await running;
  const settled = await store.read(), parent = settled.draft.adaptive!.operations[accepted.operation.id];
  expect(settled.draft.adaptive!.exchange).toEqual(question); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(parent.status).toBe(valid ? 'applied':'failed'); expect(parent.stream?.capture).toBe(valid ? 'saved':'partial');
  expect(parent.stream?.receipt).toMatchObject({providerExecution:'completed',usage:'unknown'});
  expect(settled.draft.turns.filter(turn => turn.role === 'patient').map(turn => turn.text)).toEqual([fullDevelopmentSource.text,'Another source saved during extraction.']);
  // Both fixtures have known provider finish. A rejected capture releases the
  // queued source's eligibility; it does not dispatch it or retry the parent.
  expect(settled.draft.adaptive!.operations[queued.operation.id].queuedWaiting).toBe(false);
  if (valid) {
    expect(content.effective(settled.draft).responses.Q08.answers.medicines?.items?.[0].answers.name).toMatchObject({state:'known',value:'Vitamin C'});
    expect(content.view(settled.draft,true,true).completeness).toBe('partial');
  } else {
    const recovered = await api.discard(store,queued.operation.id,settled.draft.revision);
    expect(recovered.draft.turns.filter(turn => turn.role === 'patient')).toHaveLength(2); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await content.preview(recovered.draft)).confirmation.submission.completeness).toBe('partial');
  }
});
