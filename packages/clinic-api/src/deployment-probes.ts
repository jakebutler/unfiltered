import type { Fetch } from '../../clinical-core/src/transport.js';
import type { ClinicApiConfig } from './types.js';

export const deploymentStaff = [
  { key: 'medical', name: 'Dr. Morgan Lee', role: 'physician' },
  { key: 'dietitian', name: 'Sam Patel, RD', role: 'registered-dietitian' },
  { key: 'administrative', name: 'Taylor Brooks', role: 'administrative' },
  { key: 'unassigned', name: 'Dr. Quinn Parker', role: 'physician' },
] as const;
export interface DeploymentStaffUser { name: string; role: string; email: string; password: string; }

/** A missing fixture must never silently remove its required authorization check. */
export function assertDeploymentStaffRoster(config: ClinicApiConfig, users: unknown): asserts users is DeploymentStaffUser[] {
  const fail = () => { throw new Error('deployment-staff-roster-invalid'); };
  if (!Array.isArray(users) || users.length !== deploymentStaff.length || !Array.isArray(config.staff) || config.staff.length !== deploymentStaff.length) fail();
  const rows = users as DeploymentStaffUser[];
  const primary = config.patients?.['first-intake']?.reference;
  if (!primary || new Set(config.staff.map(staff => staff.membershipId)).size !== 4 || new Set(config.staff.map(staff => staff.profile)).size !== 4) fail();
  for (const expected of deploymentStaff) {
    const matches = rows.filter(user => user && user.name === expected.name && user.role === expected.role && user.email === `${expected.key}.${config.projectId.slice(0, 8)}@example.invalid`);
    const assignments = config.staff.filter(staff => staff.name === expected.name && staff.role === expected.role);
    if (matches.length !== 1 || typeof matches[0].password !== 'string' || matches[0].password.length < 32 || assignments.length !== 1) fail();
    const assignment = assignments[0];
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(assignment.membershipId) || !/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(assignment.profile) || !/^AccessPolicy\/[A-Za-z0-9.-]{1,64}$/.test(assignment.policy) || assignment.patients.length !== 1 || !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(assignment.patients[0]) || (expected.key === 'unassigned' ? assignment.patients[0] === primary : assignment.patients[0] !== primary)) fail();
  }
}

/** Only an authoritative native invalid-session response proves revocation. */
export async function verifyNativeStaffRevocation(baseUrl: string, token: string, fetcher: Fetch = fetch, timeoutMs = 10000): Promise<{ state: 'revoked'; status: 401; code: 'login' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(new URL('auth/me', baseUrl).href, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' }, signal: controller.signal, redirect: 'error' });
    if (response.status !== 401 || !response.headers.get('content-type')?.includes('json')) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 16384) throw new Error();
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (body?.resourceType !== 'OperationOutcome' || !Array.isArray(body.issue) || !body.issue.some((issue: { code?: string; severity?: string }) => issue?.code === 'login' && ['error', 'fatal'].includes(issue.severity ?? ''))) throw new Error();
    return { state: 'revoked', status: 401, code: 'login' };
  } catch { throw new Error('staff-native-revocation-unconfirmed'); }
  finally { clearTimeout(timer); }
}
