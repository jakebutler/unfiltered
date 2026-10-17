import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAwsResearchServer } from '../research/application';
import { awsResearchConfig } from '../research/config';
import { assembleAwsProviders } from '../research/providers';
import { fakeHostedAuthority } from '../../../apps/research-server/test/hosted-test-authority';
import { convexResearchSpeechAuthority } from '../../../apps/research-server/src/speech-authority';
import { STUDY_READINESS_ROUTES } from '../../../packages/research-core/src/readiness';
import { STUDY_TEST_ROUTES } from '../../../packages/research-core/src/welcome';
import type { HostedResearchInjection } from '../../../apps/research-server/src/hosted-runtime';
import type { AnalysisRuntime } from '../../../apps/research-server/src/analysis';

// Default production authority factories are intercepted before any transport.
// Tests verify composition; native policy enforcement has separate evidence.
const mocks=vi.hoisted(()=>({
  snapshot:vi.fn(),command:vi.fn(),prepareAnalysis:vi.fn(),preview:vi.fn(),issue:vi.fn(),
  readiness:vi.fn(),tests:vi.fn(),capture:vi.fn(),report:vi.fn(),interview:vi.fn(),
  operator:vi.fn(),admit:vi.fn(),logout:vi.fn(),
}));
vi.mock('../../../apps/research-server/src/readiness-authority',()=>({readinessAuthority:mocks.readiness}));
vi.mock('../../../apps/research-server/src/capture-test-authority',()=>({captureTestAuthority:mocks.tests}));
vi.mock('../../../packages/research-capture/src/convex-authority',()=>({convexCaptureAuthority:mocks.capture}));
vi.mock('../../../apps/research-server/src/report-authority',()=>({reportAuthority:mocks.report}));
vi.mock('../../../apps/research-server/src/interview-authority',()=>({convexInterviewAuthority:mocks.interview}));
vi.mock('../../../apps/research-server/src/speech-authority',{spy:true});

const manifest=JSON.parse(readFileSync('infra/aws/examples/research.json','utf8'));
const origin=manifest.publicOrigin,host=new URL(origin).host;
const settings=()=>awsResearchConfig(manifest,{gatewaySecret:'a'.repeat(64),allocationId:'synthetic-aws-quota',credentialSource:'ec2-imdsv2',s3:{bucket:'synthetic-bucket',region:'us-east-1',accountId:'123456789012',namespace:'research-objects',kmsKeyArn:'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc'},recovery:{state:'fresh-or-reconciled',identity:'b'.repeat(64)},maxSegmentBytes:4000000,maxResponseBytes:4000000,liveProvidersEnabled:false},JSON.parse(readFileSync('infra/aws/examples/research-ffmpeg.json','utf8')));
const scope={clientId:'client',projectId:'project',studyId:'study',studyVersion:6};
const store={head:vi.fn(),read:vi.fn(),putIfAbsent:vi.fn(),retire:vi.fn()};
const assets=new Map([['/index.html',{body:Buffer.from('<main>synthetic</main>'),contentType:'text/html',digest:'c'.repeat(64),immutable:false}]]);
const apps:ReturnType<typeof createAwsResearchServer>[]=[];
function fixture(injection:Partial<HostedResearchInjection>={}) {
  const s=settings(),native=fakeHostedAuthority();
  const app=createAwsResearchServer({...s.config,allocationId:undefined},s.binding,assets,{store,hostedAuthority:native,...injection});apps.push(app);return{app,native};
}
function request(path:string,body?:unknown,headers:Record<string,string>={}) {
  const text=body===undefined?undefined:JSON.stringify(body);
  return new Request(origin+path,{method:text===undefined?'GET':'POST',headers:{Host:host,Origin:origin,Authorization:'Bearer synthetic',...(text?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(text))}:{}),...headers},body:text});
}
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.snapshot.mockImplementation(async(_scope,runtime)=>({scope:_scope,runtime}));
  mocks.command.mockImplementation(async(_command,runtime)=>({command:_command,runtime}));
  mocks.prepareAnalysis.mockImplementation(async(input,runtime)=>({input,runtime}));
  mocks.preview.mockImplementation(async(_scope,runtime)=>({scope:_scope,runtime}));
  mocks.issue.mockImplementation(async(input,runtime)=>({input,runtime}));
  mocks.readiness.mockReturnValue({snapshot:mocks.snapshot,command:mocks.command,prepareAnalysis:mocks.prepareAnalysis});
  mocks.tests.mockReturnValue({preview:mocks.preview,issue:mocks.issue});
  mocks.capture.mockReturnValue({inspect:async()=>{throw Error('offline denial');}});
  mocks.operator.mockResolvedValue({});mocks.logout.mockResolvedValue(undefined);
  mocks.report.mockReturnValue({operator:mocks.operator,admit:mocks.admit,logout:mocks.logout});
  mocks.interview.mockReturnValue({inspect:async()=>{throw Error('offline denial');}});
});
afterEach(async()=>{for(const app of apps.splice(0))await app.close();});

