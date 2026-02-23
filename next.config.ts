import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import path from "path";

const makeNextConfig = (phase: string): NextConfig => {
  const isDevServer = phase === PHASE_DEVELOPMENT_SERVER;

  return {
    // Keep dev artifacts isolated from production build output.
    distDir: isDevServer ? ".next-dev" : ".next",
    turbopack: {
      root: path.resolve(__dirname),
    },
  };
};

export default makeNextConfig;
