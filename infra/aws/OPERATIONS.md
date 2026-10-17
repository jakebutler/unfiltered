# Clinic artifact and offline infrastructure baseline

This slice packages the existing provider-off clinic application. It does not deploy AWS, create DNS/certificates/secrets/images there, or install Medplum. The secret-free profile and actual native qualification must describe a dedicated Medplum deployment supplied separately. Research, S3 and backup/restore are excluded. Current flags remain synthetic-only; the production/PHI contractual and qualification gates in `README.md` remain mandatory.

The accepted Oct9 clinic A packages1/2 and B package1 are historical smoke baselines. Their bundled schema1 `synthetic-clinic-native-transactions` configuration is superseded and incompatible with current Q4f/schema2 `conditional-resumable-v1` and native Questionnaire history bindings. Preserve those artifacts. Defer final successor packaging until the adaptive/native backend is selected and frozen; then review the exact successor, fresh configuration and patient-to-staff integration for both independent client/native profiles. Current source compatibility and cloud qualification do not qualify the old images or a different packaged authority.

## Build and synthesize locally

Coordinate the serial runtime slot. Use Node 22.22.3, a clean locked dependency install and a 1 GB heap. The packager reads public code and an example manifest, disables Vite env-file discovery and env-prefix injection, bundles the server, enumerates/hashes allowed assets, and traces source/lockfile hashes. Each output must be a new direct child of ignored mode-0700 `infra/aws/.private/`; existing or symlinked output roots fail. Failed build directories/receipts are retained. Never use the repository root as a Docker context.

```sh
NODE_OPTIONS=--max-old-space-size=1024 node --experimental-strip-types infra/aws/clinic/package.mjs --manifest infra/aws/examples/clinic-a.json --platform linux/arm64 --output infra/aws/.private/clinic-a-package-1
NODE_OPTIONS=--max-old-space-size=1024 node --experimental-strip-types infra/aws/synth.mjs --manifest infra/aws/examples/clinic-a.json --platform linux/arm64 --output infra/aws/.private/clinic-a-template-1.json
```

