import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['packages/clinical-core/test/**/*.test.ts', 'packages/clinic-content/test/**/*.test.ts', 'packages/clinic-api/test/**/*.test.ts', 'packages/speech/test/**/*.test.ts'] } });
