"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import React from "react";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error(
    "Missing required environment variable NEXT_PUBLIC_CONVEX_URL. " +
      "Configure it in your deployment environment before building.",
  );
}
const convex = new ConvexReactClient(convexUrl);

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
