# Dedicated synthetic Medplum package

This package is an AWS baseline for an independent clinic authority, validated locally without AWS deployment. [Package5/6 reproducibility](../../../docs/implementation/evidence/AWS-MEDPLUM-EMPTY-DIRECTORY-REPAIR.md) and the [accepted Q3 synthetic checkpoint restore](../../../docs/implementation/evidence/AWS-MEDPLUM-NATIVE-2026-10-10-Q3.md) are recorded separately from future deployment qualification. Keep PHI and providers disabled. Hosting on AWS establishes no HIPAA compliance; contracts/BAAs, service-specific data flows, clinical governance, qualified deployment and operational controls are separate mandatory gates.

Q3 used frozen package5, aggregate `dd652af0adc7b87a33c5179acc194e46829d9286d82066d11561d3714a7d4dcb`; package6 has the same 11-file manifest and hashes. It passed 17 source and 17 restored checks covering native IDs/history/versions, Binary integrity/securityContext, precheckpoint access denials, ledger state, transaction rollback and stale CAS, with Redis state preserved. Normal packaged start remained denied and restored traffic stayed sealed. This acceptance does not establish final clinic-manifest native wiring, current postcheckpoint authority reconciliation, native AWS behavior or off-host archive/key recovery. No repeat drill is required for that unchanged proof.

## Offline build and lint

Use Node22.22.3 and a 1 GiB heap; coordinate the serial check slot. Existing public clinic examples are the only packager inputs. Vite environment discovery/injection is disabled. Each output must be new under ignored private `infra/aws/.private/`; preserve failed/old artifacts rather than overwriting them.

```sh
node --max-old-space-size=1024 --experimental-strip-types --test --test-concurrency=1 --test-timeout=10000 infra/aws/test/medplum-config.test.mjs infra/aws/test/medplum-archive.test.mjs infra/aws/test/medplum-sequence.test.mjs
node --max-old-space-size=1024 --experimental-strip-types infra/aws/medplum/package.mjs --manifest infra/aws/examples/clinic-a.json --output infra/aws/.private/medplum-clinic-a-package-new
node --max-old-space-size=1024 --experimental-strip-types infra/aws/synth-medplum.mjs --manifest infra/aws/examples/clinic-a.json --package infra/aws/.private/medplum-clinic-a-package-new --output infra/aws/.private/medplum-clinic-a-template-new.json
AWS_EC2_METADATA_DISABLED=true AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null infra/aws/.private/lint-venv/bin/cfn-lint -t infra/aws/.private/medplum-clinic-a-template-new.json -r us-east-1
```

The package contains bundled Node entrypoints, shared chunks, public clinic manifest, exact images/Compose and bootstrap. `package.json` records every file hash and aggregate hash; repeat builds must match those hashes. No install, Docker command, secret discovery or cloud API occurs during packaging/synthesis. A package built for one profile cannot synthesize another profile. New native container execution is a separate resource/authority gate.

## Deployment inputs and private network

One ARM64 t4g.medium (2 vCPU/4 GiB) plus encrypted retained16 GiB root and40 GiB data volume is a **synthetic initial profile**, not production sizing. PostgreSQL/Binary/Redis share the actually mounted authority data volume. The internal TLS ALB needs existing private subnets in two AZs; the node's subnet and explicit data-volume AZ must match. Private DNS/certificate coverage, key/resource policies, secret existence and routes to the public image registries and Secrets Manager are independently qualified inputs. No NAT or new managed database is created here.

The edge admits only the exact clinic-server SG over443. The node admits8103 only from the edge; no public IP, SSH, PostgreSQL/Redis ports or Medplum App/admin route. This cannot serve direct browser OAuth redirects or a browser's direct FHIR SDK. Server-mediated clinic auth still requires native qualification. No private operator ingress path is supplied by this template.

Additional future charges include node hours, internal ALB/LCUs, EBS, Secrets/KMS, private egress infrastructure and independently exported backups. No cost allowance, current price or AWS action is implied. This single node has no HA, scheduled backup service or monitoring/alerting. Docker logs are disabled for the synthetic baseline; sanitized bounded production logs remain required.

## Qualified AMI and mount boundary

The AMI must have `/usr/bin/node`22.22.3, `/usr/bin/docker` with Compose v2, AWS CLI v2, systemd, util-linux `lsblk/findmnt/mount`, ext4 `wipefs/mkfs.ext4`, and the exact package installed at `/opt/unfiltered-medplum`. Verify package hashes before trusting any script. Image pins reuse `infra/local` ARM64 qualification; other architectures and new container UID/entrypoint/config behavior remain unqualified.

