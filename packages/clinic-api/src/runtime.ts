import { MedplumClient, type DeliveryQualification } from '../../clinical-core/src/medplum.js';
import { requestJson, type Fetch } from '../../clinical-core/src/transport.js';
import { object } from './store.js';
import { ApiFailure } from './types.js';
import { verifyDeploymentQualification, type QualifiedClinicConfig } from './deployment-qualification.js';
export interface Runtime {
    client: MedplumClient;
    qualification: DeliveryQualification;
}
export function runtimeProvider(config: QualifiedClinicConfig, fetcher: Fetch) {
    let cached: {
        promise: Promise<Runtime>;
        expires: number;
    } | undefined;
    return async (): Promise<Runtime> => {
        if (cached && cached.expires > Date.now())
            return cached.promise;
        const baseUrl = new URL('fhir/R4/', config.medplumBaseUrl).href;
        const mode = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname) ? 'local' : 'live';
        if (!config.storageQualification) throw new ApiFailure('storage-deployment-qualification-required', 503);
        const entry: NonNullable<typeof cached> = { promise: undefined as unknown as Promise<Runtime>, expires: Date.now() + 60000 };
        const promise = (async () => {
            const token = object((await requestJson(fetcher, new URL('oauth2/token', config.medplumBaseUrl).href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret, scope: 'openid' }) }, 10000)).body);
            if (typeof token.access_token !== 'string')
                throw new ApiFailure('runtime-authentication-failed', 503);
            const medConfig = { ...(config.nativeQuestionnaire ? { nativeQuestionnaire: config.nativeQuestionnaire } : {}), baseUrl, accessToken: token.access_token, timeoutMs: 10000, mode } as const;
            const client = new MedplumClient(medConfig, fetcher);
            if (config.storageQualification) {
                const qualification = await verifyDeploymentQualification(config, medConfig, config.storageQualification, fetcher);
                await client.verifyNativeQuestionnaire();
                // Refresh identity at most five minutes apart, before token or
                // deployment proof expiry. Runtime refresh performs no FHIR writes.
                entry.expires = Math.min(Date.now() + Math.max(0, Math.min((Number(token.expires_in) || 300) - 30, 300)) * 1000, Date.parse(config.storageQualification.payload.expiresAt));
                return { client, qualification };
            }
            throw new ApiFailure('storage-deployment-qualification-required', 503);
        })();
        entry.promise = promise;
        cached = entry;
        try {
            return await promise;
        }
        catch (error) {
            if (cached === entry) cached = undefined;
            throw error;
        }
    };
}