Repeat with unique paths and `clinic-b.json` to verify distinct baked profiles; compare sorted artifact file hashes for repeated builds of the same input. `linux/amd64` is also recorded in the official image lock, but native execution on each declared architecture is a separate check. The official Node 22.22.3 registry index and platform child digests are recorded in `clinic/images.lock.json`; Docker verifies content-addressed pulls. [Official Node image](https://hub.docker.com/_/node).

In the explicitly selected Docker context, a package directory is a complete build context:

```sh
docker --context colima-unfiltered-s0 build --platform linux/arm64 --build-arg SOURCE_DATE_EPOCH=0 --tag unfiltered-clinic-a:local infra/aws/.private/clinic-a-package-1
```

This command builds only; it does not start a clinic. Check host/VM pressure first and preserve existing containers. New images/builds require the serial slot. The generated Dockerfile pins the selected child digest, uses Node's non-root user, copies only the bundle/launcher/public manifest/hashed assets, and contains no package installation. The context's default-deny `.dockerignore` excludes receipts and arbitrary added files. `SOURCE_DATE_EPOCH` supplies BuildKit's reproducible metadata input; a legacy builder does not establish identical image metadata. Content-identical packaging, an actually built image and repeatable image metadata must be reported separately. [Docker reproducible-build guidance](https://docs.docker.com/build/ci/github-actions/reproducible-builds/).

At runtime the launcher always reads the baked profile, regardless of a manifest environment override, and reads only `/run/secrets/clinic-config.json` as its private input. It rejects symlinks, non-files, exposed permissions and oversized data. Inject this file read-only with owner UID 1000 and mode 0400; never bake it into an image. Config still undergoes structural binding and unchanged native HMAC/identity verification. Keys present in the environment do not enable providers.

## Clinical qualification expiry and bounded renewal

Clinical admission requires an unexpired native qualification; deployment health does not extend it. The current hosted Q4f/A3 synthetic-demo seal expires **2026-10-17T20:25:41.318Z**. That seal belongs to its exact hosted origin/native authority and cannot qualify either AWS client profile. Read each selected private configuration's actual `storageQualification.payload.expiresAt` before scheduling a demo or inviting new intake work. An expired proof can stop the clinical demo even while static pages/health remain available.

Renewal needs a separately reviewed finite plan against the currently selected source/runtime and native origin/project/client/membership, effective policy, project features and exact Questionnaire history. Preserve the old qualification and every delivery/unknown receipt. Use a fresh private intent/output identity, bounded request/write/time authority, current owner/native readback and required conditional-resumable/application/native-mapping checks; reuse unchanged accepted static evidence only within its recorded scope. Require truthful cleanup/revocation evidence for all new owned actors and verify the resulting signed seal, expiry and read-only runtime refresh before an explicit configuration rollout. Do not blindly rerun the historical A2/A3 private fixture, reuse an unknown dispatch identity, relabel old readbacks as fresh, or re-sign/extend the old payload.

If periodic native requalification is unsuitable for the intended operating model, review the validity/revocation design explicitly before changing it. This runbook changes no TTL, signature, identity, native-readback or authorization guard and provides no automatic renewal. Without accepted renewal, keep new clinical admission closed when the seal expires; preserved drafts/native handoffs remain evidence, not operations to replay.

## Local container smoke

For a bounded local smoke proof, inspect the **actual local image ID** and existing profile socket first, then pass both explicitly. This fixture supports native ARM64 only; AMD64 execution remains separate. Use an empty mode-0700 `infra/aws/.private/docker-public/` Docker config directory to avoid reading registry credentials. The runner refuses existing receipt paths, uses synthetic fixture data only, disables networking, starts no host listener, and removes only its uniquely named container. An entrypoint override writes the synthetic config into private tmpfs and invokes the actual launcher; this does not prove real Secrets Manager injection or native Medplum access.

```sh
node --experimental-strip-types infra/aws/clinic/qualify-container.mjs --image sha256:ACTUAL_LOCAL_IMAGE_ID --docker-host unix:///Users/ACTUAL_USER/.colima/unfiltered-s0/docker.sock --receipt infra/aws/.private/clinic-a-container-smoke-1.json
```

`ACTUAL_*` are mandatory observed local inputs, not runnable example values or invented deployment references. The runner checks private-IP Host/no-Origin health, hashes every packaged public asset, checks private paths/foreign Origin, and verifies bounded shutdown. A failed receipt is preserved and never automatically rerun. Its config intentionally has no valid native authority, so successful process health establishes neither session storage nor clinical readiness.

## Offline lint

The separate validation environment does not change repository dependencies. `cfn-lint` uses its bundled resource schemas when run without update flags. [AWS CloudFormation linter](https://github.com/aws-cloudformation/cfn-lint).

```sh
python3 -m venv infra/aws/.private/lint-venv
infra/aws/.private/lint-venv/bin/python -m pip --isolated install --index-url https://pypi.org/simple -r infra/aws/requirements-validation.txt
AWS_EC2_METADATA_DISABLED=true AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null infra/aws/.private/lint-venv/bin/cfn-lint -t infra/aws/.private/clinic-a-template-1.json -r us-east-1
```

No AWS CLI or SDK is invoked by synthesis. Templates retain unresolved CloudFormation parameters as declared deployment inputs; they are not replaced with invented AMIs, certificates, application image digests or secret values. Example `.invalid` profiles are offline validation inputs, not a deployable tenant configuration. No deployment command is supplied here.

## Template interface and controls

The template creates one private application node and an HTTPS application load balancer with an exact tenant hostname rule and default 404. Node port 8080 admits only the edge security group; SSH/database ports and public IP assignment are absent. Explicit viewer CIDR is required, with no world-access default. Existing VPC, private subnet and at least two public subnets with different availability zones are inputs. DNS resolution and HTTPS access to the dedicated Medplum endpoint, ECR and Secrets Manager require separately qualified routes/endpoints; this template does not create a NAT gateway. [ALB security groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-update-security-groups.html).

The host requires an operator-qualified AMI of the declared architecture with Docker at `/usr/bin/docker`, AWS CLI v2, systemd and root device `/dev/xvda`. Bootstrap is runnable with those prerequisites: it pulls the exact application image, reads the one named runtime secret into private `/run` memory, drops Docker registry authentication, and starts a read-only container with CPU/memory/PID limits, capabilities removed, and no privilege escalation. There is no automatic restart loop. The application image must already be pushed by an authorized operator to the stack-named repository, and its actual distribution digest must be supplied; a local image ID is not that digest.

Parameters are existing VPC/subnets, qualified AMI, certificate/key identifiers, exact runtime secret ARN suffix, actual image digest, and approved viewer CIDR. Account/region are constructed from CloudFormation's own pseudo parameters; callers cannot substitute an arbitrary full secret ARN. The role has only exact-secret `GetSecretValue`, exact-key `Decrypt` conditioned on Secrets Manager and that secret's encryption context, and read access to the one stack-named ECR repository. The sole wildcard resource is ECR's authorization-token action; it does not grant other repository content access. [Secrets Manager policy controls](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html), [ECR policy examples](https://docs.aws.amazon.com/AmazonECR/latest/userguide/security_iam_id-based-policy-examples.html).

IMDSv2 is required; the metadata hop limit is one so only host bootstrap needs instance credentials. The encrypted 16 GB root disk is retained on termination. There is no unused attached data volume: clinic state and attachment durability belong to the dedicated Medplum prerequisite. Root-disk retention is host retention, not proof of clinical backup or restoration. [EC2 metadata options](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ec2-instance-metadataoptions.html), [EC2 block-device configuration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-instance.html).

Docker application logging is disabled for this synthetic baseline to reduce accidental content exposure. **There is no operational log or monitoring coverage claim.** Production needs sanitized, bounded logs, alarms, operator access and incident procedures before acceptance. Cloud-init/systemd may still record generic host/bootstrap errors; never add shell tracing or print private runtime content.

ALB health requests `/api/clinic/config`; qualify the packaged application with private-IP `Host` and no `Origin`. This confirms process/routing readiness only. Native storage and credentials may still fail the application gate, and actual ALB/TLS/network/IAM behavior remains unproved until live qualification.

## Upgrade and stop boundaries

Keep the existing image/profile/secret qualification and ledger identities together. Stop or drain the application before changing origin, identity/policy, selected delivery contract, native Questionnaire binding or proof. Current clinic delivery uses conditional create/CAS and resumable recovery; it has no transaction-plan or transaction-feature dependency. A new image never resets persisted ingress/provider budgets. Unknown receipts are reconciled rather than replayed. Updating image/secret input requires explicit host/service rollout; changing a CloudFormation UserData property alone does not assert a running host has restarted or loaded the new value. Do not terminate/recreate a node as an undocumented upgrade procedure, and never delete retained disks as routine cleanup.

The current stack is a single-node synthetic application baseline with no HA, monitoring, automated secret rotation or native restore proof. Certificate coverage, DNS, instance architecture/AMI, private routes, key/resource policies, memory/load, active-stream shutdown and the future Medplum stack are live acceptance gates. Hosting in AWS establishes no HIPAA compliance claim.
