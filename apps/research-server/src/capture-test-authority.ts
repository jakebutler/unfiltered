import { makeFunctionReference } from 'convex/server';
import { randomBytes, createHash } from 'node:crypto';
import { boundedReadinessClient } from './readiness-authority';
import { signGateway } from '../../../packages/research-capture/src/proof';
import type { StudyReadinessScope, StudyRuntimeFacts } from '../../../packages/research-core/src/readiness';
import type { StudyWelcome, CaptureTestIssue, CaptureTestReceipt, CaptureTestStatus, CaptureTestClosed, CaptureTestPreview } from '../../../packages/research-core/src/welcome';
export type CaptureTestReadback = CaptureTestClosed | { state: 'unresolved' } | { state: 'found'; receipt: CaptureTestReceipt };
export interface CaptureTestAuthority {
  preview(scope: StudyReadinessScope, runtime: StudyRuntimeFacts): Promise<CaptureTestPreview>;
  issue(input: CaptureTestIssue, runtime: StudyRuntimeFacts): Promise<{ receipt: CaptureTestReceipt; token: string | null } | CaptureTestClosed>;
  close(input: CaptureTestIssue): Promise<Exclude<CaptureTestReadback, { state: 'unresolved' }>>;
  receipt(input: CaptureTestIssue): Promise<CaptureTestReadback>;
  status(input: CaptureTestIssue, runtime: StudyRuntimeFacts): Promise<CaptureTestStatus>;
}
/** No retry and no stored plaintext capability. A lost first response resolves via receipt only. */
export function captureTestAuthority(deployment: string, secret: string, bearer: string, signal: AbortSignal): CaptureTestAuthority {
  const client = boundedReadinessClient(deployment, bearer, signal);
  const read = async <T>(name: string, operation: string, input: Record<string, unknown>) => client.query(makeFunctionReference<'query'>(`researchCaptureTests:${name}`), { ...input, proof: await signGateway(secret, `readiness:${operation}`, input) }) as Promise<T>;
  return {
    preview: (scope, runtime) => read('preview', 'welcomePreview', { scope, runtime }),
    async issue(input, runtime) {
      const token = randomBytes(32).toString('hex'), body = { input, runtime, tokenHash: createHash('sha256').update(token).digest('hex') };
      const result = await client.mutation(makeFunctionReference<'mutation'>('researchCaptureTests:issue'), { ...body, proof: await signGateway(secret, 'readiness:captureTestIssue', body) }) as { receipt: CaptureTestReceipt; inserted: boolean } | CaptureTestClosed;
      if ('state' in result) return result;
      return { receipt: result.receipt, token: result.inserted ? token : null };
    },
    async close(input) {
      const body = { input };
      return client.mutation(makeFunctionReference<'mutation'>('researchCaptureTests:close'), { ...body, proof: await signGateway(secret, 'readiness:captureTestClose', body) }) as Promise<Exclude<CaptureTestReadback, { state: 'unresolved' }>>;
    },
    receipt: input => read('receipt', 'captureTestReceipt', { input }),
    status: (input, runtime) => read('status', 'captureTestStatus', { input, runtime }),
  };
}
