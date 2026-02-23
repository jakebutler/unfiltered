"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import React, { useMemo } from "react";

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const convex = useMemo(() => {
    if (!convexUrl) return null;
    return new ConvexReactClient(convexUrl);
  }, [convexUrl]);

  if (!convex) {
    return (
      <main className="min-h-screen p-6">
        <h1 className="text-lg font-semibold">Missing NEXT_PUBLIC_CONVEX_URL</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Configure the Convex deployment URL in your environment before using the app.
        </p>
      </main>
    );
  }

  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
