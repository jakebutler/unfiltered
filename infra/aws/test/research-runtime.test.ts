import { expect,it } from 'vitest';
import { readFileSync,realpathSync,mkdtempSync,mkdirSync,writeFileSync,chmodSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awsResearchConfig } from '../research/config';
import { ec2RoleCredentials } from '../research/credentials';
import { researchTemplate } from '../templates/research.mjs';
import { sealMetadata,restoreMetadata,reconcileRecovery,RECOVERY_TABLES } from '../research/recovery.mjs';
import { parseHostedConfig,HOSTED_DEPLOYMENT,HOSTED_CONVEX_SITE } from '../../../apps/research-server/src/hosted-runtime';
const manifest=JSON.parse(readFileSync('infra/aws/examples/research.json','utf8'));
const binary=JSON.parse(readFileSync('infra/aws/examples/research-ffmpeg.json','utf8'));
const runtime={gatewaySecret:'a'.repeat(64),allocationId:'fresh-aws-fixture',credentialSource:'ec2-imdsv2',s3:{bucket:'synthetic-research-fixture',region:'us-east-1',accountId:'123456789012',namespace:'research-objects',kmsKeyArn:'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc'},recovery:{state:'fresh-or-reconciled',identity:'b'.repeat(64)},maxSegmentBytes:4000000,maxResponseBytes:4000000,liveProvidersEnabled:false};
it('binds portable authority exactly and retains default hosted identity rejection',()=>{
 const settings=awsResearchConfig(manifest,runtime,binary);expect(settings.config.deployment).toBe(manifest.authority.convexOrigin);
 expect(()=>parseHostedConfig(settings.config,{canonicalOrigin:manifest.publicOrigin})).toThrow();
 expect(parseHostedConfig({...settings.config,deployment:HOSTED_DEPLOYMENT,convexSite:HOSTED_CONVEX_SITE},{canonicalOrigin:manifest.publicOrigin}).deployment).toBe(HOSTED_DEPLOYMENT);
 for(const changed of[{deployment:HOSTED_DEPLOYMENT},{convexSite:HOSTED_CONVEX_SITE},{publicOrigin:'https://attacker.test'}])expect(()=>parseHostedConfig({...settings.config,...changed},settings.binding)).toThrow();
 expect(()=>parseHostedConfig(settings.config,{...settings.binding,convexSite:'http://private.test'})).toThrow();
 expect(()=>awsResearchConfig(manifest,{...runtime,s3:{...runtime.s3,namespace:'other-objects'}},binary)).toThrow();
 expect(()=>awsResearchConfig(manifest,{...runtime,credentialSource:'ambient'},binary)).toThrow();
 expect(()=>awsResearchConfig(manifest,{...runtime,recovery:{...runtime.recovery,state:'sealed'}},binary)).toThrow();
});
it('uses only bounded IMDSv2 token and exact named role with no fallback',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];
 const provider=ec2RoleCredentials('research-research-runtime',async(input,init)=>{const url=String(input);calls.push({url,init:init!});return new Response(url.endsWith('/token')?'synthetic-token':url.endsWith('/security-credentials/')?'research-research-runtime':JSON.stringify({Code:'Success',AccessKeyId:'A'.repeat(20),SecretAccessKey:'B'.repeat(40),Token:'C'.repeat(32),Expiration:new Date(Date.now()+300000).toISOString()}));});
 expect((await provider()).sessionToken).toBe('C'.repeat(32));await provider();expect(calls).toHaveLength(3);expect(calls[0].init.method).toBe('PUT');expect(calls.every(c=>c.url.startsWith('http://169.254.169.254/latest/')&&c.init.redirect==='error')).toBe(true);
 await expect(ec2RoleCredentials('research-research-runtime',async()=>new Response('denied',{status:403}))()).rejects.toThrow();
});
it('synthesizes independent retained Convex/Node/TLS/S3 topology offline',()=>{
 const t=researchTemplate(manifest,'linux/amd64');expect(t.Resources.PrivateBucket.DeletionPolicy).toBe('Retain');expect(t.Resources.Node.Properties.BlockDeviceMappings[0].Ebs).toMatchObject({Encrypted:true,DeleteOnTermination:false});expect(t.Resources.Node.Properties.MetadataOptions.HttpTokens).toBe('required');expect(t.Resources.RuntimeRole.Properties.RoleName).toBe('research-research-runtime');
 const boot=JSON.stringify(t.Resources.Node.Properties.UserData);expect(boot).toContain('d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4');expect(boot).toContain('ExecStartPre=/usr/bin/node /opt/unfiltered/startup-gate.mjs --check-start');expect(boot).not.toContain('clinic-config');expect(t.Resources.ConvexTarget.Properties.Port).toBe(3210);expect(t.Metadata.Unfiltered.cloudCallsDuringSynthesis).toBe(0);
});
const identity={convexImage:'ghcr.io/get-convex/convex-backend@sha256:'+'c'.repeat(64),metadataNamespace:'research-metadata',objectNamespace:'research-objects',profileHash:'d'.repeat(64),recoveryIdentity:'e'.repeat(64)};
it('authenticates metadata before any restore write and never includes object bytes',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'aws-research-'));chmodSync(root,0o700);const source=join(root,'source');mkdirSync(source,{mode:0o700});writeFileSync(join(source,'db.sqlite'),'synthetic database',{mode:0o600});const archive=join(root,'archive'),key=Buffer.alloc(32,7);expect(sealMetadata(source,archive,key,identity).objectBytesArchived).toBe(0);const restored=join(root,'restored');expect(restoreMetadata(archive,restored,key,identity).state).toBe('restored-sealed');expect(readFileSync(join(restored,'db.sqlite'),'utf8')).toBe('synthetic database');expect(JSON.parse(readFileSync(join(restored,'RESTORE-SEALED.json'),'utf8')).s3RestoreForbidden).toBe(true);
 const tampered=join(root,'tampered'),bytes=readFileSync(archive);bytes[25]^=1;writeFileSync(tampered,bytes,{mode:0o600});const target=join(root,'target');expect(()=>restoreMetadata(tampered,target,key,identity)).toThrow();expect(existsSync(target)).toBe(false);expect(()=>restoreMetadata(archive,join(root,'wrong'),key,{...identity,objectNamespace:'other-objects'})).toThrow();
});
it('retains pending fence after unknown retirement and resumes without reopening or allowance refund',async()=>{
 const checkpoint:any={identity:identity.recoveryIdentity,state:'sealed',phase:RECOVERY_TABLES.indexOf('researchMedia'),cursor:null};let quarantines=0,retirements=0,saves=0;
 const quarantine=async()=>{quarantines++;return{cursor:'',done:true,count:1,fenceKeys:['research/session/media-a0']};};
 const store={async retire(){retirements++;if(retirements===1)throw new Error('unknown');},async head(){return null;}};
 await expect(reconcileRecovery(identity.recoveryIdentity,checkpoint,quarantine,store,async()=>{saves++;})).rejects.toThrow('unknown');expect(checkpoint.state).toBe('sealed');expect(checkpoint.pending.nextKey).toBe(0);expect(quarantines).toBe(1);expect(saves).toBe(1);
 await reconcileRecovery(identity.recoveryIdentity,checkpoint,async(input:any)=>input.table==='researchMedia'?quarantine():{cursor:'',done:true,count:0,fenceKeys:[]},store,async()=>{});expect(quarantines).toBe(1);expect(retirements).toBe(2);expect(checkpoint.state).toBe('quarantined-awaiting-fresh-identity-and-native-qualification');
});

it('AWS runtime accepts only a separate explicit cleanup binding without changing absent-binding defaults',()=>{
 const old=awsResearchConfig(manifest,runtime,binary),bound=awsResearchConfig(manifest,{...runtime,cleanupAllocationId:'retirement-aws-fixture'},binary);
 expect(old.config.cleanupAllocationId).toBeUndefined();expect(bound.config.cleanupAllocationId).toBe('retirement-aws-fixture');expect(bound.config.allocationId).toBe(runtime.allocationId);
 expect(()=>awsResearchConfig(manifest,{...runtime,cleanupAllocationId:runtime.allocationId},binary)).toThrow();
});
