import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['infra/cloud/vercel/research/test/**/*.test.ts', 'packages/research-capture/test/r2-bucket.test.ts', 'apps/research-server/test/hosted-runtime.test.ts'], maxWorkers: 1, fileParallelism: false } });
