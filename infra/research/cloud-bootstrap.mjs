/** Existing-target bootstrap only. No ambient target, deployment or provider activation. */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
export const TARGET = Object.freeze({ schema: 1, deploymentName: 'elegant-crane-662', deployment: 'https://elegant-crane-662.convex.cloud', convexSite: 'https://elegant-crane-662.convex.site', team: 'corvo-labs-demo', project: 'unfiltered-demo', canonicalOrigin: 'https://corvo-research-demo.vercel.app', vercelProjectId: 'prj_BMaoGwcBQVGObbUwYzMyhQKSwZHA', vercelTeamId: 'team_X86tAWYJjWM7n1BfDMTTLIat' });
export const PHASES = Object.freeze(['verify-target', 'export-push-credential', 'export-exact-credential', 'align-auth', 'bootstrap-operator', 'align-gateway', 'append-allocation']);
export const CAPTURE_LIMITS = Object.freeze({ segmentBytes: 4_000_000, sessionBytes: 24_000_000, retainedSessions: 2 });
export const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function target(raw) {
  if (!raw || Object.keys(raw).length !== Object.keys(TARGET).length || Object.entries(TARGET).some(([key, value]) => raw[key] !== value)) throw new Error('Exact cloud target manifest required');
  return TARGET;
}
export function allocation(allocationId, expiresAt, now = Date.now()) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(allocationId ?? '') || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 86_400_000) throw new Error('Explicit prospective 24-hour allocation required');
  return { allocationId, expiresAt, requestLimit: 2000, readByteLimit: 200_000_000, storageOperationLimit: 25 };
}
export function plan(raw, options, now = Date.now()) {
  const manifest = target(raw), budget = allocation(options.allocationId, options.expiresAt, now);
  return { schema: 1, target: manifest, targetHash: sha(manifest), allocation: budget, captureLimits: CAPTURE_LIMITS, runtimeDefaults: { speechEnabled: false, analysis: { enabled: false }, interview: { enabled: false } }, phases: PHASES, cloudCalls: 0, schedulerOrigin: null, blockers: ['Root-approved exact cloud code push before backend phases', 'Protected scheduler route authentication before setting RESEARCH_HOSTED_GATEWAY_ORIGIN', 'Vercel private runtime/R2 configuration and deployment are separate root actions', 'Hosted workflow and consent/cleanup acceptance after deployment'] };
}
export function freshSecrets(manifest) {
  target(manifest);
  const id = randomBytes(16).toString('hex'), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { mode: 'cloud-research-bootstrap', targetHash: sha(manifest), credentialId: id, email: `operator+${id}@corvo.example`, name: 'Corvo Research Operator', password: randomBytes(32).toString('base64url'), gatewaySecret: randomBytes(32).toString('hex'), privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trimEnd().replace(/\n/g, ' '), jwks: JSON.stringify({ keys: [{ use: 'sig', ...keys.publicKey.export({ format: 'jwk' }) }] }) };
}
export function secretsValid(secrets, manifest) {
  target(manifest);
  if (secrets?.mode !== 'cloud-research-bootstrap' || secrets.targetHash !== sha(manifest) || !/^[a-f0-9]{32}$/.test(secrets.credentialId ?? '') || secrets.email !== `operator+${secrets.credentialId}@corvo.example` || secrets.name !== 'Corvo Research Operator' || !/^[A-Za-z0-9_-]{43}$/.test(secrets.password ?? '') || !/^[a-f0-9]{64}$/.test(secrets.gatewaySecret ?? '') || !secrets.privateKey?.startsWith('-----BEGIN PRIVATE KEY----- ') || typeof secrets.jwks !== 'string') throw new Error('Distinct private cloud credentials required');
  return secrets;
}
function expectedEnvironment(phase, secrets, prepared) {
  if (phase === 'align-auth') return { JWT_PRIVATE_KEY: secrets.privateKey, JWKS: secrets.jwks, SITE_URL: TARGET.canonicalOrigin };
  if (phase === 'align-gateway') return { RESEARCH_MEDIA_GATEWAY_SECRET: secrets.gatewaySecret, RESEARCH_CAPTURE_LIMITS_JSON: JSON.stringify(CAPTURE_LIMITS), RESEARCH_HOSTED_GATEWAY_ALLOCATION: prepared.allocation.allocationId };
  return null;
}
/** Adapter is privileged runtime-only. readback=true NEVER calls a mutation. */
export async function phase(phaseName, prepared, secrets, adapter, { readback = false } = {}) {
  if (!PHASES.includes(phaseName) || prepared.targetHash !== sha(target(prepared.target))) throw new Error('Invalid bootstrap phase');
  if (prepared.allocation?.requestLimit !== 2000 || prepared.allocation?.readByteLimit !== 200_000_000 || prepared.allocation?.storageOperationLimit !== 25 || sha(prepared.captureLimits) !== sha(CAPTURE_LIMITS) || sha(prepared.runtimeDefaults) !== sha({ speechEnabled: false, analysis: { enabled: false }, interview: { enabled: false } })) throw new Error('Reviewed bootstrap envelope required');
  secretsValid(secrets, prepared.target);
  await adapter.verifyTarget();
  if (phaseName === 'verify-target') return { state: 'confirmed', writes: 0, deploymentType: 'dev' };
  if (phaseName === 'export-push-credential') return { ...(await adapter.exportPushCredential({ readback })), deploymentType: 'dev' };
  if (phaseName === 'export-exact-credential') return { ...(await adapter.exportExactCredential({ readback })), deploymentType: 'dev' };
  if (await adapter.environment('CONVEX_SITE_URL') !== TARGET.convexSite || await adapter.environment('RESEARCH_HOSTED_GATEWAY_ORIGIN') !== null) throw new Error('Cloud issuer or idle scheduler guard differs');
  const expected = expectedEnvironment(phaseName, secrets, prepared);
  if (expected) {
    const missing = [];
    for (const [name, value] of Object.entries(expected)) {
      const current = await adapter.environment(name);
      if (current !== null && current !== value) throw new Error('Existing cloud environment differs; explicit reconciliation required');
      if (current === null) missing.push({ name, value });
    }
    if (missing.length && readback) return { state: 'unconfirmed', writes: 0 };
    if (missing.length) await adapter.updateEnvironment(missing);
    for (const [name, value] of Object.entries(expected)) if (await adapter.environment(name) !== value) throw new Error('Environment alignment unconfirmed');
    return { state: 'confirmed', writes: missing.length ? 1 : 0 };
  }
  if (phaseName === 'bootstrap-operator') {
    const existing = await adapter.query('bootstrap:existing', {});
    if (existing) {
      if (await adapter.query('bootstrap:operatorEmail', { userId: existing }) !== secrets.email) throw new Error('Existing cloud operator differs');
      return { state: 'confirmed', writes: 0, operatorId: existing };
    }
    if (readback) return { state: 'unconfirmed', writes: 0 };
    // Verify auth issuer before create; absence after unknown is not permission
    // to repeat this action, which may have created an unbound account.
    for (const [name, value] of Object.entries(expectedEnvironment('align-auth', secrets, prepared))) if (await adapter.environment(name) !== value) throw new Error('Auth phase must be confirmed first');
    const created = await adapter.action('bootstrap:operator', { email: secrets.email, password: secrets.password, name: secrets.name });
    if (!created || await adapter.query('bootstrap:existing', {}) !== created || await adapter.query('bootstrap:operatorEmail', { userId: created }) !== secrets.email) throw new Error('Operator bootstrap unconfirmed');
    return { state: 'confirmed', writes: 1, operatorId: created };
  }
  const current = (await adapter.query('researchGatewayLeases:readiness', { allocationId: prepared.allocation.allocationId })).allocation;
  if (current) {
    if (Object.entries(prepared.allocation).some(([key, value]) => current[key] !== value)) throw new Error('Existing immutable allocation differs');
    return { state: 'confirmed', writes: 0 };
  }
  if (readback) return { state: 'unconfirmed', writes: 0 };
  allocation(prepared.allocation.allocationId, prepared.allocation.expiresAt);
  await adapter.mutation('researchGatewayLeases:provisionAllocation', prepared.allocation);
  const after = (await adapter.query('researchGatewayLeases:readiness', { allocationId: prepared.allocation.allocationId })).allocation;
  if (!after || Object.entries(prepared.allocation).some(([key, value]) => after[key] !== value)) throw new Error('Allocation append unconfirmed');
  return { state: 'confirmed', writes: 1 };
}
