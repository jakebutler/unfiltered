import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Separate loopback-only development entry. Never used by the production build.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 5190, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8790', changeOrigin: false, ws: true } } },
});
