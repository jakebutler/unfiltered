import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['packages/research-core/test/**/*.test.ts'], server: { deps: { inline: ['convex-test'] } } } });
