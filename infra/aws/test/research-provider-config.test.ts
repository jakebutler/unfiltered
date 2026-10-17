import { expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { awsResearchConfig } from '../research/config';
import { assembleAwsProviders } from '../research/providers';
import { fakeHostedAuthority } from '../../../apps/research-server/test/hosted-test-authority';
const manifest=JSON.parse(readFileSync('infra/aws/examples/research.json','utf8'));
const binary=JSON.parse(readFileSync('infra/aws/examples/research-ffmpeg.json','utf8'));
const runtime={gatewaySecret:'a'.repeat(64),allocationId:'fresh-aws-fixture',credentialSource:'ec2-imdsv2',s3:{bucket:'synthetic-research-fixture',region:'us-east-1',accountId:'123456789012',namespace:'research-objects',kmsKeyArn:'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc'},recovery:{state:'fresh-or-reconciled',identity:'b'.repeat(64)},maxSegmentBytes:4000000,maxResponseBytes:4000000};
const credentials={digitalOceanKey:'synthetic-do-key-only',deepgramKey:'synthetic-dg-key-only',elevenlabsKey:'synthetic-el-key-only'};
const interview={enabled:true,qualification:'root-reviewed-research-interview',model:'glm-5.3-flash',timeoutMs:1000,maxRequestBytes:32000,maxOutputTokens:256};
const speech={enabled:true,qualification:'root-reviewed-continuous-research-speech'};
const analysis={enabled:true,provider:'digitalocean',model:'qwen3.8-max',qualificationId:'DO-V1',reservations:[{id:'synthetic-reservation',maxInputBytes:32000,maxOutputTokens:512,expiresAt:Date.now()+60000}]};
const parse=(providers?:unknown,liveProvidersEnabled=false)=>awsResearchConfig(manifest,{...runtime,liveProvidersEnabled,...(providers?{providers}:{})},binary,'/app/bin/ffmpeg');
it('defaults all adapters off and explicit credentials alone do not activate them',()=>{
 for(const settings of[parse(),parse({credentials})]){
  expect(settings.runtime.providers.interview.enabled).toBe(false);expect(settings.analysis.enabled).toBe(false);
  const adapters=assembleAwsProviders(settings,fakeHostedAuthority());expect(adapters.interviewRuntime.enabled).toBe(false);expect(adapters.analysisRuntime.reservations).toEqual([]);adapters.speech.close();
 }
 expect(()=>parse(undefined,true)).toThrow('activation');
});
it('requires explicit finite qualified interview/speech activation and rejects excluded/configurable endpoints',()=>{
 for(const bad of[{interview,credentials},{speech,credentials}])expect(()=>parse(bad)).toThrow('activation');
 for(const bad of[{interview},{speech,credentials:{deepgramKey:credentials.deepgramKey}},{interview:{...interview,model:'gpt-4o'},credentials},{interview:{...interview,endpoint:'https://attacker.test'},credentials},{interview:{...interview,maxOutputTokens:513},credentials},{speech:{...speech,provider:'openai'},credentials}])expect(()=>parse(bad,true)).toThrow();
 const settings=parse({interview,speech,credentials},true),authority=fakeHostedAuthority();
 expect(()=>assembleAwsProviders(settings,authority)).toThrow('operation guard');
 const adapters=assembleAwsProviders(settings,{...authority,reserveOperation:async()=>{throw Error('must never dispatch during construction');}});
 expect(adapters.interviewRuntime.enabled).toBe(true);expect(settings.runtime.providers.interview).toMatchObject({model:'glm-5.3-flash',maxOutputTokens:256});adapters.speech.close();
});
it('reuses qualified finite analysis reservations and only packaged FFmpeg path',()=>{
 const settings=parse({analysis,credentials},true),adapters=assembleAwsProviders(settings,fakeHostedAuthority());
 expect(settings.analysis).toMatchObject({enabled:true,ffmpegExecutable:'/app/bin/ffmpeg'});expect(adapters.analysisRuntime.reservations).toMatchObject([{id:'synthetic-reservation',model:'qwen3.8-max',live:true,maxOutputTokens:512}]);adapters.speech.close();
 for(const changed of[{model:'glm-5.3-flash'},{qualificationId:'unreviewed'},{ffmpegExecutable:'/arbitrary/path'},{endpoint:'https://attacker.test'},{reservations:Array(9).fill(analysis.reservations[0])}])expect(()=>parse({analysis:{...analysis,...changed},credentials},true)).toThrow();
 expect(()=>parse({analysis},true)).toThrow('credentials');
});
