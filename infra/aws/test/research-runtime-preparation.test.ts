import { expect,it } from 'vitest';
import { readFileSync,mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,statSync,rmSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { researchTemplate } from '../templates/research.mjs';
import { checkReadiness,profileHash,runtimeHash } from '../research/startup-gate.mjs';
const manifest=JSON.parse(readFileSync('infra/aws/examples/research.json','utf8'));
const template=researchTemplate(manifest,'linux/amd64');
const bootstrap=template.Resources.Node.Properties.UserData['Fn::Base64']['Fn::Sub'][0];
const prepare=bootstrap.split("<<'PREPARE'\n")[1].split('\nPREPARE')[0];
const binding={schema:1,stackId:manifest.stackId,profileHash:profileHash(manifest),metadataNamespace:manifest.authority.metadataNamespace,objectNamespace:manifest.authority.objectNamespace,convexImage:template.Metadata.Unfiltered.convexImage,volumeId:'vol-123456789abcdef01',filesystemUuid:'12345678-1234-1234-1234-123456789abc'};
const runtime={recovery:{state:'fresh-or-reconciled',identity:'b'.repeat(64)},gatewaySecret:'synthetic-unchanged-secret'};
const ready={schema:1,state:'accepted-fresh',binding,recoveryIdentity:runtime.recovery.identity,runtimeHash:runtimeHash(runtime)};
const markers={sealed:false,pending:false,restored:false};
function harness(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'research-prepare-')),bin=join(root,'bin'),run=join(root,'run'),fixture=join(root,'fixture'),calls=join(root,'calls');mkdirSync(bin);
 const script=(name:string,body:string)=>writeFileSync(join(bin,name),'#!/bin/bash\n'+body,{mode:0o700});
 script('aws',`printf '%s\\n' "$*" >> '${calls}'\ntest "$AWS_MAX_ATTEMPTS" = 1\ntest "$AWS_SHARED_CREDENTIALS_FILE" = /dev/null\ntest "$AWS_CONFIG_FILE" = /dev/null\ncat '${fixture}'\n`);
 script('timeout','test "$1" = --kill-after=1s; test "$2" = 20s; shift 2; exec "$@"\n');
 script('chown','test "$1" = 1000:1000\n');
 const code=prepare.replaceAll('/run/unfiltered',run).replace('PATH=/usr/local/bin:/usr/bin:/bin',`PATH=${bin}:/usr/bin:/bin`).replaceAll('${AWS::Region}','us-east-1').replaceAll('${RuntimeSecretArn}','arn:aws:secretsmanager:us-east-1:123456789012:secret:research/gateway-ABCDEF');
 const path=join(root,'prepare');writeFileSync(path,code,{mode:0o700});
 return{root,run,fixture,calls,script,execute:()=>spawnSync('/bin/bash',[path],{env:{},timeout:5000}),runtimePath:join(run,'research-runtime.json')};
}
it('both service gates require ordered same-boot oneshot success and exact bounded secret scope',()=>{
 for(const name of['unfiltered-research-backend.service','unfiltered-research.service']){
  const unit=bootstrap.split(`/etc/systemd/system/${name} <<'SERVICE'\n`)[1].split('\nSERVICE')[0];
  expect(unit.match(/^After=.*unfiltered-research-runtime.service$/m)).not.toBeNull();expect(unit.match(/^Requires=.*unfiltered-research-runtime.service$/m)).not.toBeNull();expect(unit).toContain('ExecStartPre=/usr/bin/node /opt/unfiltered/startup-gate.mjs --check-start');
 }
 const unit=bootstrap.split("/etc/systemd/system/unfiltered-research-runtime.service <<'SERVICE'\n")[1].split('\nSERVICE')[0];expect(unit).toContain('Type=oneshot');expect(unit).toContain('RemainAfterExit=yes');expect(unit).toContain('TimeoutStartSec=25');expect(unit).toContain('StandardOutput=null');expect(unit).toContain('StandardError=null');
 expect(bootstrap.indexOf('systemctl start unfiltered-research-runtime.service')).toBeLessThan(bootstrap.indexOf('if /usr/bin/node /opt/unfiltered/startup-gate.mjs --check-start'));
 expect(prepare).toContain("--secret-id '${RuntimeSecretArn}'");expect(prepare).toContain('--cli-connect-timeout 5 --cli-read-timeout 10');expect(prepare).toContain('-le 32768');expect(prepare).not.toContain('set -x');
 expect(template.Resources.Node.Properties.UserData['Fn::Base64']['Fn::Sub'][1].RuntimeSecretArn).toEqual(template.Resources.RuntimeRole.Properties.Policies.flatMap((p:any)=>p.PolicyDocument.Statement).find((s:any)=>s.Action==='secretsmanager:GetSecretValue').Resource);
});
it('recreates missing runtime after reboot with unchanged READY still accepted',()=>{
 const h=harness();writeFileSync(h.fixture,JSON.stringify(runtime));
 for(let boot=0;boot<2;boot++){
  if(existsSync(h.run))rmSync(h.run,{recursive:true});expect(h.execute().status).toBe(0);expect(statSync(h.run).mode&0o777).toBe(0o700);expect(statSync(h.runtimePath).mode&0o777).toBe(0o400);expect(readdirSync(h.run)).toEqual(['research-runtime.json']);
  expect(checkReadiness(binding,JSON.parse(readFileSync(h.runtimePath,'utf8')),binding,ready,markers).state).toBe('accepted-fresh');
 }
 const calls=readFileSync(h.calls,'utf8').trim().split('\n');expect(calls).toHaveLength(2);expect(calls.every(s=>s.includes('--secret-id arn:aws:secretsmanager:us-east-1:123456789012:secret:research/gateway-ABCDEF'))).toBe(true);
});
it('failed/missing/oversized secret leaves no stale runtime and changed secret cannot pass READY',()=>{
 const h=harness();writeFileSync(h.fixture,JSON.stringify(runtime));expect(h.execute().status).toBe(0);
 h.script('aws',"printf 'partial-private-output'; exit 9\n");expect(h.execute().status).toBe(9);expect(existsSync(h.runtimePath)).toBe(false);expect(readdirSync(h.run)).toEqual([]);
 h.script('aws','exit 0\n');expect(h.execute().status).not.toBe(0);expect(existsSync(h.runtimePath)).toBe(false);
 h.script('aws',`cat '${h.fixture}'\n`);writeFileSync(h.fixture,'x'.repeat(32769));expect(h.execute().status).not.toBe(0);expect(existsSync(h.runtimePath)).toBe(false);
 writeFileSync(h.fixture,JSON.stringify({...runtime,gatewaySecret:'synthetic-changed-secret'}));expect(h.execute().status).toBe(0);expect(()=>checkReadiness(binding,JSON.parse(readFileSync(h.runtimePath,'utf8')),binding,ready,markers)).toThrow();
});
