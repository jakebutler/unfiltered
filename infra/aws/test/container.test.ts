import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { clinicTemplate } from '../templates/clinic.mjs';
import { example } from './fixtures.js';
const require = createRequire(import.meta.url);
const { runtimeEnvironment } = require('../clinic/launcher.cjs');

it('reads only baked public profile and private bounded regular config, excluding environment/provider values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aws-container-input-'));
  try {
    const privatePath = join(dir, 'private.json');
    writeFileSync(join(dir, 'deployment-manifest.json'), JSON.stringify(example('clinic-a')));
    writeFileSync(privatePath, '{}', { mode: 0o600 });
    expect(Object.keys(runtimeEnvironment(dir, privatePath))).toEqual(['AWS_DEPLOYMENT_MANIFEST_JSON', 'CLINIC_CONFIG_JSON']);
    writeFileSync(privatePath, 'x'.repeat(48001)); expect(() => runtimeEnvironment(dir, privatePath)).toThrow();
    rmSync(privatePath); symlinkSync(join(dir, 'deployment-manifest.json'), privatePath); expect(() => runtimeEnvironment(dir, privatePath)).toThrow();
    rmSync(privatePath); writeFileSync(privatePath, '{}', { mode: 0o644 }); expect(() => runtimeEnvironment(dir, privatePath)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('synthesizes deterministic separate clinic templates with private ingress, exact secret scope and retained root encryption', () => {
  const a = clinicTemplate(example('clinic-a'), 'linux/arm64'), b = clinicTemplate(example('clinic-b'), 'linux/amd64');
  expect(a).toEqual(clinicTemplate(example('clinic-a'), 'linux/arm64'));
  expect(a.Resources.Node.Properties.NetworkInterfaces[0].AssociatePublicIpAddress).toBe(false);
  expect(a.Resources.Node.Properties.MetadataOptions.HttpTokens).toBe('required');
  expect(a.Resources.NodeIngress.Properties.SourceSecurityGroupId).toEqual({ Ref: 'EdgeSecurityGroup' });
  expect(a.Resources.Listener.Properties.Protocol).toBe('HTTPS'); expect(a.Resources.Listener.Properties.DefaultActions[0].Type).toBe('fixed-response');
  expect(a.Resources.TenantRoute.Properties.Conditions[0].HostHeaderConfig.Values).toEqual(['clinic-a.example.invalid']);
  expect(a.Resources.Node.Properties.BlockDeviceMappings[0].Ebs.Encrypted).toBe(true); expect(a.Resources.Node.Properties.BlockDeviceMappings[0].Ebs.DeleteOnTermination).toBe(false);
  expect(a.Resources).not.toHaveProperty('DurableVolume'); expect(a.Resources).not.toHaveProperty('VolumeAttachment');
  const statements = a.Resources.RuntimeRole.Properties.Policies[0].PolicyDocument.Statement;
  expect(statements.find(s => s.Action === 'secretsmanager:GetSecretValue')!.Resource).toEqual({ 'Fn::Sub': 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:unfiltered/clinic-a/runtime-${RuntimeSecretSuffix}' });
  expect(JSON.stringify(b)).not.toContain('unfiltered/clinic-a/runtime');
  expect(statements.filter(s => s.Resource === '*').map(s => s.Action)).toEqual(['ecr:GetAuthorizationToken']);
  expect(a.Parameters.ViewerCidr).not.toHaveProperty('Default'); expect(a.Metadata.Unfiltered.manifest.gates.phiEnabled).toBe(false);
  expect(a.Resources.Node.Properties.UserData['Fn::Base64']['Fn::Sub'][0]).not.toContain('set -x');
});
it('does not synthesize research, unknown architectures, nonstandard TLS edge ports or live PHI/providers', () => {
  expect(() => clinicTemplate(example('research'), 'linux/arm64')).toThrow();
  expect(() => clinicTemplate(example('clinic-a'), 'linux/s390x')).toThrow();
  const m = example('clinic-a'); m.publicOrigin += ':8443'; expect(() => clinicTemplate(m, 'linux/arm64')).toThrow();
  m.publicOrigin = 'https://clinic-a.example.invalid'; m.gates.phiEnabled = true; expect(() => clinicTemplate(m, 'linux/arm64')).toThrow();
});
