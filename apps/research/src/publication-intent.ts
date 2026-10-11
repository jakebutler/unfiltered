export type PublicationReceipt = { reportId: string; version: number; publishedAt: number; expiresAt: number };

// Legacy intents contain only an identifier. A later saved review is the only
// native evidence available that their analysis has changed since publication.
export function canPrepareRevisedPublication(receipt: PublicationReceipt | null | undefined, review: { state: string; revision: number; reviewedAt: number | null } | undefined, previousRevision: number | null, pending: boolean): boolean {
  return !pending && !!receipt && !!review && review.state === "ready" && review.reviewedAt !== null &&
    (previousRevision === null ? review.reviewedAt > receipt.publishedAt : review.revision > previousRevision);
}

export function retainCompletedPublication(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, key: string, requestId: string, receipt: PublicationReceipt, reviewRevision: number | null): void {
  // Archive first. A failed write must never discard the reconciliation key.
  storage.setItem(`${key}.completed.${requestId}`, JSON.stringify({ requestId, receipt, reviewRevision }));
  storage.removeItem(key);
  storage.removeItem(`${key}.revision`);
}