Bootstrap does not format. On a fresh raw volume, startup deliberately fails before secret rendering or service startup. A separately authorized operator first observes the new CFN-created EBS volume ID, verifies it is new/empty and in the correct AZ, and performs explicit initialization. The following commands consume that observed ID, not an invented example. Do not run them on a retained/restored volume or an ambiguous device.

```sh
node /opt/unfiltered-medplum/volume.mjs --volume-id "$OBSERVED_NEW_VOLUME_ID" --initialize-new-resource "$OBSERVED_NEW_VOLUME_ID" --clinic /opt/unfiltered-medplum/clinic.json
systemctl start unfiltered-medplum.service
```

Initialization requires root, exact whole-disk EBS serial, no partitions/mounts/signatures, an empty unmounted destination, and a new exclusive intent file. Signature absence alone does not establish that arbitrary raw media is unused; the operator's new-resource observation is mandatory. An interrupted intent or ambiguous disk stops progress for investigation. Normal mount checks require ext4 UUID, EBS serial and the matching private authority marker; they never fall back to `mkfs`. [AWS volume identification](https://docs.aws.amazon.com/ebs/latest/userguide/identify-nvme-ebs-device.html).

Services start only after mount/config checks. `LaunchPhase=initialize` requires completely empty marked PostgreSQL/Binary/Redis directories and bootstrap-admin fields. Successful initial health updates the authority marker; after explicit setup/native qualification, remove bootstrap fields from the backend secret and change the service phase to `resume`. CloudFormation UserData updates alone do not prove a running service has changed. There is no container/systemd restart loop or recovery reopen. Failed/unknown initial startup may leave containers; close clinic admission and inspect owned state before cleanup or another start.

## Separate secret and key recovery

Backend secret name is exactly `unfiltered/<stack>/medplum`, with schema1, exact `stackId`, database/Redis passwords (32–256 URL-safe characters), stable RSA2048–4096 PEM `signingKey` and opaque `signingKeyId`. Initialization alone adds `bootstrapAdmin` (email/password/client UUID/client secret). Resume/restore reject bootstrap fields. Strict validation rejects unknown/provider fields. This secret is distinct from the scoped clinic `.../runtime` secret and must never be copied into clinic assets/config.

Host IAM can read only the exact backend secret and decrypt only its KMS key/context. Bootstrap puts validated private config in `/run`, mounts individual private files and removes its fetched secret copy. No secret values enter template parameters, receipts or systemd environment; no shell tracing. Docker/host administrators remain trusted. The private signing key, DB/Redis passwords and current clinic runtime secrets need independently approved recovery/escrow; this package does not export them.

Archive encryption uses a separate private32-byte operator key file. Never put it in the archive, same backup folder or backend secret. Keep independently recoverable keys and verify a recoverable encrypted copy away from the data-volume failure domain. A backup kept on its source volume is staging, not disaster protection.

## Bounded native backup and sealed restore commands

The commands below are **future authorized native operations**, not commands executed in the offline evidence. Supply an observed owned project (`uf-aws-medplum-<stack>-<12 hex>`), explicit Unix Docker socket, real private runtime config, separate archive key, and new private work/archive/receipt paths. Docker auth discovery is replaced with an empty private config. Never target the existing local clinic project or reuse a failed receipt/intent.

Before backup, close/drain clinic writers and preserve unknown effects. Revalidate the mounted authority identity. `--writers-sealed` is an explicit operator attestation, not proof a remote app is stopped. Backup stops Medplum, admits only the supported single SQL owner `medplum`, obtains Redis `SAVE` acknowledgement and requests bounded Redis stop, dumps PostgreSQL while it remains running and copies Binary/Redis state. No automatic restart occurs, even on success. Actual graceful exit and complete Redis state require native evidence; mock command ordering does not prove them.

```sh
node /opt/unfiltered-medplum/backup.mjs --backup --config "$OWNED_SOURCE_CONFIG" --project "$OWNED_SOURCE_PROJECT" --docker-host "$OBSERVED_DOCKER_SOCKET" --work "$NEW_PRIVATE_BACKUP_WORK" --archive "$NEW_PRIVATE_ARCHIVE" --key-file "$SEPARATE_PRIVATE_ARCHIVE_KEY" --writers-sealed "$EXACT_STACK_ID" --receipt "$NEW_PRIVATE_BACKUP_RECEIPT"
```

