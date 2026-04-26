/**
 * R2 multipart upload helpers used by the conduction page.
 *
 * Browser → Worker → R2: the participant page POSTs chunks to the
 * Worker, which streams them to R2 via createMultipartUpload + uploadPart.
 * Direct presigned-URL uploads from browser to R2 are also possible
 * once we add S3-compatible signing; for V1 we go through the Worker
 * to keep auth tight.
 */

export interface MultipartContext {
  bucket: R2Bucket;
  key: string;
  contentType: string;
}

export interface MultipartHandle {
  uploadId: string;
  key: string;
}

export async function startMultipart(
  ctx: MultipartContext,
): Promise<MultipartHandle> {
  const upload = await ctx.bucket.createMultipartUpload(ctx.key, {
    httpMetadata: { contentType: ctx.contentType },
  });
  return { uploadId: upload.uploadId, key: ctx.key };
}

export async function uploadPart(
  bucket: R2Bucket,
  handle: MultipartHandle,
  partNumber: number,
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
) {
  const upload = bucket.resumeMultipartUpload(handle.key, handle.uploadId);
  return upload.uploadPart(partNumber, body);
}

export async function completeMultipart(
  bucket: R2Bucket,
  handle: MultipartHandle,
  parts: Array<R2UploadedPart>,
) {
  const upload = bucket.resumeMultipartUpload(handle.key, handle.uploadId);
  return upload.complete(parts);
}

export async function abortMultipart(
  bucket: R2Bucket,
  handle: MultipartHandle,
) {
  const upload = bucket.resumeMultipartUpload(handle.key, handle.uploadId);
  return upload.abort();
}
