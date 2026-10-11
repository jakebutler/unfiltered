import { digest } from '../../clinical-core/src/domain.js';
import type { QualifiedClinicConfig } from './deployment-qualification.js';
import { requestJson, TransportError, type Fetch } from '../../clinical-core/src/transport.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { cookies } from './cookies.js';
import { object } from './store.js';
import { ApiFailure, type ClinicApiConfig, type StaffAssignment } from './types.js';
import { staffSessionCookies } from './staff-session.js';
interface StaffSession {
    token: string;
    assignment: StaffAssignment;
    expires: number;
}
export function staffAuthentication(config: ClinicApiConfig, fetcher: Fetch, jar: ReturnType<typeof cookies>) {
    const portable = staffSessionCookies(config.cookieSecret, `${config.origin}|${config.medplumBaseUrl}|${config.projectId}`, new URL(config.origin).protocol === 'https:');
    async function verify(session: StaffSession) {
        const me = object((await requestJson(fetcher, new URL('auth/me', config.medplumBaseUrl).href, { headers: { Authorization: `Bearer ${session.token}` } }, 10000)).body);
        const profile = object(me.profile), project = object(me.project), membership = object(me.membership);
        if (project.id !== config.projectId || `${profile.resourceType}/${profile.id}` !== session.assignment.profile || membership.id !== session.assignment.membershipId || membership.active === false)
            throw new ApiFailure('staff-membership-denied', 403);
        // A policy downgrade must not retain old application role authority.
        const policy = object(me.accessPolicy);
        const refs = (policy.basedOn as {
            reference: string;
        }[] | undefined)?.map(r => r.reference) ?? [];
        if (policy.id !== session.assignment.policy.split('/')[1] && !refs.includes(session.assignment.policy))
            throw new ApiFailure('staff-policy-changed', 403);
        const proof = (config as QualifiedClinicConfig).storageQualification?.payload;
        if (proof) { const { id: _, meta: __, ...effective } = policy; if (proof.namedPolicyDigests[session.assignment.membershipId] !== await digest(effective)) throw new ApiFailure('staff-policy-changed', 403); }
        return session;
    }
    return {
        async login(email: string, password: string) {
            const bytes = crypto.getRandomValues(new Uint8Array(32));
            const verifier = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
            const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            try {
                const login = object((await requestJson(fetcher, new URL('auth/login', config.medplumBaseUrl).href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, projectId: config.projectId, scope: 'openid', codeChallenge: challenge, codeChallengeMethod: 'S256' }) }, 10000)).body);
                if (typeof login.code !== 'string')
                    throw new ApiFailure('staff-login-not-supported', 401);
                const token = object((await requestJson(fetcher, new URL('oauth2/token', config.medplumBaseUrl).href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: login.code, code_verifier: verifier }) }, 10000)).body);
                if (typeof token.access_token !== 'string')
                    throw new ApiFailure('staff-login-failed', 401);
                const authenticated = object((await requestJson(fetcher, new URL('auth/me', config.medplumBaseUrl).href, { headers: { Authorization: `Bearer ${token.access_token}` } }, 10000)).body);
                const profile = object(authenticated.profile), project = object(authenticated.project);
                const assignment = config.staff.find(s => s.profile === `${profile.resourceType}/${profile.id}`);
                if (!assignment || project.id !== config.projectId || typeof token.access_token !== 'string')
                    throw new ApiFailure('staff-not-assigned', 403);
                const session = { token: token.access_token, assignment, expires: Date.now() + Math.min(Number(token.expires_in) || 300, 1800) * 1000 };
                await verify(session);
                const id = crypto.randomUUID();
                return { identity: { name: assignment.name, role: assignment.role }, cookie: await portable.issue({ schema: 1, sessionId: id, token: session.token, profile: assignment.profile, membershipId: assignment.membershipId, issuedAt: Date.now(), expires: session.expires }) };
            }
            catch (error) {
                if (error instanceof TransportError && error.status === 429)
                    throw new ApiFailure('try-again-later', 429, true);
                if (error instanceof ApiFailure)
                    throw error;
                throw new ApiFailure('staff-login-failed', 401);
            }
        },
        async read(request: Request) {
            const claims = await portable.read(request);
            const assignment = config.staff.find(assignment => assignment.profile === claims.profile && assignment.membershipId === claims.membershipId);
            if (!assignment)
                throw new ApiFailure('staff-session-required', 401);
            const session: StaffSession = { token: claims.token, assignment, expires: claims.expires };
            try {
                await verify(session);
            }
            catch {
                throw new ApiFailure('staff-access-revoked', 403);
            }
            const baseUrl = new URL('fhir/R4/', config.medplumBaseUrl).href;
            const mode = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname) ? 'local' : 'live';
            return { assignment: session.assignment, client: new MedplumClient({ baseUrl, accessToken: session.token, timeoutMs: 10000, mode }, fetcher) };
        },
        async logout(request: Request) {
            let claims;
            try { claims = await portable.read(request); }
            catch { return jar.clear('clinic_staff'); }
            // Revocation is shared by every instance. Clearing a cookie alone
            // would leave a copied encrypted cookie usable until expiry.
            try {
                await requestJson(fetcher, new URL('oauth2/logout', config.medplumBaseUrl).href, { method: 'POST', headers: { Authorization: `Bearer ${claims.token}`, 'Content-Type': 'application/json' }, body: '{}' }, 10000);
            } catch (error) {
                if (!(error instanceof TransportError && error.status === 401)) throw new ApiFailure('staff-logout-unconfirmed', 503, true);
            }
            return jar.clear('clinic_staff');
        },
    };
}
