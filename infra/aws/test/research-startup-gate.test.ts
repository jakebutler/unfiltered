import { expect,it } from 'vitest';
import { readFileSync,mkdtempSync,realpathSync,mkdirSync,writeFileSync,chmodSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReadiness,checkMount,nativeGate,profileHash,runtimeHash,checkLauncher } from '../research/startup-gate.mjs';
import { researchTemplate } from '../templates/research.mjs';
const manifest=JSON.parse(readFileSync('infra/aws/examples/research.json','utf8'));
const binding={schema:1,stackId:'research',profileHash:profileHash(manifest),metadataNamespace:'research-metadata',objectNamespace:'research-objects',convexImage:'ghcr.io/get-convex/convex-backend@sha256:'+'a'.repeat(64),volumeId:'vol-123456789abcdef01',filesystemUuid:'12345678-1234-1234-1234-123456789abc'};
const runtime={recovery:{identity:'b'.repeat(64),state:'fresh-or-reconciled'},allocationId:'fresh-allowance',gatewaySecret:'synthetic-private-config'};
const ready={schema:1,state:'accepted-reconciled',binding,recoveryIdentity:runtime.recovery.identity,runtimeHash:runtimeHash(runtime)};
const markers={sealed:false,pending:false,restored:false};
it('requires exact persisted profile/volume/recovery and runtime readiness on every start',()=>{
 expect(checkReadiness(binding,runtime,binding,ready,markers).state).toBe('accepted-reconciled');
 for(const bad of[undefined,{}, {...ready,state:'quarantine-required'},{...ready,recoveryIdentity:'c'.repeat(64)},{...ready,runtimeHash:'c'.repeat(64)},{...ready,binding:{...binding,profileHash:'c'.repeat(64)}}])expect(()=>checkReadiness(binding,runtime,binding,bad,markers)).toThrow();
 for(const key of['sealed','pending','restored'])expect(()=>checkReadiness(binding,runtime,binding,ready,{...markers,[key]:true})).toThrow();
 expect(()=>checkReadiness(binding,{...runtime,allocationId:'old-allowance'},binding,ready,markers)).toThrow();
 expect(()=>checkReadiness(binding,runtime,{...binding,volumeId:'vol-abcdef01234567890'},ready,markers)).toThrow();
});
it('rejects root fallback, wrong volume/filesystem/mount and observes mount before reading READY',()=>{
 const observation={target:'/srv/unfiltered',source:'/dev/nvme1n1p1',fstype:'ext4',uuid:binding.filesystemUuid,diskType:'disk',serial:binding.volumeId.replaceAll('-','')};
 expect(()=>checkMount(binding,observation)).not.toThrow();
 for(const bad of[{target:'/'},{source:'/'},{uuid:'wrong'},{serial:'volwrong'},{fstype:'tmpfs'},{diskType:'loop'}])expect(()=>checkMount(binding,{...observation,...bad})).toThrow();
 let readinessReads=0;
 const run=((command:string)=>command.includes('findmnt')?JSON.stringify({filesystems:[observation]}):JSON.stringify({blockdevices:[{type:'part',children:[{type:'disk',serial:observation.serial}]}]}))as any;
 expect(nativeGate(binding,runtime,run,()=>{readinessReads++;return{identity:binding,ready,markers:{...markers}};},()=>false).state).toBe('accepted-reconciled');expect(readinessReads).toBe(1);
 const wrong=((command:string)=>command.includes('findmnt')?JSON.stringify({filesystems:[]}):'')as any;
 expect(()=>nativeGate(binding,runtime,wrong,()=>{readinessReads++;throw Error('must not read');},()=>false)).toThrow();expect(readinessReads).toBe(1);
 expect(()=>nativeGate(binding,runtime,run,()=>({identity:binding,ready,markers:{...markers}}),()=>true)).toThrow();
});
it('gates both public units at each start and supplies retained encrypted metadata volume/attachment',()=>{
 const t=researchTemplate(manifest,'linux/amd64'),script=t.Resources.Node.Properties.UserData['Fn::Base64']['Fn::Sub'][0];
 expect(script.match(/ExecStartPre=\/usr\/bin\/node \/opt\/unfiltered\/startup-gate.mjs --check-start/g)).toHaveLength(2);
 expect(script).not.toContain('install -d -m 0700 /srv/unfiltered');expect(script).not.toContain('mkfs');
 expect(t.Resources.MetadataVolume).toMatchObject({Type:'AWS::EC2::Volume',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Encrypted:true,AvailabilityZone:{Ref:'MetadataAvailabilityZone'}}});
 expect(t.Resources.MetadataAttachment.Properties).toMatchObject({VolumeId:{Ref:'MetadataVolume'},InstanceId:{Ref:'Node'},Device:'/dev/sdf'});
 expect(t.Resources.Node.Properties.UserData['Fn::Base64']['Fn::Sub'][1].MetadataVolumeId).toEqual({Ref:'MetadataVolume'});
 expect(script).toContain("'/usr/bin/findmnt'");expect(script).toContain("'/usr/bin/lsblk'");
});

it('binds launcher to real persisted readiness and restore seals before rejecting an invalid archive',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'aws-research-gate-'));chmodSync(root,0o700);
 const admission=join(root,'admission');mkdirSync(admission,{mode:0o755});
 const exactBinding={...binding,profileHash:profileHash(manifest),stackId:manifest.stackId,metadataNamespace:manifest.authority.metadataNamespace,objectNamespace:manifest.authority.objectNamespace};
 const exactReady={...ready,binding:exactBinding};
 writeFileSync(join(admission,'METADATA-IDENTITY.json'),JSON.stringify(exactBinding),{mode:0o644});
 expect(()=>checkLauncher(manifest,runtime,exactBinding,admission)).toThrow();
 writeFileSync(join(admission,'READY'),JSON.stringify(exactReady),{mode:0o644});expect(checkLauncher(manifest,runtime,exactBinding,admission).state).toBe('accepted-reconciled');
 expect(()=>checkLauncher({...manifest,publicOrigin:'https://wrong.test'},runtime,exactBinding,admission)).toThrow();
 const key=join(root,'key'),identity=join(root,'identity'),archive=join(root,'invalid');writeFileSync(key,Buffer.alloc(32,7),{mode:0o600});writeFileSync(identity,JSON.stringify({profileHash:binding.profileHash,convexImage:binding.convexImage,metadataNamespace:binding.metadataNamespace,objectNamespace:binding.objectNamespace,recoveryIdentity:runtime.recovery.identity}),{mode:0o600});writeFileSync(archive,'invalid',{mode:0o600});
 const result=spawnSync(process.execPath,['infra/aws/research/recovery-cli.mjs','restore','--archive',archive,'--target',join(root,'target'),'--key-file',key,'--identity',identity,'--receipt',join(root,'receipt'),'--admission-directory',admission,'--writers-and-backend-stopped'],{env:{},timeout:5000});
 expect(result.status).toBe(1);expect(existsSync(join(admission,'SEALED'))).toBe(true);expect(existsSync(join(admission,'READY'))).toBe(false);expect(existsSync(join(root,'target'))).toBe(false);expect(()=>checkLauncher(manifest,runtime,exactBinding,admission)).toThrow();
 // Even a stale READY copied back cannot reopen while SEALED survives.
 writeFileSync(join(admission,'READY'),JSON.stringify(exactReady),{mode:0o644});expect(()=>checkLauncher(manifest,runtime,exactBinding,admission)).toThrow();
});
