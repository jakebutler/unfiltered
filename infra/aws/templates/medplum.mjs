import { medplumProfile } from '../medplum/profile.schema.ts';
import { profileDigest } from '../medplum/render.mjs';

export function medplumTemplate(clinic, packageHash) {
  const p = medplumProfile(clinic);
  if (!/^[a-f0-9]{64}$/.test(packageHash)) throw new Error('exact-qualified-package-hash-required');
  const ref = key => ({ Ref: key }), sub = value => ({ 'Fn::Sub': value }), get = (key, field) => ({ 'Fn::GetAtt': [key, field] });
  const stack = p.clinic.stackId, tags = [{ Key: 'unfiltered-stack', Value: stack }, { Key: 'data-class', Value: 'synthetic-only' }];
  const secret = sub('arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:' + p.backendSecretRef + '-${BackendSecretSuffix}');
  const secretKey = sub('arn:aws:kms:${AWS::Region}:${AWS::AccountId}:key/${SecretKmsKeyId}'), volumeKey = sub('arn:aws:kms:${AWS::Region}:${AWS::AccountId}:key/${VolumeKmsKeyId}');
  const bootstrap = `#!/bin/bash
set -euo pipefail
umask 077
install -d -m 0700 /srv/unfiltered-medplum /run/unfiltered-medplum
cat > /etc/systemd/system/unfiltered-medplum.service <<'UNIT'
[Unit]
Description=Private synthetic Medplum authority; no automatic recovery reopen
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/bin/bash /opt/unfiltered-medplum/bootstrap.sh \${DataVolume} \${BackendSecretArn} ${packageHash} \${LaunchPhase} \${AWS::Region}
EnvironmentFile=-/run/unfiltered-medplum/service.env
ExecStart=/usr/bin/node /opt/unfiltered-medplum/start.mjs --start --config \$CONFIG --project \$PROJECT --docker-host unix:///var/run/docker.sock
ExecStop=/usr/bin/node /opt/unfiltered-medplum/start.mjs --stop --config \$CONFIG --project \$PROJECT --docker-host unix:///var/run/docker.sock
Restart=no
TimeoutStartSec=240
TimeoutStopSec=45
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# A fresh RAW volume deliberately blocks here. Operator initializes only the
# independently observed new EBS resource; no mkfs fallback exists at boot.
systemctl enable unfiltered-medplum.service
systemctl start unfiltered-medplum.service
`;
  return {
    AWSTemplateFormatVersion: '2010-09-09', Description: `Synthetic ${stack} dedicated Medplum: single private ARM64 node, sealed recovery, mounted encrypted storage`,
    Metadata: { Unfiltered: { schema: 1, profile: p, profileHash: profileDigest(p), packageHash, cloudCallsDuringSynthesis: 0, nativeQualified: false,
      prerequisites: ['Qualified AMI with exact preinstalled package', 'Explicit initialization of new data volume', 'Private authority DNS/certificate/routes', 'Clinic server-mediated auth qualification', 'Independent encrypted backup/key export'],
      omitted: ['AWS deployment', 'Direct browser OAuth/admin access', 'HA', 'Production PHI', 'Automated reopen', 'Operational monitoring', 'Off-host backup service'] } },
    Parameters: {
      VpcId: { Type: 'AWS::EC2::VPC::Id' }, PrivateSubnetId: { Type: 'AWS::EC2::Subnet::Id' },
      PrivateEdgeSubnetIds: { Type: 'List<AWS::EC2::Subnet::Id>', Description: 'At least two private subnets in distinct AZs' },
      DataAvailabilityZone: { Type: 'AWS::EC2::AvailabilityZone::Name', Description: 'Must match PrivateSubnetId; no AZ lookup/cloud call in synthesis' },
      ClinicServerSecurityGroupId: { Type: 'AWS::EC2::SecurityGroup::Id', Description: 'Exact clinic application node SG; no browser/admin SG' },
      QualifiedAmiId: { Type: 'AWS::EC2::Image::Id', Description: 'Qualified linux/arm64 AMI with Node22.22.3, Compose v2, AWS CLI v2, ext4 tools and exact package under /opt/unfiltered-medplum' },
      CertificateId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$' },
      BackendSecretSuffix: { Type: 'String', AllowedPattern: '^[A-Za-z0-9]{6}$', Description: `Existing exact secret ${p.backendSecretRef}; private values never parameters` },
      SecretKmsKeyId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$' }, VolumeKmsKeyId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$' },
      LaunchPhase: { Type: 'String', AllowedValues: ['initialize', 'resume'], Default: 'resume', Description: 'Initialize requires empty marked volume and bootstrap-only backend secret; restore cannot launch' },
    },
    Resources: {
      EdgeSecurityGroup: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: 'Private authority TLS from clinic server only', VpcId: ref('VpcId'),
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupId: ref('ClinicServerSecurityGroupId') }],
        SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 8103, ToPort: 8103, DestinationSecurityGroupId: ref('NodeSecurityGroup') }], Tags: tags } },
      NodeSecurityGroup: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: 'Private authority node; no DB/Redis/SSH ingress', VpcId: ref('VpcId'),
        SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }], Tags: tags } },
      AuthorityIngress: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: ref('NodeSecurityGroup'), IpProtocol: 'tcp', FromPort: 8103, ToPort: 8103, SourceSecurityGroupId: ref('EdgeSecurityGroup') } },
      RuntimeRole: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
        Policies: [{ PolicyName: `${stack}-medplum-secret`, PolicyDocument: { Version: '2012-10-17', Statement: [
          { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secret },
          { Effect: 'Allow', Action: 'kms:Decrypt', Resource: secretKey, Condition: { StringEquals: { 'kms:ViaService': sub('secretsmanager.${AWS::Region}.${AWS::URLSuffix}'), 'kms:EncryptionContext:SecretARN': secret } } },
        ] } }], Tags: tags } },
      RuntimeProfile: { Type: 'AWS::IAM::InstanceProfile', Properties: { Roles: [ref('RuntimeRole')] } },
      DataVolume: { Type: 'AWS::EC2::Volume', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: { AvailabilityZone: ref('DataAvailabilityZone'), Encrypted: true, KmsKeyId: volumeKey, Size: 40, VolumeType: 'gp3', Tags: tags } },
      Node: { Type: 'AWS::EC2::Instance', Properties: { ImageId: ref('QualifiedAmiId'), InstanceType: 't4g.medium', CreditSpecification: { CPUCredits: 'standard' },
        IamInstanceProfile: ref('RuntimeProfile'), MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled' },
        NetworkInterfaces: [{ DeviceIndex: '0', AssociatePublicIpAddress: false, SubnetId: ref('PrivateSubnetId'), GroupSet: [ref('NodeSecurityGroup')] }],
        BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { Encrypted: true, KmsKeyId: volumeKey, VolumeType: 'gp3', VolumeSize: 16, DeleteOnTermination: false } }],
        UserData: { 'Fn::Base64': { 'Fn::Sub': [bootstrap, { BackendSecretArn: secret }] } }, Tags: tags } },
      DataAttachment: { Type: 'AWS::EC2::VolumeAttachment', Properties: { Device: '/dev/sdf', InstanceId: ref('Node'), VolumeId: ref('DataVolume') } },
      Edge: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Scheme: 'internal', Type: 'application', IpAddressType: 'ipv4', Subnets: ref('PrivateEdgeSubnetIds'), SecurityGroups: [ref('EdgeSecurityGroup')], Tags: tags } },
      Target: { Type: 'AWS::ElasticLoadBalancingV2::TargetGroup', Properties: { VpcId: ref('VpcId'), Protocol: 'HTTP', Port: 8103, TargetType: 'instance', Targets: [{ Id: ref('Node'), Port: 8103 }], HealthCheckPath: '/healthcheck', Matcher: { HttpCode: '200' }, Tags: tags } },
      Listener: { Type: 'AWS::ElasticLoadBalancingV2::Listener', Properties: { LoadBalancerArn: ref('Edge'), Port: 443, Protocol: 'HTTPS', Certificates: [{ CertificateArn: sub('arn:aws:acm:${AWS::Region}:${AWS::AccountId}:certificate/${CertificateId}') }],
        SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not found' } }] } },
      AuthorityRoute: { Type: 'AWS::ElasticLoadBalancingV2::ListenerRule', Properties: { ListenerArn: ref('Listener'), Priority: 1, Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [new URL(p.clinic.authority.medplumBaseUrl).hostname] } }], Actions: [{ Type: 'forward', TargetGroupArn: ref('Target') }] } },
    },
    Outputs: { AuthorityOrigin: { Value: p.clinic.authority.medplumBaseUrl }, PrivateEdgeDnsName: { Value: get('Edge', 'DNSName') }, DataVolumeId: { Value: ref('DataVolume') }, PrivateNodeId: { Value: ref('Node') } },
  };
}
