import { digest, type Submission } from '../../clinical-core/src/domain.js';
import { IDENTIFIER_SYSTEM, identifierQuery } from '../../clinical-core/src/fhir.js';
import { MedplumClient, type AtomicQualification } from '../../clinical-core/src/medplum.js';
import { qualifyMedplum } from '../../clinical-core/src/qualification.js';
import { requestJson, type Fetch } from '../../clinical-core/src/transport.js';
import { object } from './store.js';
import { ApiFailure, type ClinicApiConfig } from './types.js';
export interface Runtime {
    client: MedplumClient;
    qualification: AtomicQualification;
}
export function runtimeProvider(config: ClinicApiConfig, fetcher: Fetch) {
    let cached: {
        promise: Promise<Runtime>;
        expires: number;
    } | undefined;
    return async (): Promise<Runtime> => {
        if (cached && cached.expires > Date.now())
            return cached.promise;
        const promise = (async () => {
            const token = object((await requestJson(fetcher, new URL('oauth2/token', config.medplumBaseUrl).href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret, scope: 'openid' }) }, 10000)).body);
            if (typeof token.access_token !== 'string')
                throw new ApiFailure('runtime-authentication-failed', 503);
            const baseUrl = new URL('fhir/R4/', config.medplumBaseUrl).href;
            const mode = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname) ? 'local' : 'live';
            const medConfig = { baseUrl, accessToken: token.access_token, timeoutMs: 10000, mode } as const;
            const client = new MedplumClient(medConfig, fetcher);
            const id = `qualification-${crypto.randomUUID()}`;
            const patient = config.patients['first-intake'];
            const s: Submission = { submissionId: id, version: 1, patient: patient.reference, scenario: 'first-intake', contentVersion: 'technical-runtime-probe', questionnaire: 'https://corvo.example/Questionnaire/technical-runtime-probe', confirmedAt: new Date().toISOString(), completeness: 'partial', sources: [{ id: 'probe', patient: patient.reference, kind: 'patient-statement', text: 'Synthetic runtime storage qualification only. No clinical assessment.', capturedAt: new Date().toISOString() }], answers: [{ questionId: 'probe', state: 'answered', text: 'Synthetic runtime storage qualification only.', sourceIds: ['probe'] }], work: [{ id: 'probe', kind: 'clinical', responsibility: 'medical', owner: patient.careTeams.medical }] };
            const report = await qualifyMedplum(medConfig, { submission: s, digest: await digest(s) }, fetcher);
            if (!report.qualification || report.handoff !== 'received')
                throw new ApiFailure('storage-qualification-failed', 503);
            if (cached)
                cached.expires = Date.now() + Math.max(60, Math.min(Number(token.expires_in) || 300, 3600) - 60) * 1000;
            return { client, qualification: report.qualification };
        })();
        cached = { promise, expires: Date.now() + 60000 };
        try {
            return await promise;
        }
        catch (error) {
            cached = undefined;
            throw error;
        }
    };
}
