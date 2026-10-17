import { cleanupObjects, type CaptureAuthority } from '../../../packages/research-capture/src/gateway';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';

/** Convex's persisted delete-pending rows are the queue. Each sweep is at most
 * ten receipts; failures retain their intent for the next bounded serial turn. */
export function startCleanupWorker(store: PrivateObjectStore, authority: CaptureAuthority, intervalMs: number) {
  let stopping = false, timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | undefined;
  const status = { cycles: 0, retired: 0, consecutiveFailures: 0, lastCompletedAt: null as string | null };
  const run = async () => {
    try {
      const count = await cleanupObjects(store, authority);
      status.cycles++; status.retired += count; status.consecutiveFailures = 0; status.lastCompletedAt = new Date().toISOString();
    } catch {
      status.consecutiveFailures++;
      // No request arguments, credentials, keys, transcripts or upstream error text.
      if (status.consecutiveFailures === 1) console.error('Research cleanup deferred; persisted intent will be retried.');
    } finally {
      running = undefined;
      if (!stopping) timer = setTimeout(start, Math.min(30_000, intervalMs * 2 ** Math.min(status.consecutiveFailures, 4)));
    }
  };
  const start = () => { if (!stopping) running = run(); };
  start();
  return { status, async stop() { stopping = true; clearTimeout(timer); await running; } };
}
