import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

describe("ConvexClientProvider env handling", () => {
  it("does not throw during render when NEXT_PUBLIC_CONVEX_URL is missing", async () => {
    const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    delete process.env.NEXT_PUBLIC_CONVEX_URL;
    vi.resetModules();

    try {
      const { ConvexClientProvider } = await import("@/app/providers");
      const html = renderToString(
        createElement(
          ConvexClientProvider,
          null,
          createElement("div", null, "child"),
        ),
      );
      expect(html).toContain("Missing NEXT_PUBLIC_CONVEX_URL");
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
