import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', maxWorkers: 2, include: ['packages/research-capture/test/**/*.test.ts'], server: { deps: { inline: ['convex-test'] } } } });
