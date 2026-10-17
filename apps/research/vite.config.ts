import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/capture": { target: "http://127.0.0.1:8789", changeOrigin: true },
      "/api/research": { target: "http://127.0.0.1:8789", changeOrigin: true, ws: true },
    },
  },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
