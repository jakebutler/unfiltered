import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['infra/aws/test/**/*.test.ts'], maxWorkers: 1, fileParallelism: false } });
