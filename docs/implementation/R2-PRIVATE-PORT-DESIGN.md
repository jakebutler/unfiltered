# Private R2 port: proposed bounded contract

Design only, 2026-10-10. No implementation, credentials, cloud calls or bucket mutations. Root's account inspection and the user-selected R2 decision are recorded in [RESEARCH-HOSTED-DEMO-PLAN.md](RESEARCH-HOSTED-DEMO-PLAN.md). Both existing buckets were empty/private; no deletion was performed. This design preserves the completed [hosted injection boundary](evidence/S7-HOSTED-RUNTIME-BOUNDARY.md), local defaults, consent authority and 4,000,000-byte hosted envelope.

## Narrow interface and ownership

Proposed new files: `packages/research-capture/src/r2-bucket.ts` and its focused test file. Implement `PrivateBucketPort` from `bucket-store.ts`; compose `new BucketPrivateObjectStore(port)` and supply it as the hosted handler's existing `store` dependency. No new gateway, object schema, Convex File Storage adapter or change to `s3-bucket.ts`.

Proposed constructor contract:

```ts
R2PrivateBucketPort.create(config, explicitCredentialProvider, transport?)
  => PrivateBucketPort

config = {
  accountId: '728ae4b71b42dfcef062336c06bd8595',
  bucket: 'unfiltered-recordings',
  namespace: /* root manifest's fixed, validated prefix */,
  deadlineMs: /* positive, at most 15000 */,
  maxObjectBytes: /* positive, at most 4000000 */
}
```

The constructor performs local validation only. Derive the exact default endpoint `https://728ae4b71b42dfcef062336c06bd8595.r2.cloudflarestorage.com`, region `auto`, and path-style addressing; do not accept an arbitrary URL, redirect, ambient AWS profile or inherited env activation. Root must confirm default jurisdiction before configuration; WNAM placement is not an SDK region. Credentials are private runtime inputs, never manifest values. Cloudflare documents account endpoints, jurisdiction-specific alternatives and bucket-scoped Object Read & Write credentials. First scope the credential to `unfiltered-recordings`; do not request account/bucket administration. `unfiltered-analysis` remains unused because published reports currently live in Convex, not object storage. [Credentials and endpoints](https://developers.cloudflare.com/r2/api/tokens/), [SDK configuration](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/).

## Storage operations

Use the existing AWS SDK dependency with `maxAttempts: 1`, explicit credentials, one operation deadline and no multipart or bucket-management commands. Permit only PUT, HEAD and GET against validated native keys under the fixed namespace. Do not issue DELETE or auto-create headers. R2 supports conditional PUT/GET and ranged GET, but lacks the AWS KMS/ExpectedBucketOwner/ACL checks and SHA256 `FULL_OBJECT` checksum used by the AWS port. Disable optional automatic checksum selection; retain local SHA256 validation and ASCII `state`/`sha256` metadata rather than claiming an R2-returned SHA256 receipt. [Compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [metadata/extensions](https://developers.cloudflare.com/r2/api/s3/extensions/).

- **Available PUT:** copy and validate immutable body length, SHA256 and MIME before dispatch; cap at 4 MB. Send `If-None-Match: *`, explicit Content-Length/Content-Type and metadata `{state:'available', sha256}`. Only typed precondition failure maps to `exists`; the existing store then requires matching HEAD metadata. A conflicting object is never overwritten. Timeout/disconnect/5xx is unknown, not a negative receipt.
- **HEAD:** validate available metadata, bounded length, allowed MIME and bounded opaque ETag. A retired row must be zero bytes, octet-stream, with exactly the retirement state. Only a proven object-missing response maps to null; missing bucket, authentication failure and network errors remain failures. HEAD's bodyless 404 distinction needs live qualification with the scoped credential, rather than treating every 404 as absence. [R2 errors](https://developers.cloudflare.com/r2/api/error-codes/).
- **GET:** use a validated HEAD identity with `If-Match` and exact Range. Verify returned ETag, metadata, MIME, Content-Range and length. Bound chunks, deadline and actual streamed bytes; short/overlong responses error without successful truncation. Full-object reads verify SHA256; a partial range relies on the pinned object identity and must not claim an independently verified full-object checksum. Existing gateway native consent/grant checks continue before dispatch and each chunk. No direct or presigned URLs. [Presigned access](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
- **Retire:** PUT only a zero-byte octet-stream tombstone with `{state:'retired'}`, then verify HEAD. Never DELETE or expire the marker. It replaces content while fencing late conditional creation. No content deletion claim follows merely from scheduling or a failed request.

## Races, unknown outcomes and cleanup

The native media-attempt row reserves the exact key before any upload. If content creation wins a race, retirement overwrites it; if retirement wins, the old conditional creation must fail. A repeated upload may reconcile only against the exact existing metadata and current native consent. An unknown upload cannot reuse its key or silently retry: reconcile its pre-reserved key, or retire/fence the old attempt before a separately admitted new attempt. Retirement is idempotent work that may be rescheduled under a durable cleanup lease and finite operation allowance, including when its previous outcome is unknown.

R2 documents strong read-after-write/list consistency and last-completed-writer behavior. Those facts do not alone prove the conditional race; qualify both orderings, especially a delayed original PUT after verified retirement. Keep the tombstone permanently unless root separately establishes that no admitted writer can ever address the namespace. User disposal permission is not a reason to remove these fences during active operation. [Consistency](https://developers.cloudflare.com/r2/reference/consistency/).

Retirement can receive 429 from R2's per-key write rate limit. Keep native delete-pending state, deny reads immediately and retry bounded retirement work later; do not bypass the fence by deleting the object. Authentication/timeouts never become proof of deletion. A zero retired HEAD plus bounded GET readback confirms no content is retrievable through this object path, not forensic erasure. [Error/rate-limit behavior](https://developers.cloudflare.com/r2/api/error-codes/).

Use existing persisted cleanup keys/claims, with a durable scheduled worker and bounded batches. Do not start the process timer, rely on the bucket's incomplete-multipart rule (this port never uses multipart), or add paid Event Notifications. Distributed admissions and durable cleanup remain hosted activation blockers, independent of the adapter.

## Required qualification before activation

Offline SDK-wire tests must cover conditional headers, fixed endpoint/scoped credential injection, no retries/AWS KMS headers, conflicting metadata, missing versus denied HEAD, exact range/stream/hash limits, both delayed-write race orders and unknown retirement readback. Reuse existing gateway cross-client and midstream-consent tests. Independently qualify two-instance admissions and durable cleanup before claiming a hosted workflow.

Root's later cloud qualification needs an explicit bounded operation allowance, scoped credentials and unique owned synthetic keys. Prove actual conditional conflict, both race orderings, exact ranged/full reads and durable tombstone readback. Preserve buckets/settings and report unknown outcomes without automatic upload replay. No provider activation, deployment or cloud action is authorized by this design.