it('routes saved-study readiness, welcome, test issuance and preparation with current unqualified AWS facts',async()=>{
  const{app,native}=fixture();
  const snapshot=await app.handle(request(STUDY_READINESS_ROUTES.snapshot+'?'+new URLSearchParams({...scope,studyVersion:String(scope.studyVersion)})));
  expect(snapshot.status).toBe(200);const facts=(await snapshot.json()).runtime;
  expect(facts).toMatchObject({interview:{enabled:false,qualified:false},voice:{enabled:false,qualified:false},capture:{qualified:false},analysis:{enabled:false,qualified:false},screenBaselineQualified:false});
  expect(facts.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
  const command={scope,expectedRevision:'d'.repeat(64),capability:'scripted-text',enabled:true,requestId:'readiness-request'};
  expect((await app.handle(request(STUDY_READINESS_ROUTES.command,command))).status).toBe(200);
  expect((await app.handle(request(STUDY_TEST_ROUTES.preview,{scope}))).status).toBe(200);
  expect((await app.handle(request(STUDY_TEST_ROUTES.issue,{scope,requestId:'capture-test-request',expectedBinding:'e'.repeat(64),device:{browser:'synthetic',platform:'offline'}}))).status).toBe(200);
  const preparation={scope,requestId:'prepare-request',selections:[{sessionId:'session',kind:'self-report',id:'source',start:0,end:4}]};
  expect((await app.handle(request('/api/research/analysis/prepare',preparation))).status).toBe(200);
  for(const method of[mocks.command,mocks.preview,mocks.issue,mocks.prepareAnalysis])expect(method.mock.calls[0][1].configurationDigest).toBe(facts.configurationDigest);
  expect(mocks.readiness).toHaveBeenCalledWith(settings().config.deployment,settings().config.gatewaySecret,'synthetic',expect.any(AbortSignal));
  expect(native.acquire).not.toHaveBeenCalled();
});

it('denies unauthenticated or foreign-origin readiness before authority or lease access',async()=>{
  const{app,native}=fixture();
  for(const headers of[{Authorization:''},{Origin:'https://foreign.test'},{Host:'foreign.test'}])expect((await app.handle(request(STUDY_TEST_ROUTES.preview,{scope},headers))).status).toBe(403);
  expect(mocks.readiness).not.toHaveBeenCalled();expect(mocks.tests).not.toHaveBeenCalled();expect(native.acquire).not.toHaveBeenCalled();
});

it('requires native prepared analysis despite a valid caller static reservation',async()=>{
  const runtime:AnalysisRuntime={preparedOnly:false,reservations:[{id:'valid-static-reservation',model:'qwen3.8-max',maxInputBytes:64000,maxOutputTokens:128,expiresAt:Date.now()+60000,live:true}],visionQualified:true,provider:{classification:'live',model:'qwen3.8-max',prepare:vi.fn(),generate:vi.fn()}};
  const{app,native}=fixture({analysisRuntime:runtime});
  const response=await app.handle(request('/api/research/analysis',{clientId:'client',projectId:'project',requestId:'request-static',reservationId:runtime.reservations[0].id,selections:[{sessionId:'session',kind:'self-report',id:'source',start:0,end:4}]}));
  expect(response.status).toBe(409);await response.text();
  expect(mocks.operator).toHaveBeenCalledOnce();expect(mocks.admit).not.toHaveBeenCalled();expect(runtime.provider!.generate).not.toHaveBeenCalled();expect(runtime.preparedOnly).toBe(false);expect(native.leases.size).toBe(0);
  const facts=mocks.report.mock.calls[0][4]();expect(facts.analysis.qualified).toBe(false);
});

it('passes the same trusted readiness closure to default capture, report and interview authorities',async()=>{
  const assembled=assembleAwsProviders(settings(),fakeHostedAuthority());
  const{app}=fixture({readinessFacts:assembled.readinessFacts});
  try{
    const capture=await app.handle(request('/capture/media/media?clientId=client&projectId=project&sessionId=session'));await capture.text();
    const report=await app.handle(request('/api/research/analysis/availability'));await report.text();
    const interview=await app.handle(request('/api/research/interview',{sessionId:'session',promptId:'q1',expectedRevision:2,answerSourceId:'source-one',requestId:'interview-request'},{'X-Research-Participant':'a'.repeat(64)}));await interview.text();
    expect(mocks.capture.mock.calls[0][2].readinessFacts).toBe(assembled.readinessFacts);
    expect(mocks.report.mock.calls[0][4]).toBe(assembled.readinessFacts);
    expect(mocks.interview.mock.calls[0][4]).toBe(assembled.readinessFacts);
    const speechFacts=vi.mocked(convexResearchSpeechAuthority).mock.calls[0][2]!.readinessFacts!;
    expect(speechFacts().configurationDigest).toBe(assembled.readinessFacts().configurationDigest);
    expect(assembled.analysisRuntime.preparedOnly).toBe(true);
  }finally{assembled.speech.close();}
});

it('normalizes bodyless DELETE through actual Node HTTP and denies framed bodies and foreign origins before logout',async()=>{
  const{app,native}=fixture();app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const address=app.server.address();if(!address||typeof address==='string')throw Error('Missing fixture listener');
  const call=(body?:string,extra:Record<string,string>={})=>new Promise<number>((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port:address.port,path:'/api/research/portal/session',method:'DELETE',headers:{Host:host,Origin:origin,Cookie:'research_viewer='+'b'.repeat(64),...(body?{'Content-Length':String(Buffer.byteLength(body))}:{}),...extra}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode!));});req.once('error',reject);req.end(body);
  });
  expect(await call()).toBe(204);expect(mocks.logout).toHaveBeenCalledExactlyOnceWith({token:'b'.repeat(64)});
  expect(await call(undefined,{'Content-Length':'0'})).toBe(204);expect(mocks.logout).toHaveBeenCalledTimes(2);
  expect(await call('x')).toBe(413);
  expect(await call(undefined,{'Transfer-Encoding':'chunked'})).toBe(413);
  expect(await call(undefined,{Origin:'https://foreign.test'})).toBe(403);
  expect(mocks.logout).toHaveBeenCalledTimes(2);expect(native.leases.size).toBe(0);expect(store.read).not.toHaveBeenCalled();
});
