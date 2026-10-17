import { waitUntil } from '@vercel/functions';
import { studyRuntimeFacts } from '../../../../apps/research-server/src/study-readiness';
import type { StudyRuntimeFacts } from '../../../../packages/research-core/src/readiness';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { hostedResearchConfig } from './config';
import { loadResearchAssets } from './static-assets';
import { createHostedResearchServer } from './application';
import { R2PrivateBucketPort } from '../../../../packages/research-capture/src/r2-bucket';
import { BucketPrivateObjectStore } from '../../../../packages/research-capture/src/bucket-store';
import { assembleAnalysisRuntime } from '../../../../apps/research-server/src/analysis-config';
import { digitalOceanInterview } from '../../../../apps/research-server/src/interview';
import { DO_ENDPOINT } from '../../../../packages/clinical-core/src/digitalocean';
import { createResearchSpeechTransport } from '../../../../apps/research-server/src/research-speech';
import { createAllocatedResearchSpeechIngress } from '../../../../apps/research-server/src/speech-ingress';
import { convexResearchSpeechAuthority } from '../../../../apps/research-server/src/speech-authority';
export type StartupPhase = 'manifest' | 'config' | 'binary' | 'adapters' | 'assets' | 'application' | 'listen' | 'listening';
// Called synchronously by the thin CommonJS entry, after dependency loading.
export function createResearchApplication(mark: (phase: StartupPhase) => void) {
mark('manifest');
const manifest = JSON.parse(readFileSync(join(__dirname, 'research-manifest.json'), 'utf8'));
const ffmpeg = realpathSync(join(__dirname, 'bin/ffmpeg'));
mark('config');
const settings = hostedResearchConfig(process.env, manifest, ffmpeg);
mark('binary');
const binary = readFileSync(ffmpeg);
if (binary.length !== settings.manifest.ffmpeg.bytes || createHash('sha256').update(binary).digest('hex') !== settings.manifest.ffmpeg.sha256 || process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Pinned Linux FFmpeg runtime unavailable');
mark('adapters');
const port = R2PrivateBucketPort.create({ ...settings.manifest.r2, maxObjectBytes: settings.config.maxSegmentBytes }, async () => settings.r2Credentials);
let readinessFacts: () => StudyRuntimeFacts;
const speech = createResearchSpeechTransport({ enabled: settings.speechEnabled, origin: settings.config.publicOrigin, authority: convexResearchSpeechAuthority(settings.config.deployment, settings.config.gatewaySecret, { readinessFacts: () => readinessFacts() }), ingress: createAllocatedResearchSpeechIngress({ ...settings.config, allocationId: settings.config.allocationId! }), deepgramApiKey: settings.deepgramKey, elevenlabsApiKey: settings.elevenlabsKey, retainTerminal: promise => waitUntil(promise), onUpstreamDiagnostic: diagnostic => console.info(JSON.stringify(diagnostic)) });
const analysisRuntime = assembleAnalysisRuntime(settings.analysis, () => settings.modelKey);
const interviewRuntime = settings.interview.enabled ? { enabled: true, provider: digitalOceanInterview({ endpoint: DO_ENDPOINT, apiKey: settings.modelKey!, model: settings.interview.model!, timeoutMs: settings.interview.timeoutMs, maxRequestBytes: settings.interview.maxRequestBytes, maxOutputTokens: settings.interview.maxOutputTokens }) } : { enabled: false };
readinessFacts = studyRuntimeFacts(settings.config, { interview: interviewRuntime, analysis: analysisRuntime, speechEnabled: () => speech.readinessEnabled(), speechConfiguration: () => speech.readinessConfiguration(), qualifications: settings.readinessQualifications });
mark('assets');
const assets = loadResearchAssets(join(__dirname, 'site-assets'));
mark('application');
const application = createHostedResearchServer({ config: settings.config, assets, injection: { store: new BucketPrivateObjectStore(port), analysisRuntime }, speech, interviewRuntime, readinessQualifications: settings.readinessQualifications });
application.server.once('close', () => port.close());
process.once('SIGTERM', () => application.close());
return application.server;
}
// Existing local/native entry keeps its synchronous listening behavior.
export function startResearchApplication(mark: (phase: StartupPhase) => void) {
const server = createResearchApplication(mark);
mark('listen');
const listenPort = Number(process.env.PORT ?? 3000); if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('Invalid research listener port');
server.once('listening', () => mark('listening'));
server.listen(listenPort);
return server;
}
