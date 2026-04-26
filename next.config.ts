import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Only attach the Cloudflare bindings proxy when actually running the
// dev server. Skipping during `next lint`, `next build`, and `tsc`
// avoids a remote-proxy auth attempt that requires `wrangler login`.
if (process.env.NEXT_DEV === "1") {
  initOpenNextCloudflareForDev();
}

const nextConfig: NextConfig = {
  experimental: {
    reactCompiler: false,
  },
};

export default nextConfig;