The single AES-256-GCM envelope has fresh12-byte nonce and one final16-byte tag, no chunk encryption/key derivation/compression. Authenticated plaintext contains a bounded manifest then exact regular-file bytes. Archive v2 (`UFMP002`, manifest schema2) authenticates an explicit directory inventory, including both required roots and empty nested trees. Limit64 MiB/4096 aggregate file-and-directory entries; missing database/root declarations, duplicate/conflicting paths, unsafe paths/symlinks, extra bytes, changed/growing sources and checksum mismatches fail. [PostgreSQL snapshot/owner scope](https://www.postgresql.org/docs/16/backup-dump.html), [Redis persistence choices](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

Historical v1 archives are rejected; this package provides no implicit conversion or inference of missing directory declarations. Preserve any old archive and its original reader for separately reviewed migration.

Prepare a new empty owned target with matching profile/pins, then render with `--phase restore`, recovered backend secret without bootstrap fields and a new private config directory. The rendered authority has no host listener. Existing PostgreSQL/Binary/Redis directories cannot be overwritten. Authenticate and validate the entire archive in private scratch before any target database command or clinical file installation; scratch is removed on authentication/parse failure and completion. Failed extracted work is preserved privately for investigation. Archive/receipt intent remains immutable.

```sh
node /opt/unfiltered-medplum/render.mjs --backend-secret "$RECOVERED_PRIVATE_BACKEND_SECRET" --phase restore --data "$EMPTY_OWNED_TARGET_DATA" --output "$NEW_PRIVATE_TARGET_CONFIG" --listen 127.0.0.1:8103
node /opt/unfiltered-medplum/restore.mjs --restore --config "$NEW_PRIVATE_TARGET_CONFIG" --project "$OWNED_TARGET_PROJECT" --docker-host "$OBSERVED_DOCKER_SOCKET" --work "$NEW_PRIVATE_RESTORE_WORK" --archive "$PRIVATE_ENCRYPTED_ARCHIVE" --key-file "$SEPARATE_PRIVATE_ARCHIVE_KEY" --receipt "$NEW_PRIVATE_RESTORE_RECEIPT"
```

Restore starts only PostgreSQL, uses `pg_restore --single-transaction --exit-on-error`, installs authenticated Binary/Redis files, records `restored-sealed`, then stops PostgreSQL. It never starts Medplum/Redis workers or opens traffic. In-progress/unknown restoration is not retryable automatically. A failed copy is not accepted as a qualified destination. `start.mjs` denies restored/in-progress state; no generic unseal switch is provided.

The supported restore is same pinned Medplum/Postgres/Redis and one SQL owner, preserving IDs/history/ACLs through the dump. It excludes generic SQL-role/tablespace migration, physical PostgreSQL directory copying, WAL/PITR and version upgrades. Restore to another architecture is unqualified.

Current withdrawals/permissions and external provider budget/unknown outcomes must be reconciled **after** checkpoint recovery before any future reopen. A point-in-time copy cannot preserve later effects. Never reset ingress/provider namespaces or replay a restored queue. Workers, external email, project SMTP, bots and automatic downloads remain disabled. Current clinic delivery requires its selected `conditional-resumable-v1` qualification and exact native Questionnaire history binding; it has no transaction-plan or transaction-feature dependency. Q3 transaction rollback checks remain historical restore evidence. [Medplum recovery considerations](https://www.medplum.com/docs/self-hosting/disaster-recovery).

The accepted Q3 drill used fresh synthetic source/restore projects under the 2CPU/4 GiB resource bound, stopped the source before restore and verified owned-container shutdown. Its immutable receipt and precise limits are linked above; original failed attempts remain retained. Remaining local clinic acceptance is a current final-version artifact and patient-to-staff wiring through two independent packaged client profiles with their native authorities; old clinic A/B bundles are incompatible with Q4f conditional-resumable configuration. Independent research package3 has [accepted local native persistence and sealed recovery/quarantine](../../../docs/implementation/evidence/AWS-RESEARCH-LOCAL-ACCEPTANCE-2026-10-10.md), with final source reconciliation still separate; see the [package inventory](../README.md). Native AWS IAM/TLS/network/volume behavior, off-host archive/key recovery and production recovery remain unqualified. A materially changed package/pin or recovery contract needs scoped review and validation before inheriting Q3 acceptance.
