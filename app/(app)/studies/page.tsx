// Studies list — wired in Phase 0 day 6-7 (UI shell) and populated
// from D1 in Phase 1 once Drizzle queries are in place.

export default function StudiesPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Studies</h1>
      <p className="text-sm text-muted-foreground">
        Studies list — Phase 0 placeholder. Wires up when D1 is provisioned and
        WorkOS auth is connected.
      </p>
    </div>
  );
}
