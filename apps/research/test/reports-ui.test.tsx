import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import {
  clientProjection,
  PublicationPreview,
  ReportContent,
  type ReportDocument,
  uncoveredPublicationCitations,
} from "../src/PublicationPreview";
import { boundedSourceBlob, portalGet } from "../src/ClientReportApp";
const document: ReportDocument = {
  title: "Synthetic checkout research",
  evidence: [
    {
      evidenceId: "private-source:db-id:2:10",
      kind: "self-report",
      sessionId: "private-session-db-id",
      start: 2,
      end: 10,
      fullArtifactLabel: "Entire source turn",
      sourceUntil: 100,
    },
  ],
  findings: [
    {
      id: "finding-1",
      statement: "Delivery cost was not clear",
      type: "self-report",
      supports: ["private-source:db-id:2:10"],
      counterevidence: [],
      limitations:
        "One participant self-report. Other sessions did not address this question.",
    },
  ],
  excerpts: [],
  grants: [],
};
describe("published research reading boundary", () => {
  test("cookie portal reads retain only a same-origin referrer and propagate cancellation", async () => {
    const controller = new AbortController();
    const response = new Response("approved");
    const fetchRead = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      for (const path of ["/api/research/portal/report?slug=fixture", "/api/research/portal/download?slug=fixture", "/api/research/portal/source/e1?slug=fixture&intent=view"]) {
        expect(await portalGet(path, controller.signal)).toBe(response);
        const [url, options] = fetchRead.mock.calls.at(-1)!;
        const request = new Request(new URL(String(url), "http://127.0.0.1:5174"), options);
        expect(request.credentials).toBe("same-origin");
        expect(request.cache).toBe("no-store");
        expect(request.referrerPolicy).toBe("same-origin");
        expect(request.headers.has("Authorization")).toBe(false);
        controller.abort();
        expect(request.signal.aborted).toBe(true);
      }
    } finally {
      fetchRead.mockRestore();
    }
  });
  test("preview readiness includes counterevidence and needs an excerpt or actual raw permission", () => {
    const citation = document.findings[0].supports[0];
    const draft = { ...document, findings: [{ ...document.findings[0], counterevidence: ["counter"] }] };
    expect(uncoveredPublicationCitations(draft)).toEqual([citation, "counter"]);
    expect(uncoveredPublicationCitations({ ...draft, excerpts: [{ evidenceId: citation, text: "Exact" }], grants: [{ evidenceId: "counter", view: false, download: false }] })).toEqual(["counter"]);
    expect(uncoveredPublicationCitations({ ...draft, excerpts: [{ evidenceId: citation, text: "Exact" }], grants: [{ evidenceId: "counter", view: true, download: false }] })).toEqual([]);
  });
  test("preview uses the portal aliases and neutral session labels", () => {
    const preview = clientProjection(document);
    expect(preview.findings[0].supports).toEqual(["e1"]);
    expect(preview.evidence[0]).toMatchObject({
      evidenceId: "e1",
      sessionLabel: "Session 1",
    });
    expect(JSON.stringify(preview)).not.toContain("db-id");
    expect(document.findings[0].supports).toEqual([
      "private-source:db-id:2:10",
    ]);
  });
  test("a reference does not publish an unapproved excerpt or grant a raw link", () => {
    const html = renderToStaticMarkup(
      createElement(ReportContent, { document: clientProjection(document) }),
    );
    expect(html).toContain("Source reference; no excerpt included.");
    expect(html).toContain("One participant self-report.");
    expect(html).not.toContain("<blockquote");
    expect(html).not.toContain("href=");
  });
  test("approved source text remains exact and escaped in the published reading view", () => {
    const html = renderToStaticMarkup(
      createElement(ReportContent, {
        document: clientProjection({
          ...document,
          excerpts: [
            {
              evidenceId: document.findings[0].supports[0],
              text: 'No <script>alert("x")</script> charge appeared.',
            },
          ],
        }),
      }),
    );
    expect(html).toContain("<blockquote>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  test("every approved excerpt is visible even when its finding was excluded", () => {
    const extra = {
      evidenceId: "private-second-id",
      kind: "self-report" as const,
      sessionId: "private-session-db-id",
      start: 0,
      end: 3,
    };
    const html = renderToStaticMarkup(
      createElement(ReportContent, {
        document: clientProjection({
          ...document,
          evidence: [...document.evidence, extra],
          excerpts: [{ evidenceId: "private-second-id", text: "No." }],
        }),
      }),
    );
    expect(html).toContain("Additional approved excerpts");
    expect(html).toContain("<blockquote>No.</blockquote>");
    expect(html).not.toContain("private-second-id");
  });
  test("publication requires a deliberate button and states full-artifact access", () => {
    const html = renderToStaticMarkup(
      createElement(PublicationPreview, {
        document: clientProjection({
          ...document,
          grants: [
            {
              evidenceId: document.findings[0].supports[0],
              view: true,
              download: true,
            },
          ],
        }),
        audience: "Synthetic client / Checkout",
        pending: false,
        error: "",
        onPublish: async () => undefined,
        onBack: () => undefined,
      }),
    );
    expect(html).toContain('type="button" disabled=""');
    expect(html).toContain("Publish reviewed report");
    expect(html).toContain("7 days from password-grant issue");
    expect(html).toContain("Downloaded files cannot be recalled.");
    expect(html).not.toContain("<form");
  });
  test("source fetch rejects an oversized response before reading media bytes", async () => {
    await expect(
      boundedSourceBlob(
        new Response("small", { headers: { "Content-Length": "8000001" } }),
      ),
    ).rejects.toThrow("Source exceeds bounds");
  });
});
