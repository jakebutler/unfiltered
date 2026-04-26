export const runtime = "edge";

export async function GET() {
  return Response.json({
    ok: true,
    env: process.env.NODE_ENV,
    phase: "0",
    spec: "docs/v2-architecture-spec.md",
  });
}
