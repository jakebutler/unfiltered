import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: false,
  envPrefix: [],
  build: {
    outDir: 'dist', emptyOutDir: true, minify: false,
    lib: {
      entry: {
        server: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        qualify: fileURLToPath(new URL('./src/qualify.ts', import.meta.url)),
      },
      formats: ['cjs'], fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    rollupOptions: { external: ['convex/browser', 'convex/server', ...builtinModules, ...builtinModules.map(name => `node:${name}`)] },
  },
});
