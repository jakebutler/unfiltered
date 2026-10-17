import type { S3CredentialProvider } from '../../../packages/research-capture/src/s3-bucket';
/** Explicit IMDSv2 only. Fixed IPv4 link-local endpoint; no ambient chain, profile,
 * endpoint override or IMDSv1 fallback. Injectable HTTP transport is for offline tests. */
export function ec2RoleCredentials(expectedRole: string, transport: typeof fetch = fetch): S3CredentialProvider {
  if (!/^[a-z][a-z0-9-]{2,62}-research-runtime$/.test(expectedRole)) throw new Error('Explicit research role required');
  const endpoint = 'http://169.254.169.254';
  let cached: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expires: number } | undefined;
  const request = async (path: string, init: RequestInit, maximum: number) => {
    const signal = AbortSignal.timeout(3000), response = await transport(endpoint + path, { ...init, redirect:'error', signal });
    if (!response.ok || !response.body) throw new Error('Runtime role credentials unavailable');
    const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maximum || signal.aborted) throw new Error('Invalid metadata response'); chunks.push(next.value); } return Buffer.concat(chunks).toString('utf8'); }
    finally { await reader.cancel().catch(() => undefined); }
  };
  return async () => {
    if (cached && cached.expires > Date.now() + 60000) return cached;
    const token = await request('/latest/api/token', { method:'PUT', headers:{ 'X-aws-ec2-metadata-token-ttl-seconds':'60' } }, 4096);
    if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error('Invalid metadata token');
    const headers = { 'X-aws-ec2-metadata-token':token };
    const role = (await request('/latest/meta-data/iam/security-credentials/', { headers }, 128)).trim();
    if (role !== expectedRole) throw new Error('Runtime role mismatch');
    const row = JSON.parse(await request('/latest/meta-data/iam/security-credentials/' + role, { headers }, 16384));
    const expires = Date.parse(row.Expiration);
    if (row.Code !== 'Success' || !/^[A-Z0-9]{16,128}$/.test(row.AccessKeyId) || !/^[\x21-\x7e]{16,4096}$/.test(row.SecretAccessKey) || !/^[\x21-\x7e]{16,8192}$/.test(row.Token) || !Number.isFinite(expires) || expires <= Date.now() + 60000) throw new Error('Runtime role credentials unavailable');
    cached = { accessKeyId:row.AccessKeyId, secretAccessKey:row.SecretAccessKey, sessionToken:row.Token, expires }; return cached;
  };
}
