import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['apps/research-server/test/**/*.test.ts'], maxWorkers: 1, fileParallelism: false } });
