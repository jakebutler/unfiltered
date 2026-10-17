import { ApiFailure } from './types.js';

const encoder = new TextEncoder();
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
export interface PortableStaffSession {
  schema: 1;
  sessionId: string;
  token: string;
  profile: string;
  membershipId: string;
  issuedAt: number;
  expires: number;
}

/** Opaque authenticated encryption; role authority is never serialized here. */
export function staffSessionCookies(secret: string, audience: string, secure: boolean) {
  if (secret.length < 32) throw new ApiFailure('invalid-cookie-key', 500);
  const additionalData = encoder.encode(`corvo-staff-session:v1:${audience}`);
  const key = (async () => {
    const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: additionalData, info: encoder.encode('clinic_staff') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  })();
  function validate(value: PortableStaffSession) {
    const now = Date.now();
    if (value.schema !== 1 || !/^[a-f0-9-]{36}$/.test(value.sessionId) || typeof value.token !== 'string' || !value.token || value.token.length > 2500 || !/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(value.profile) || !/^[A-Za-z0-9.-]{1,64}$/.test(value.membershipId) || !Number.isFinite(value.issuedAt) || !Number.isFinite(value.expires) || value.issuedAt > now + 30000 || value.expires <= now || value.expires <= value.issuedAt || value.expires - value.issuedAt > 1800000) throw new Error('invalid-staff-session');
  }
  return {
    async issue(session: PortableStaffSession) {
      validate(session);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await key, encoder.encode(JSON.stringify(session)));
      const value = `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
      if (value.length > 3800) throw new ApiFailure('staff-session-too-large', 503);
      return `clinic_staff=${value}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${Math.max(0, Math.floor((session.expires - Date.now()) / 1000))}${secure ? '; Secure' : ''}`;
    },
    async read(request: Request): Promise<PortableStaffSession> {
      try {
        const matches = request.headers.get('cookie')?.split(';').map(value => value.trim()).filter(value => value.startsWith('clinic_staff=')) ?? [];
        if (matches.length !== 1) throw new Error();
        const value = matches[0].slice('clinic_staff='.length);
        if (value.length > 3800) throw new Error();
        const [version, ivText, body, extra] = value.split('.');
        if (version !== 'v1' || !ivText || !body || extra) throw new Error();
        const iv = decode(ivText);
        if (iv.length !== 12) throw new Error();
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, await key, decode(body));
        const session = JSON.parse(new TextDecoder().decode(plaintext)) as PortableStaffSession;
        validate(session);
        return session;
      } catch { throw new ApiFailure('staff-session-required', 401); }
    },
  };
}
