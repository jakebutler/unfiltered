export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function signGateway(secret: string, operation: string, input: unknown, at = Date.now()) {
  if (secret.length < 32) throw new Error('Media gateway is not configured');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical({ version: 1, operation, input, at })));
  return { at, signature: Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('') };
}
export async function verifyGateway(secret: string | undefined, operation: string, input: unknown, proof: { at: number; signature: string }) {
  if (!secret || secret.length < 32 || !Number.isSafeInteger(proof.at) || Math.abs(Date.now() - proof.at) > 30_000 || !/^[a-f0-9]{64}$/.test(proof.signature)) throw new Error('Media gateway authorization unavailable');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(proof.signature.match(/../g)!, n => parseInt(n, 16));
  if (!await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(canonical({ version: 1, operation, input, at: proof.at })))) throw new Error('Media gateway authorization unavailable');
}
