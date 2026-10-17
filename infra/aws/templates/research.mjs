import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDeploymentManifest } from '../manifest.schema.ts';
import { researchStorageTemplate } from './research-storage.mjs';

export function researchTemplate(input, platform) {
  const m = parseDeploymentManifest(input);
  if (m.product !== 'research' || platform !== 'linux/amd64' || new URL(m.publicOrigin).port) throw new Error('research-template-profile-invalid');
  const ref = name => ({ Ref: name }), sub = value => ({ 'Fn::Sub': value }), get = (name, field) => ({ 'Fn::GetAtt': [name, field] });
  const stack = m.stackId, secretName = m.authority.gatewaySecretRef;
  const tags = [{ Key: 'unfiltered-stack', Value: stack }, { Key: 'data-class', Value: 'synthetic-only' }];
  const secretArn = sub('arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:' + secretName + '-${RuntimeSecretSuffix}');
  const secretKeyArn = sub('arn:aws:kms:${AWS::Region}:${AWS::AccountId}:key/${SecretKmsKeyId}');
  const volumeKeyArn = sub('arn:aws:kms:${AWS::Region}:${AWS::AccountId}:key/${VolumeKmsKeyId}');
  const certificateArn = sub('arn:aws:acm:${AWS::Region}:${AWS::AccountId}:certificate/${CertificateId}');
  const imageUri = sub('${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/' + stack + '@${ImageDigest}');
  const convexImage = 'ghcr.io/get-convex/convex-backend@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4';
  const binding={schema:1,stackId:stack,profileHash:createHash('sha256').update(JSON.stringify(m,null,2)+'\n').digest('hex'),metadataNamespace:m.authority.metadataNamespace,objectNamespace:m.authority.objectNamespace,convexImage,volumeId:'${MetadataVolumeId}',filesystemUuid:'${MetadataFilesystemUuid}'};
  const startupGate=readFileSync(new URL('../research/startup-gate.mjs',import.meta.url),'utf8');
  if(startupGate.includes('${'))throw new Error('startup-gate-substitution-denied');
  const bootstrap = `#!/bin/bash
set -euo pipefail
umask 077
command -v docker >/dev/null
command -v aws >/dev/null
install -d -m 0700 /run/unfiltered /opt/unfiltered
# No metadata directory creation, formatting or root-filesystem fallback.
# The explicitly attached volume must be initialized/mounted separately.
cat > /opt/unfiltered/research-binding.json <<'BINDING'
${JSON.stringify(binding)}
BINDING
cat > /opt/unfiltered/startup-gate.mjs <<'GATE'
${startupGate}
GATE
chmod 0444 /opt/unfiltered/research-binding.json /opt/unfiltered/startup-gate.mjs
export AWS_MAX_ATTEMPTS=1 AWS_PAGER='' AWS_DEFAULT_REGION='\${AWS::Region}'
export DOCKER_CONFIG=/run/unfiltered/docker
install -d -m 0700 "$DOCKER_CONFIG"
aws ecr get-login-password --region '\${AWS::Region}' | docker login --username AWS --password-stdin '\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.\${AWS::URLSuffix}' >/dev/null
docker pull '\${ImageUri}' >/dev/null
docker logout '\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.\${AWS::URLSuffix}' >/dev/null
docker pull '${convexImage}' >/dev/null
cat > /opt/unfiltered/prepare-research-runtime.sh <<'PREPARE'
#!/bin/bash
set -euo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin AWS_MAX_ATTEMPTS=1 AWS_PAGER='' AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null
install -d -m 0700 /run/unfiltered
# Never preserve a previous runtime after a failed preparation.
rm -f /run/unfiltered/research-runtime.json
temporary=$(mktemp /run/unfiltered/.research-runtime.XXXXXX)
trap 'rm -f "$temporary"' EXIT
timeout --kill-after=1s 20s aws secretsmanager get-secret-value --region '\${AWS::Region}' --secret-id '\${RuntimeSecretArn}' --query SecretString --output text --cli-connect-timeout 5 --cli-read-timeout 10 > "$temporary" 2>/dev/null
test -s "$temporary"
test "$(wc -c < "$temporary")" -le 32768
chown 1000:1000 "$temporary"
chmod 0400 "$temporary"
mv -f "$temporary" /run/unfiltered/research-runtime.json
PREPARE
chmod 0500 /opt/unfiltered/prepare-research-runtime.sh
cat > /etc/systemd/system/unfiltered-research-runtime.service <<'SERVICE'
[Unit]
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/unfiltered/prepare-research-runtime.sh
RemainAfterExit=yes
TimeoutStartSec=25
StandardOutput=null
StandardError=null
SERVICE
# Gate remains closed until package-bound auth/functions and fresh finite allocation
# are initialized through the private local backend and recovery receipt is accepted.

cat > /etc/systemd/system/unfiltered-research-backend.service <<'SERVICE'
[Unit]
After=docker.service network-online.target unfiltered-research-runtime.service
Requires=docker.service unfiltered-research-runtime.service
[Service]
ExecStartPre=/usr/bin/node /opt/unfiltered/startup-gate.mjs --check-start
ExecStart=/usr/bin/docker run --rm --name ${stack}-backend --platform linux/amd64 --memory 1g --cpus 1 --pids-limit 128 --log-driver none --stop-signal SIGINT --mount type=bind,src=/srv/unfiltered/convex,dst=/convex/data --publish 3210:3210 --publish 3211:3211 --env CONVEX_CLOUD_ORIGIN=${m.authority.convexOrigin} --env CONVEX_SITE_ORIGIN=${m.authority.convexSiteOrigin} --env DISABLE_BEACON=true --env DISABLE_METRICS_ENDPOINT=true --env REDACT_LOGS_TO_CLIENT=true ${convexImage}
ExecStop=/usr/bin/docker stop --time 30 ${stack}-backend
Restart=no
[Install]
WantedBy=multi-user.target
SERVICE
cat > /etc/systemd/system/unfiltered-research.service <<'SERVICE'
[Unit]
After=unfiltered-research-backend.service unfiltered-research-runtime.service
Requires=unfiltered-research-backend.service unfiltered-research-runtime.service
[Service]
ExecStartPre=/usr/bin/node /opt/unfiltered/startup-gate.mjs --check-start
ExecStart=/usr/bin/docker run --rm --name ${stack}-application --network host --read-only --cap-drop ALL --security-opt no-new-privileges --memory 768m --cpus 1 --pids-limit 128 --log-driver none --tmpfs /tmp:rw,noexec,nosuid,size=16m --mount type=bind,src=/run/unfiltered/research-runtime.json,dst=/run/secrets/research-runtime.json,readonly --mount type=bind,src=/opt/unfiltered/research-binding.json,dst=/run/secrets/research-binding.json,readonly --mount type=bind,src=/srv/unfiltered/admission,dst=/run/research-gate,readonly \${ImageUri}
ExecStop=/usr/bin/docker stop --time 10 ${stack}-application
Restart=no
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl start unfiltered-research-runtime.service
if /usr/bin/node /opt/unfiltered/startup-gate.mjs --check-start; then
  systemctl enable --now unfiltered-research-backend.service unfiltered-research.service
fi
`;
  const template = {
    AWSTemplateFormatVersion: '2010-09-09', Description: `Synthetic ${stack} research: private Node/S3 runtime and pinned persistent Convex; sealed startup`,
    Metadata: { Unfiltered: { schema: 1, profileHash: createHash('sha256').update(JSON.stringify(m, null, 2) + '\n').digest('hex'), platform, manifest: m, convexImage, metadataVolume:'retained-encrypted-independent-volume; exact device serial and filesystem UUID required', recovery: 'sealed-metadata-with-permanent-object-fences', omitted: ['live-provider activation', 'PHI qualification', 'HA'], cloudCallsDuringSynthesis: 0 } },
    Parameters: {
      VpcId: { Type: 'AWS::EC2::VPC::Id' }, PublicSubnetIds: { Type: 'List<AWS::EC2::Subnet::Id>', Description: 'Two or more existing public subnets in different availability zones' }, PrivateSubnetId: { Type: 'AWS::EC2::Subnet::Id' }, MetadataAvailabilityZone:{Type:'AWS::EC2::AvailabilityZone::Name',Description:'Exact node/subnet and retained metadata volume AZ'}, MetadataFilesystemUuid:{Type:'String',AllowedPattern:'^[a-f0-9-]{36}$',Description:'Exact separately initialized filesystem UUID; no automatic formatting'},
      QualifiedAmiId: { Type: 'AWS::EC2::Image::Id', Description: `Pinned operator-qualified ${platform} AMI with Docker, AWS CLI v2, systemd and Node22, timeout, findmnt/lsblk and explicit EBS metadata-volume mount at /srv/unfiltered; no AMI discovery here` },
      CertificateId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$', Description: 'Existing ACM certificate identifier in this account/region' },
      RuntimeSecretSuffix: { Type: 'String', AllowedPattern: '^[A-Za-z0-9]{6}$', Description: `ARN suffix of existing secret named ${secretName}; runtime JSON is never a parameter` },
      SecretKmsKeyId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$' }, VolumeKmsKeyId: { Type: 'String', AllowedPattern: '^[a-f0-9-]{36}$' },
      ImageDigest: { Type: 'String', AllowedPattern: '^sha256:[a-f0-9]{64}$', Description: `Actual pushed ${platform} ${stack} image digest, bound to packaged profile` },
      ViewerCidr: { Type: 'String', AllowedPattern: '^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$', Description: 'Explicit approved IPv4 viewer CIDR; no default world access' },
    },
    Resources: {
      EdgeSecurityGroup: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: 'Approved viewers over TLS only', VpcId: ref('VpcId'), SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: ref('ViewerCidr') }], SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, DestinationSecurityGroupId: ref('NodeSecurityGroup') }], Tags: tags } },
      NodeSecurityGroup: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: 'Private research application; no SSH or database ingress', VpcId: ref('VpcId'), SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }], Tags: tags } },
      NodeIngress: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: ref('NodeSecurityGroup'), IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, SourceSecurityGroupId: ref('EdgeSecurityGroup') } },
      ConvexIngress: {Type:'AWS::EC2::SecurityGroupIngress',Properties:{GroupId:ref('NodeSecurityGroup'),IpProtocol:'tcp',FromPort:3210,ToPort:3211,SourceSecurityGroupId:ref('EdgeSecurityGroup')}},
      ConvexEgress: {Type:'AWS::EC2::SecurityGroupEgress',Properties:{GroupId:ref('EdgeSecurityGroup'),IpProtocol:'tcp',FromPort:3210,ToPort:3211,DestinationSecurityGroupId:ref('NodeSecurityGroup')}},
      RuntimeRole: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, Policies: [{ PolicyName: `${stack}-runtime-read`, PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secretArn },
        { Effect: 'Allow', Action: 'kms:Decrypt', Resource: secretKeyArn, Condition: { StringEquals: { 'kms:ViaService': sub('secretsmanager.\${AWS::Region}.\${AWS::URLSuffix}'), 'kms:EncryptionContext:SecretARN': secretArn } } },
        { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
        { Effect: 'Allow', Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], Resource: sub(`arn:\${AWS::Partition}:ecr:\${AWS::Region}:\${AWS::AccountId}:repository/${stack}`) },
      ] } }], Tags: tags } },
      RuntimeProfile: { Type: 'AWS::IAM::InstanceProfile', Properties: { Roles: [ref('RuntimeRole')] } },
      Node: { Type: 'AWS::EC2::Instance', Properties: { ImageId: ref('QualifiedAmiId'), AvailabilityZone:ref('MetadataAvailabilityZone'), InstanceType: platform === 'linux/arm64' ? 't4g.small' : 't3.small', CreditSpecification: { CPUCredits: 'standard' }, IamInstanceProfile: ref('RuntimeProfile'), MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled' }, NetworkInterfaces: [{ DeviceIndex: '0', AssociatePublicIpAddress: false, SubnetId: ref('PrivateSubnetId'), GroupSet: [ref('NodeSecurityGroup')] }], BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { Encrypted: true, KmsKeyId: volumeKeyArn, VolumeType: 'gp3', VolumeSize: 16, DeleteOnTermination: false } }], UserData: { 'Fn::Base64': { 'Fn::Sub': [bootstrap, { RuntimeSecretArn: secretArn, ImageUri: imageUri, MetadataVolumeId:ref('MetadataVolume') }] } }, Tags: tags } },
      MetadataVolume:{Type:'AWS::EC2::Volume',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{AvailabilityZone:ref('MetadataAvailabilityZone'),Encrypted:true,KmsKeyId:volumeKeyArn,VolumeType:'gp3',Size:20,Tags:tags}},
      MetadataAttachment:{Type:'AWS::EC2::VolumeAttachment',Properties:{InstanceId:ref('Node'),VolumeId:ref('MetadataVolume'),Device:'/dev/sdf'}},
      Edge: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Scheme: 'internet-facing', Type: 'application', IpAddressType: 'ipv4', Subnets: ref('PublicSubnetIds'), SecurityGroups: [ref('EdgeSecurityGroup')], LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '120' }], Tags: tags } },
      Target: { Type: 'AWS::ElasticLoadBalancingV2::TargetGroup', Properties: { VpcId: ref('VpcId'), Protocol: 'HTTP', Port: 8080, TargetType: 'instance', Targets: [{ Id: ref('Node'), Port: 8080 }], HealthCheckPath: '/capture/health', HealthCheckProtocol: 'HTTP', Matcher: { HttpCode: '200' }, TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '15' }], Tags: tags } },
      ConvexTarget: {Type:'AWS::ElasticLoadBalancingV2::TargetGroup',Properties:{VpcId:ref('VpcId'),Protocol:'HTTP',Port:3210,TargetType:'instance',Targets:[{Id:ref('Node'),Port:3210}],HealthCheckPath:'/version',Matcher:{HttpCode:'200'},Tags:tags}},
      SiteTarget: {Type:'AWS::ElasticLoadBalancingV2::TargetGroup',Properties:{VpcId:ref('VpcId'),Protocol:'HTTP',Port:3211,TargetType:'instance',Targets:[{Id:ref('Node'),Port:3211}],HealthCheckPath:'/',Matcher:{HttpCode:'200-499'},Tags:tags}},
      ConvexRoute: {Type:'AWS::ElasticLoadBalancingV2::ListenerRule',Properties:{ListenerArn:ref('Listener'),Priority:2,Conditions:[{Field:'host-header',HostHeaderConfig:{Values:[new URL(m.authority.convexOrigin).hostname]}}],Actions:[{Type:'forward',TargetGroupArn:ref('ConvexTarget')}]}},
      SiteRoute: {Type:'AWS::ElasticLoadBalancingV2::ListenerRule',Properties:{ListenerArn:ref('Listener'),Priority:3,Conditions:[{Field:'host-header',HostHeaderConfig:{Values:[new URL(m.authority.convexSiteOrigin).hostname]}}],Actions:[{Type:'forward',TargetGroupArn:ref('SiteTarget')}]}},
      Listener: { Type: 'AWS::ElasticLoadBalancingV2::Listener', Properties: { LoadBalancerArn: ref('Edge'), Port: 443, Protocol: 'HTTPS', Certificates: [{ CertificateArn: certificateArn }], SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not found' } }] } },
      TenantRoute: { Type: 'AWS::ElasticLoadBalancingV2::ListenerRule', Properties: { ListenerArn: ref('Listener'), Priority: 1, Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [new URL(m.publicOrigin).hostname] } }], Actions: [{ Type: 'forward', TargetGroupArn: ref('Target') }] } },
    },
    Outputs: { PublicOrigin: { Value: m.publicOrigin }, EdgeDnsName: { Value: get('Edge', 'DNSName') }, PrivateNodeId: { Value: ref('Node') } },
  };
  const runtimePolicies=template.Resources.RuntimeRole.Properties.Policies;
  const storage=researchStorageTemplate(m);
  template.Parameters={...template.Parameters,...storage.Parameters};
  template.Resources={...template.Resources,...storage.Resources};
  template.Resources.RuntimeRole.Properties.RoleName=`${stack}-research-runtime`;
  template.Resources.RuntimeRole.Properties.Policies.push(...runtimePolicies);
  template.Outputs={...template.Outputs,...storage.Outputs,MetadataVolumeId:{Value:ref('MetadataVolume')},MetadataFilesystemUuid:{Value:ref('MetadataFilesystemUuid')},ConvexOrigin:{Value:m.authority.convexOrigin},ConvexSiteOrigin:{Value:m.authority.convexSiteOrigin}};
  return template;
}
