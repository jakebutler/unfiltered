import { createHash } from 'node:crypto';
import { parseDeploymentManifest } from '../manifest.schema.ts';

export function clinicTemplate(input, platform) {
  const m = parseDeploymentManifest(input);
  if (m.product !== 'clinic' || !['linux/arm64', 'linux/amd64'].includes(platform) || new URL(m.publicOrigin).port) throw new Error('clinic-template-profile-invalid');
  const ref = name => ({ Ref: name }), sub = value => ({ 'Fn::Sub': value }), get = (name, field) => ({ 'Fn::GetAtt': [name, field] });
  const stack = m.stackId, secretName = m.authority.runtimeSecretRef;
  const tags = [{ Key: 'unfiltered-stack', Value: stack }, { Key: 'data-class', Value: 'synthetic-only' }];
  const secretArn = sub('arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:' + secretName + '-${RuntimeSecretSuffix}');
  const secretKeyArn = sub('arn:aws:kms:${AWS::Region}:${AWS::AccountId}:key/${SecretKmsKeyId}');
  const volumeKeyArn = sub('arn:aws:kms:${AWS::Region}:${AWS::AccountId}:key/${VolumeKmsKeyId}');
  const certificateArn = sub('arn:aws:acm:${AWS::Region}:${AWS::AccountId}:certificate/${CertificateId}');
  const imageUri = sub('${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/' + stack + '@${ImageDigest}');
  const bootstrap = `#!/bin/bash
set -euo pipefail
umask 077
command -v docker >/dev/null
command -v aws >/dev/null
install -d -m 0700 /opt/unfiltered /run/unfiltered
cat > /opt/unfiltered/prepare-runtime <<'SCRIPT'
#!/bin/bash
set -euo pipefail
umask 077
export AWS_MAX_ATTEMPTS=1 AWS_PAGER='' AWS_DEFAULT_REGION='\${AWS::Region}'
install -d -m 0700 /run/unfiltered /run/unfiltered/docker
export DOCKER_CONFIG=/run/unfiltered/docker
aws ecr get-login-password --region '\${AWS::Region}' | docker login --username AWS --password-stdin '\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.\${AWS::URLSuffix}' >/dev/null
docker pull '\${ImageUri}' >/dev/null
docker logout '\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.\${AWS::URLSuffix}' >/dev/null
aws secretsmanager get-secret-value --secret-id '\${RuntimeSecretArn}' --query SecretString --output text --cli-connect-timeout 5 --cli-read-timeout 10 > /run/unfiltered/clinic-config.json
chown 1000:1000 /run/unfiltered/clinic-config.json
chmod 0400 /run/unfiltered/clinic-config.json
SCRIPT
chmod 0700 /opt/unfiltered/prepare-runtime
cat > /etc/systemd/system/unfiltered-clinic.service <<'SERVICE'
[Unit]
Description=Provider-off synthetic clinic
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=simple
ExecStartPre=/opt/unfiltered/prepare-runtime
ExecStart=/usr/bin/docker run --rm --name ${stack} --read-only --cap-drop ALL --security-opt no-new-privileges --memory 768m --cpus 1 --pids-limit 128 --log-driver none --tmpfs /tmp:rw,noexec,nosuid,size=16m --mount type=bind,src=/run/unfiltered/clinic-config.json,dst=/run/secrets/clinic-config.json,readonly --publish 8080:8080 \${ImageUri}
ExecStop=/usr/bin/docker stop --time 10 ${stack}
Restart=no
TimeoutStartSec=120
TimeoutStopSec=15
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now unfiltered-clinic.service
`;
  const template = {
    AWSTemplateFormatVersion: '2010-09-09', Description: `Synthetic ${stack} application baseline: private node, TLS edge, retained encrypted root disk; dedicated Medplum is a prerequisite`,
    Metadata: { Unfiltered: { schema: 1, profileHash: createHash('sha256').update(JSON.stringify(m, null, 2) + '\n').digest('hex'), platform, manifest: m, omitted: ['Medplum database/Redis/attachment deployment', 'research', 'S3', 'backup/restore', 'live-provider activation', 'PHI qualification'], cloudCallsDuringSynthesis: 0 } },
    Parameters: {
      VpcId: { Type: 'AWS::EC2::VPC::Id' }, PublicSubnetIds: { Type: 'List<AWS::EC2::Subnet::Id>', Description: 'Two or more existing public subnets in different availability zones' }, PrivateSubnetId: { Type: 'AWS::EC2::Subnet::Id' },
      QualifiedAmiId: { Type: 'AWS::EC2::Image::Id', Description: `Pinned operator-qualified ${platform} AMI with Docker, AWS CLI v2 and systemd; no AMI discovery here` },
      CertificateId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$', Description: 'Existing ACM certificate identifier in this account/region' },
      RuntimeSecretSuffix: { Type: 'String', AllowedPattern: '^[A-Za-z0-9]{6}$', Description: `ARN suffix of existing secret named ${secretName}; runtime JSON is never a parameter` },
      SecretKmsKeyId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$' }, VolumeKmsKeyId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$' },
      ImageDigest: { Type: 'String', AllowedPattern: '^sha256:[a-f0-9]{64}$', Description: `Actual pushed ${platform} ${stack} image digest, bound to packaged profile` },
      ViewerCidr: { Type: 'String', AllowedPattern: '^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$', Description: 'Explicit approved IPv4 viewer CIDR; no default world access' },
    },
    Resources: {
      EdgeSecurityGroup: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: 'Approved viewers over TLS only', VpcId: ref('VpcId'), SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: ref('ViewerCidr') }], SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, DestinationSecurityGroupId: ref('NodeSecurityGroup') }], Tags: tags } },
      NodeSecurityGroup: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: 'Private clinic application; no SSH or database ingress', VpcId: ref('VpcId'), SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }], Tags: tags } },
      NodeIngress: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: ref('NodeSecurityGroup'), IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, SourceSecurityGroupId: ref('EdgeSecurityGroup') } },
      RuntimeRole: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, Policies: [{ PolicyName: `${stack}-runtime-read`, PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secretArn },
        { Effect: 'Allow', Action: 'kms:Decrypt', Resource: secretKeyArn, Condition: { StringEquals: { 'kms:ViaService': sub('secretsmanager.\${AWS::Region}.\${AWS::URLSuffix}'), 'kms:EncryptionContext:SecretARN': secretArn } } },
        { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
        { Effect: 'Allow', Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], Resource: sub(`arn:\${AWS::Partition}:ecr:\${AWS::Region}:\${AWS::AccountId}:repository/${stack}`) },
      ] } }], Tags: tags } },
      RuntimeProfile: { Type: 'AWS::IAM::InstanceProfile', Properties: { Roles: [ref('RuntimeRole')] } },
      Node: { Type: 'AWS::EC2::Instance', Properties: { ImageId: ref('QualifiedAmiId'), InstanceType: platform === 'linux/arm64' ? 't4g.small' : 't3.small', CreditSpecification: { CPUCredits: 'standard' }, IamInstanceProfile: ref('RuntimeProfile'), MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled' }, NetworkInterfaces: [{ DeviceIndex: '0', AssociatePublicIpAddress: false, SubnetId: ref('PrivateSubnetId'), GroupSet: [ref('NodeSecurityGroup')] }], BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { Encrypted: true, KmsKeyId: volumeKeyArn, VolumeType: 'gp3', VolumeSize: 16, DeleteOnTermination: false } }], UserData: { 'Fn::Base64': { 'Fn::Sub': [bootstrap, { RuntimeSecretArn: secretArn, ImageUri: imageUri }] } }, Tags: tags } },
      Edge: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Scheme: 'internet-facing', Type: 'application', IpAddressType: 'ipv4', Subnets: ref('PublicSubnetIds'), SecurityGroups: [ref('EdgeSecurityGroup')], LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '120' }], Tags: tags } },
      Target: { Type: 'AWS::ElasticLoadBalancingV2::TargetGroup', Properties: { VpcId: ref('VpcId'), Protocol: 'HTTP', Port: 8080, TargetType: 'instance', Targets: [{ Id: ref('Node'), Port: 8080 }], HealthCheckPath: '/api/clinic/config', HealthCheckProtocol: 'HTTP', Matcher: { HttpCode: '200' }, TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '15' }], Tags: tags } },
      Listener: { Type: 'AWS::ElasticLoadBalancingV2::Listener', Properties: { LoadBalancerArn: ref('Edge'), Port: 443, Protocol: 'HTTPS', Certificates: [{ CertificateArn: certificateArn }], SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not found' } }] } },
      TenantRoute: { Type: 'AWS::ElasticLoadBalancingV2::ListenerRule', Properties: { ListenerArn: ref('Listener'), Priority: 1, Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [new URL(m.publicOrigin).hostname] } }], Actions: [{ Type: 'forward', TargetGroupArn: ref('Target') }] } },
    },
    Outputs: { PublicOrigin: { Value: m.publicOrigin }, EdgeDnsName: { Value: get('Edge', 'DNSName') }, PrivateNodeId: { Value: ref('Node') } },
  };
  return template;
}
