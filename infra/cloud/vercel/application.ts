import { createServer } from 'node:http';
import { nodeHttpHandler } from '../../../apps/clinic-server/src/http.js';
import { createNodeSpeechTransport } from '../../../apps/clinic-server/src/speech.js';
import { createClinicHandler } from '../../../packages/clinic-api/src/handler.js';
import { createSpeechAccess } from '../../../packages/clinic-api/src/speech-access.js';
import { createSpeechTranscription } from '../../../packages/speech/src/transcribe.js';
import { createSpeechUploadHandler } from '../../../apps/clinic-server/src/speech-upload.js';
import { runtimeProvider, type Runtime } from '../../../packages/clinic-api/src/runtime.js';
import type { QualifiedClinicConfig } from '../../../packages/clinic-api/src/deployment-qualification.js';
import type { ClinicProviderWiring } from '../../../apps/clinic-server/src/providers.js';
import { createIngressAdmission } from '../../../packages/clinic-api/src/ingress-admission.js';
import { serveClinicAsset, type ClinicAssets } from './static-assets.js';

export interface HostedProviders extends ClinicProviderWiring {}
export interface HostedClinicOptions { config: QualifiedClinicConfig; assets: ClinicAssets; providers?: HostedProviders; runtime?: () => Promise<Runtime>; }

/** One Node server for the app, API and native upgrade lifecycle. No local filesystem persistence. */
export function createHostedClinicServer({ config, assets, providers = {}, runtime = runtimeProvider(config, fetch) }: HostedClinicOptions) {
  const ingress = createIngressAdmission(async () => (await runtime()).client);
  const adaptiveAvailable = !!(providers.adaptiveProposer || providers.adaptiveInterpreter || providers.adaptiveGroupedExtractor);
  const speech = providers.speech ? createNodeSpeechTransport({ ...providers.speech, ingress, access: createSpeechAccess(config, { runtime, enabled: true, adaptiveAvailable }) }) : undefined;
  // Push-to-talk upload only when streaming speech is not configured; the two never share a route.
  const upload = !speech && providers.speechUpload ? createSpeechUploadHandler({ access: createSpeechAccess(config, { runtime, enabled: true, adaptiveAvailable }), transcribe: createSpeechTranscription({ deepgramApiKey: providers.speechUpload.deepgramApiKey, admission: providers.speechUpload.admission }) }) : undefined;
  const clinic = createClinicHandler(config, { runtime, adaptiveProposer: providers.adaptiveProposer, adaptiveInterpreter: providers.adaptiveInterpreter, adaptiveGroupedExtractor: providers.adaptiveGroupedExtractor, adaptiveFullCapture: providers.adaptiveFullCapture, adaptiveTimeoutMs: providers.adaptiveTimeoutMs, provisionalQualification: providers.provisionalQualification, finalRepresentationQualification: providers.finalRepresentationQualification, speechEnabled: !!speech || !!upload, speechInput: upload ? 'upload' : 'stream', ingress });
  const server = createServer(nodeHttpHandler(async request => {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path.startsWith('/api/')) return await speech?.handle(request) ?? await upload?.handle(request) ?? await clinic(request);
    return serveClinicAsset(request, assets, config.origin);
  }));
  server.on('upgrade', (request, socket, head) => {
    if (speech) void speech.upgrade(request, socket, head).catch(() => socket.destroy());
    else socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.once('close', () => speech?.close());
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return { server, close() { speech?.close(); server.close(); } };
}
