// Public finding share surface. Wires up in Phase 3 week 10
// alongside per-finding shareable URLs and redaction toggles.
export default async function PublicFinding({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Shared finding</h1>
      <p className="text-sm text-muted-foreground">
        Slug: <code>{slug}</code>
      </p>
      <p className="text-sm">
        Public finding surface ships in Phase 3 (week 10) with redaction
        toggles.
      </p>
    </main>
  );
}
