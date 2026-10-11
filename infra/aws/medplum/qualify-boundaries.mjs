import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const NODE_IMAGE = 'node:22.22.3-bookworm-slim@sha256:111d09056e51bb52d1bfca06a3e73476d6022b156dc4c36c5379503cd307660b';
export const CLI = '/usr/bin/docker', PLUGIN = '/usr/libexec/docker/cli-plugins/docker-compose', SOCKET = '/run/docker.sock';
export const CLI_HASH = '9d8163c26d97f7a12c1fcd091204aa9528f82aab395a9a49ba6f533e8380218e', PLUGIN_HASH = 'd4fb48b72857810314d3ee77123c89954101844efa4788031221f4c370495946';
export const PACKAGE_HASH = 'dd652af0adc7b87a33c5179acc194e46829d9286d82066d11561d3714a7d4dcb';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const OWNED_TREE_LIMIT_BYTES = 1073741824;
export const CHECK_STAGES = Object.freeze(['setup-token','setup-current-patient','setup-other-patient','setup-document','patient-history','patient-first-version','scoped-current-patient','scoped-other-denial','revoked-current-denial','anonymous-current-denial','scoped-binary-bytes','setup-binary-context','setup-ledger','identifier-positive-control','stale-cas','atomic-rollback','rollback-absence']);
export function safeChecks(value) {
  if (!['checks-passed','checks-failed-or-unknown','fixture-construction-failed-or-unknown'].includes(value?.state) || !Array.isArray(value.rows) || value.rows.length > CHECK_STAGES.length) throw new Error('allowlisted-check-state-required');
  const rows=value.rows.map((r,i)=>{
    if(r?.stage!==CHECK_STAGES[i] || !Number.isInteger(r.status) || (r.status!==0 && (r.status<100 || r.status>599)) || !['pass','expectation-failed','transport-or-body-unknown'].includes(r.outcome) || (i<value.rows.length-1 && r.outcome!=='pass') || (r.outcome==='pass' && r.status===0))throw new Error('allowlisted-check-row-required');
    return {stage:r.stage,status:r.status,outcome:r.outcome};
  });
  if(value.state==='checks-passed' && (rows.length!==CHECK_STAGES.length || rows.some(r=>r.outcome!=='pass')) || value.state==='fixture-construction-failed-or-unknown' && rows.length)throw new Error('complete-check-state-required');
  return {state:value.state,rows};
}
export function names(id) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('fresh-run-id-required');
  const base = `uf-aws-medplum-drill-${id}`;
  return { id, control: `${base}-control`, client: `${base}-client`, source: `uf-aws-medplum-clinic-a-${id}`, target: `uf-aws-medplum-clinic-a-${sha(id).slice(0,12)}`,
    volumes: ['control', 'source', 'restore'].map(role => ({ name: `${base}-${role}`, role })) };
}
export function verifyPackage(value, read) {
  if (value.packageHash !== PACKAGE_HASH || value.platform !== 'linux/arm64' || value.packageHash !== sha(JSON.stringify(value.files)) || !/^[a-f0-9]{64}$/.test(value.profileHash)) throw new Error('exact-reviewed-package-required');
  for (const [name, expected] of Object.entries(value.files)) if (!/^(?:[A-Za-z0-9_-]+\.mjs|compose\.yml|images\.lock\.json|bootstrap\.sh|clinic\.json)$/.test(name) || sha(read(name)) !== expected) throw new Error('package-file-binding-invalid');
}
export function capacity({ availableMiB, freeDiskMiB, existingMiB, activeNames, cliHash, pluginHash, socket, platform }) {
  if (platform !== 'linux/arm64' || socket !== SOCKET || cliHash !== CLI_HASH || pluginHash !== PLUGIN_HASH) throw new Error('observed-tooling-changed');
  if (![availableMiB, freeDiskMiB, existingMiB].every(Number.isFinite) || availableMiB < 3328 || freeDiskMiB < 2048 || existingMiB + 3072 + 256 > 3904) throw new Error('native-resource-headroom-insufficient');
  if (activeNames.length !== 1 || activeNames[0] !== 'unfiltered-research-s4-backend-1') throw new Error('unexpected-running-services');
}
export function ownedVolume(value, name, role, id) {
  if (value.Name !== name || value.Labels?.['unfiltered.drill'] !== id || value.Labels?.['unfiltered.role'] !== role || value.Driver !== 'local' || Object.keys(value.Options ?? {}).length || !new RegExp(`^/var/lib/docker/volumes/${name}/_data$`).test(value.Mountpoint)) throw new Error('owned-volume-binding-invalid');
  return value.Mountpoint;
}
export function privateClientArgs(n, control, network, mode) {
  if (!['seed', 'verify'].includes(mode) || network !== `${mode === 'seed' ? n.source : n.target}_default`) throw new Error('fixture-network-binding-invalid');
  return ['run', '--pull', 'never', '--name', n.client, '--label', `unfiltered.drill=${n.id}`, '--label', 'unfiltered.role=client', '--network', network, '--memory', '128m', '--cpus', '.05', '--pids-limit', '32', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,size=16m', '--mount', `type=bind,src=${control}/client,dst=/fixture`, '--mount', `type=bind,src=${control}/qualify-client.mjs,dst=/qualify-client.mjs,readonly`, '--mount', `type=bind,src=${control}/qualify-boundaries.mjs,dst=/qualify-boundaries.mjs,readonly`, NODE_IMAGE, 'node', '--max-old-space-size=96', '/qualify-client.mjs', mode, '/fixture'];
}

export function accountOwnedTrees(paths) {
  let entries=0,bytes=0;
  function walk(path) {const info=lstatSync(path);if(info.isSymbolicLink()||++entries>131072)throw new Error('owned-tree-entry-bound');
    if(info.isDirectory())for(const name of readdirSync(path))walk(join(path,name));
    else {if(!info.isFile())throw new Error('owned-tree-regular-required');bytes+=info.size;if(bytes>OWNED_TREE_LIMIT_BYTES)throw new Error('owned-tree-byte-bound');}}
  for(const path of paths)walk(path);return bytes;
}
export function safeControlResult(value) {
  const steps=['package-admission','source-render','source-start','source-fixture','backup','restore-render','restore','sealed-start-denial','private-checkpoint-inspection'];
  const checks={};for(const mode of ['seed','verify'])if(value?.checks?.[mode])checks[mode]=safeChecks(value.checks[mode]);
  if(value?.state==='failed-or-unknown')return {state:value.state,automaticRetry:false,trafficOpened:false,cleanupVerified:value.cleanupVerified===true,...(steps.includes(value.failureStep)?{failureStep:value.failureStep}:{}),...(Object.keys(checks).length?{checks}:{})};
  if(value?.state!=='synthetic-package-checkpoint-restored'||value.packageHash!==PACKAGE_HASH||value.cleanupVerified!==true||value.providerCalls!==0||value.cloudCalls!==0||value.trafficOpened!==false||value.postCheckpointAuthorityReconciled!==false||value.clinicManifestNativeWiringQualified!==false||value.nativeAwsQualified!==false||value.queueExecutionQualified!==false||!Number.isSafeInteger(value.retainedBytes)||value.retainedBytes<0||value.retainedBytes>OWNED_TREE_LIMIT_BYTES||!['archiveHash','redisSentinelHash'].every(k=>/^[a-f0-9]{64}$/.test(value[k])))throw new Error('allowlisted-control-result-required');
  const proof=value.proof,keys=['patientId','projectId'];if(!proof||!keys.every(k=>/^[a-f0-9-]{36}$/.test(proof[k]))||!/^[a-f0-9]{64}$/.test(proof.binaryHash)||!/^[A-Za-z0-9.-]{1,64}$/.test(proof.versionId)||!/^synthetic-lifetime-[a-f0-9-]{36}$/.test(proof.ledgerNamespace)||JSON.stringify(proof.assertions)!==JSON.stringify(['history','scope-stable-precheckpoint-token','precheckpoint-revoke-existing-token','anonymous-denial','binary-bytes-context','ledger-namespace-unknown','stale-cas','atomic-rollback']))throw new Error('allowlisted-native-proof-required');
  if(checks.seed?.state!=='checks-passed'||checks.verify?.state!=='checks-passed')throw new Error('source-and-restore-checks-required');
  return {state:value.state,packageHash:PACKAGE_HASH,retainedBytes:value.retainedBytes,archiveHash:value.archiveHash,redisSentinelHash:value.redisSentinelHash,proof:Object.fromEntries(['patientId','projectId','binaryHash','versionId','ledgerNamespace','assertions'].map(k=>[k,proof[k]])),checks,cleanupVerified:true,providerCalls:0,cloudCalls:0,trafficOpened:false,postCheckpointAuthorityReconciled:false,clinicManifestNativeWiringQualified:false,nativeAwsQualified:false,queueExecutionQualified:false};
}
