import { assembleAnalysisRuntime } from '../../../apps/research-server/src/analysis-config';
import { digitalOceanInterview } from '../../../apps/research-server/src/interview';
import { DO_ENDPOINT } from '../../../packages/clinical-core/src/digitalocean';
import { createResearchSpeechTransport } from '../../../apps/research-server/src/research-speech';
import { convexResearchSpeechAuthority } from '../../../apps/research-server/src/speech-authority';
import { createAllocatedResearchSpeechIngress } from '../../../apps/research-server/src/speech-ingress';
import type { awsResearchConfig } from './config';
import type { HostedAuthority } from '../../../apps/research-server/src/hosted-admission';
import { studyRuntimeFacts } from '../../../apps/research-server/src/study-readiness';
import type { StudyRuntimeFacts } from '../../../packages/research-core/src/readiness';
/** Construct existing adapters only; no credential discovery, policy provisioning
 * or dispatch. Native finite policies/grants/reservations gate every later call. */
export function assembleAwsProviders(settings:ReturnType<typeof awsResearchConfig>,authority:HostedAuthority){
 const p=settings.runtime.providers,credentials=p.credentials;
 const analysisRuntime={...assembleAnalysisRuntime(settings.analysis,()=>credentials.digitalOceanKey),preparedOnly:true};
 const interviewRuntime=p.interview.enabled?{enabled:true,provider:digitalOceanInterview({endpoint:DO_ENDPOINT,apiKey:credentials.digitalOceanKey!,model:p.interview.model,timeoutMs:p.interview.timeoutMs,maxRequestBytes:p.interview.maxRequestBytes,maxOutputTokens:p.interview.maxOutputTokens})}:{enabled:false};
 // Authority closures are called only after assembly; all capabilities remain
 // unqualified until this independent deployment has its own accepted evidence.
 let readinessFacts:()=>StudyRuntimeFacts;
 const speech=createResearchSpeechTransport({enabled:p.speech.enabled,origin:settings.config.publicOrigin,authority:convexResearchSpeechAuthority(settings.config.deployment,settings.config.gatewaySecret,{readinessFacts:()=>readinessFacts()}),...(p.speech.enabled?{ingress:createAllocatedResearchSpeechIngress({...settings.config,allocationId:settings.runtime.allocationId},authority),deepgramApiKey:credentials.deepgramKey,elevenlabsApiKey:credentials.elevenlabsKey}:{})});
 readinessFacts=studyRuntimeFacts(settings.config,{interview:interviewRuntime,analysis:analysisRuntime,speechEnabled:()=>speech.readinessEnabled(),speechConfiguration:()=>speech.readinessConfiguration()});
 return{analysisRuntime,interviewRuntime,speech,readinessFacts};
}
