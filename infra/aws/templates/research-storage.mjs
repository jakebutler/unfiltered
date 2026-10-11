import { createHash } from 'node:crypto';
import { parseDeploymentManifest } from '../manifest.schema.ts';

/** Pure offline template. It does not deploy or discover AWS resources. */
export function researchStorageTemplate(input) {
  const m = parseDeploymentManifest(input);
  if (m.product !== 'research') throw Error('research-storage-profile-required');
  const ref = name => ({ Ref: name }), get = (name, attribute) => ({ 'Fn::GetAtt': [name, attribute] }), sub = text => ({ 'Fn::Sub': text });
  const namespace = m.authority.objectNamespace, tags = [{ Key: 'unfiltered-stack', Value: m.stackId }, { Key: 'data-class', Value: 'synthetic-only' }];
  const bucketName = sub(`uf-${m.stackId.slice(0,20)}-${createHash('sha256').update(m.stackId).digest('hex').slice(0,8)}-\${AWS::AccountId}-\${AWS::Region}`);
  const keyArn = sub('arn:aws:kms:${AWS::Region}:${AWS::AccountId}:key/${ObjectKmsKeyId}');
  const objects = sub('${PrivateBucket.Arn}/'+namespace+'/research/*'), allObjects = sub('${PrivateBucket.Arn}/*');
  return {
    AWSTemplateFormatVersion: '2010-09-09', Description: `Synthetic ${m.stackId} private research objects; never-versioned permanent retirement markers`,
    Metadata: { Unfiltered: { schema: 1, manifest: m, namespace, cloudCallsDuringSynthesis: 0, nativeS3Qualified: false, assumptions: ['fresh never-versioned general-purpose bucket', 'no lifecycle/replication/object lock/restore/backups', 'permanent zero-byte markers never deleted', 'runtime startup qualification mandatory', 'production PHI/provider gates closed'] } },
    Parameters: { ObjectKmsKeyId: { Type: 'String', AllowedPattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$', Description: 'Existing key in this account/region with independently qualified S3 key policy' } },
    Resources: {
      PrivateBucket: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
        BucketName: bucketName, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: keyArn }, BucketKeyEnabled: false }] }, Tags: tags,
        // Never enable then suspend versioning: absence on a NEW bucket is intentional.
      } },
      RuntimeRole: { Type: 'AWS::IAM::Role', Properties: {
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, Tags: tags,
        Policies: [{ PolicyName: `${m.stackId}-private-objects`, PolicyDocument: { Version: '2012-10-17', Statement: [
          { Effect: 'Allow', Action: ['s3:GetObject','s3:PutObject'], Resource: objects },
          // List permission makes absent HEAD return 404 rather than ambiguous 403.
          { Effect: 'Allow', Action: ['s3:ListBucket','s3:GetBucketVersioning','s3:GetLifecycleConfiguration','s3:GetReplicationConfiguration','s3:GetBucketObjectLockConfiguration','s3:GetEncryptionConfiguration','s3:GetBucketPublicAccessBlock','s3:GetBucketOwnershipControls'], Resource: get('PrivateBucket','Arn') },
          { Effect: 'Allow', Action: ['kms:GenerateDataKey','kms:Decrypt'], Resource: keyArn, Condition: { StringEquals: { 'kms:ViaService': sub('s3.${AWS::Region}.amazonaws.com') }, StringLike: { 'kms:EncryptionContext:aws:s3:arn': objects } } },
        ] } }],
      } },
      PrivateBucketPolicy: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: ref('PrivateBucket'), PolicyDocument: { Version: '2012-10-17', Statement: [
        { Sid: 'TLSOnly', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [get('PrivateBucket','Arn'), allObjects], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
        { Sid: 'NoPublicOrPresignedObjectAccess', Effect: 'Deny', Principal: '*', Action: ['s3:GetObject','s3:PutObject'], Resource: allObjects, Condition: { StringNotEquals: { 's3:authType': 'REST-HEADER' } } },
        { Sid: 'OnlyRuntimeObjectAuthority', Effect: 'Deny', Principal: '*', Action: ['s3:GetObject','s3:PutObject'], Resource: allObjects, Condition: { ArnNotEquals: { 'aws:PrincipalArn': get('RuntimeRole','Arn') } } },
        { Sid: 'NeverRemoveRetirementFence', Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject','s3:DeleteObjectVersion'], Resource: allObjects },
        { Sid: 'NoHistoricalOrExpiryDrift', Effect: 'Deny', Principal: '*', Action: ['s3:PutBucketVersioning','s3:PutLifecycleConfiguration','s3:PutReplicationConfiguration','s3:PutBucketObjectLockConfiguration'], Resource: get('PrivateBucket','Arn') },
        { Sid: 'ExactKmsAlgorithm', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: allObjects, Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } } },
        { Sid: 'ExactKmsKey', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: allObjects, Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption-aws-kms-key-id': keyArn } } },
      ] } } },
    },
    Outputs: { BucketName: { Value: ref('PrivateBucket') }, ObjectNamespace: { Value: namespace }, KmsKeyArn: { Value: keyArn }, RuntimeRoleArn: { Value: get('RuntimeRole','Arn') } },
  };
}
