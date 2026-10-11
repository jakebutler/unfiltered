# Private research S3 adapter — local validation and later deployment interface

This storage port for `BucketPrivateObjectStore` is composed by the independent research runtime in `research/entry.ts`. [Accepted package3 local workflow/recovery](../../docs/implementation/evidence/AWS-RESEARCH-LOCAL-ACCEPTANCE-2026-10-10.md) used modeled object storage; native S3 remains unqualified. Current research server defaults/local fixtures are unchanged. No deployment or credential discovery command is provided. Read `S3-CONTRACT.md` first. PHI/provider flags stay closed; AWS storage, contracts/BAAs, key/IAM/network, consent/deletion and operational qualification require explicit acceptance before real data. Clinical Medplum storage remains a separate prerequisite.

## Offline checks

Use Node22 with a 1 GiB heap and coordinate the serial slot. Tests use synthetic data, command mocks and an official SDK request handler that returns in-memory HTTP responses; they use no AWS credentials/socket. The wire test signs with deliberately fictitious credentials solely inside the mock handler. There is no S3-compatible Docker service.

```sh
NODE_OPTIONS=--max-old-space-size=1024 node node_modules/typescript/bin/tsc -p infra/aws/tsconfig.s3.json
NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vitest/vitest.mjs run --config infra/aws/vitest.config.mts infra/aws/test/s3.test.ts infra/aws/test/research-storage.test.ts --maxWorkers=1 --no-file-parallelism
node --experimental-strip-types infra/aws/synth-research-storage.mjs --manifest infra/aws/examples/research.json --output infra/aws/.private/research-storage-template-1.json
AWS_EC2_METADATA_DISABLED=true AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null infra/aws/.private/lint-venv/bin/cfn-lint -t infra/aws/.private/research-storage-template-1.json -r us-east-1
```

Use a new output name on every synthesis; existing output paths fail. The pinned isolated linter environment is described in `OPERATIONS.md`. This template is a three-resource private bucket/role/policy baseline, not compute/Convex/TLS deployment. It uses the research manifest and a real existing KMS key identifier supplied later; it invents no key/AMI/credential. Scope is standard commercial AWS endpoints/ARNs, not GovCloud/China/directory buckets/Outposts.

## Server interface and qualification boundary

`await S3PrivateBucketPort.open(config, explicitCredentialProvider)` performs startup control checks before returning an operational port. The independent runtime wraps it in the unchanged `new BucketPrivateObjectStore(port)`, keeps existing capture/report authorization, and calls `port.close()` on shutdown. This composed source is not actual AWS storage acceptance. Credentials belong to an explicitly selected runtime role/provider; the adapter never chooses ambient profiles or a default credential chain. Its trusted HTTPS regional endpoint ignores ambient endpoint overrides and cannot be replaced by a config URL. Tests may provide an in-memory SDK request handler.

`config` binds the observed bucket name, commercial region, 12-digit owner account, exact KMS key ARN, fixed research object namespace and optional reduced deadline (1–15,000 ms). Namespace/key shape is validated and each request carries `ExpectedBucketOwner`. Template outputs supply bucket/namespace/key/runtime role; derive these values from the approved research profile rather than browser input. No S3 URL, presign, ACL, delete, copy or multipart method is exposed.

Startup reads versioning, lifecycle, replication, Object Lock, encryption, public-access blocking and ownership. Known absence is required for lifecycle/replication/lock; an unknown/403 response fails. Versioning must never have been enabled: **Suspended is rejected**. Encryption must use the exact key with bucket keys disabled, every public-access block must be true, and ownership must be bucket-owner-enforced. Per-object reads reject historical version, delete marker, expiry, replication, lock, encoding or mismatched integrity/encryption metadata.

Each SDK operation has `maxAttempts: 1` and a deadline; a seven-control startup can take at most seven operation deadlines. Body streaming has its own reduced deadline, byte-count enforcement, full-read SHA256 verification, 256 KB output chunks and bounded prefetch. Unknown or mismatched write acknowledgements throw; reconcile the same key through existing HEAD/authority flow before any explicitly authorized attempt transition. A native body is destroyed on cancellation/error/deadline. Range reads validate exact ETag/metadata/range before returning a body. Whole-object checksum failure may be detected at stream end; bytes already delivered cannot be recalled. The unchanged gateway checks current consent before later chunks.

## Permanent retirement and control-plane assumptions

The runtime role has object GET/PUT only in the fixed namespace, bucket control reads and one bucket's ListBucket permission (needed for authoritative absent HEAD404), plus exact-key GenerateDataKey/Decrypt conditioned on S3 and object encryption context. It has no delete/version-read/configuration-write permission. The bucket policy blocks public/presigned object access, other object principals, non-TLS requests, wrong KMS algorithm/key, deletion of markers, and versioning/lifecycle/replication/Object Lock changes. Conditional creation and zero-byte retirement body rules are enforced by trusted adapter code: IAM alone does not prove an unconditional body is zero bytes. [AWS HEAD permission/checksum requirements](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html), [S3 signature/auth-type policy keys](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/bucket-policy-s3-sigv4-conditions.html).

The new bucket is retained on stack deletion/replacement and omits versioning entirely. No raw-object expiry rule is allowed: cleanup replaces raw bytes with permanent zero-byte markers. Markers must not be deleted, including after ordinary application retention ends. Restore/backup/replication must not reintroduce withdrawn bytes or erase fences; none is supplied or qualified here. Storage costs remain possible for retained data/markers after a future authorized deployment; this task incurred no AWS usage.

Startup qualification is **not atomic with later control-plane drift**, and is not native AWS retirement proof. Stop writers, preserve unknown receipts and requalify before approved configuration/policy/key changes. An administrator capable of replacing bucket/IAM/key policies remains a trusted deployment authority, not an adversary this library can fence atomically. Do not silently enable then suspend versioning, relax the marker policy, point to an old bucket, or restart against restored raw data.

## Native acceptance still required

Before integration/live acceptance, explicitly qualify actual bucket creation settings, exact role/key policies, private routes/TLS, owner/region, conditional create vs retirement in both race orders, unknown accepted response reconciliation, exact ranged bodies/cancellation, withdrawal between chunks, physical current-object retirement and absence of historical copies. Local mocks/lint establish client serialization and modeled invariants only; they do not exercise native S3 server consistency/IAM/network or establish a HIPAA compliance claim. [AWS conditional-write behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [AWS strong consistency](https://aws.amazon.com/s3/consistency/).
