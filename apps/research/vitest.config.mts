import { defineConfig } from "vitest/config";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: { environment: "node", include: ["apps/research/test/**/*.test.{ts,tsx}"] },
});
