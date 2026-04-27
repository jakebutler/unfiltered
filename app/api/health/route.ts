// OpenNext on Cloudflare runs everything on the Workers runtime;
// no `export const runtime = "edge"` needed (and breaks the build).
export async function GET() {
  return Response.json({
    ok: true,
    env: process.env.NODE_ENV,
    phase: "0",
    spec: "docs/v2-architecture-spec.md",
  });
}
