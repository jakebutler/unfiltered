import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['infra/cloud/vercel/test/**/*.test.ts'], maxWorkers: 1, fileParallelism: false } });
