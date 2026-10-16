import { ApiFailure } from './types.js';
const encoder = new TextEncoder();
const bytes64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export interface PatientClaims {
    kind: 'patient';
    sessionId: string;
    patient: string;
    scenario: string;
    invitationId?: string;
    expires: number;
    identityConfirmed?: boolean;
}
export interface StaffClaims {
    kind: 'staff';
    sessionId: string;
    expires: number;
}
export type Claims = PatientClaims | StaffClaims;
export function cookies(secret: string, secure: boolean) {
    if (secret.length < 32)
        throw new ApiFailure('invalid-cookie-key', 500);
    const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return {
        async issue(name: string, claims: Claims) {
            const body = bytes64(encoder.encode(JSON.stringify(claims)));
            const signature = bytes64(new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoder.encode(body))));
            return `${name}=${body}.${signature}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${Math.max(0, Math.floor((claims.expires - Date.now()) / 1000))}${secure ? '; Secure' : ''}`;
        },
        clear(name: string) { return `${name}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0${secure ? '; Secure' : ''}`; },
        async read(request: Request, name: string): Promise<Claims> {
            try {
                const value = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
                if (!value || value.length > 4096)
                    throw new Error();
                const [body, signature, extra] = value.split('.');
                if (!body || !signature || extra || !await crypto.subtle.verify('HMAC', await key, decode64(signature), encoder.encode(body)))
                    throw new Error();
                const claims = JSON.parse(new TextDecoder().decode(decode64(body))) as Claims;
                if (!['patient', 'staff'].includes(claims.kind) || !Number.isFinite(claims.expires) || claims.expires <= Date.now() || !/^[a-f0-9-]{36}$/.test(claims.sessionId))
                    throw new Error();
                return claims;
            }
            catch {
                throw new ApiFailure('session-required', 401);
            }
        },
    };
}
