import { expect,it } from 'vitest';
import { researchStorageTemplate } from '../templates/research-storage.mjs';
import { example } from './fixtures';
it('isolates retained private encrypted research bytes from clinic and preserves retirement fences',()=>{
  const t=researchStorageTemplate(example('research')), bucket=t.Resources.PrivateBucket;
  expect(bucket.DeletionPolicy).toBe('Retain');expect(bucket.UpdateReplacePolicy).toBe('Retain');
  expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true});
  for(const absent of ['VersioningConfiguration','LifecycleConfiguration','ReplicationConfiguration','ObjectLockConfiguration','WebsiteConfiguration','CorsConfiguration'])expect(bucket.Properties).not.toHaveProperty(absent);
  expect(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]).toMatchObject({BucketKeyEnabled:false,ServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms'}});
  const allows=t.Resources.RuntimeRole.Properties.Policies[0].PolicyDocument.Statement;
  expect(allows[0].Resource).toEqual({'Fn::Sub':'${PrivateBucket.Arn}/research-objects/research/*'});
  expect(JSON.stringify(allows)).not.toContain('DeleteObject');expect(JSON.stringify(allows)).not.toContain('Resource":"*"');
  const policy=t.Resources.PrivateBucketPolicy.Properties.PolicyDocument.Statement;
  expect(policy.find(s=>s.Sid==='NeverRemoveRetirementFence').Action).toEqual(['s3:DeleteObject','s3:DeleteObjectVersion']);
  expect(policy.find(s=>s.Sid==='NoPublicOrPresignedObjectAccess').Condition.StringNotEquals['s3:authType']).toBe('REST-HEADER');
  expect(policy.find(s=>s.Sid==='NoHistoricalOrExpiryDrift').Action).toContain('s3:PutLifecycleConfiguration');
  expect(()=>researchStorageTemplate(example('clinic-a'))).toThrow();
});
