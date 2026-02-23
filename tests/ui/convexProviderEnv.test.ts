import { describe, expect, it, vi } from "vitest";

describe("ConvexClientProvider env handling", () => {
  it("throws when NEXT_PUBLIC_CONVEX_URL is missing", async () => {
    const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    delete process.env.NEXT_PUBLIC_CONVEX_URL;
    vi.resetModules();

    try {
      await expect(import("@/app/providers")).rejects.toThrow(
        "Missing required environment variable NEXT_PUBLIC_CONVEX_URL",
      );
    } finally {
      if (typeof originalUrl === "string") {
        process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl;
      } else {
        delete process.env.NEXT_PUBLIC_CONVEX_URL;
      }
      vi.resetModules();
    }
  });
});
