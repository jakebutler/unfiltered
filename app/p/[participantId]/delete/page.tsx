// Participant data-deletion endpoint (GDPR / CCPA Art. 17).
// Wires up in Phase 2 week 6 alongside consent flow.
export default async function ParticipantDelete({
  params,
  searchParams,
}: {
  params: Promise<{ participantId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { participantId } = await params;
  const { token } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Delete your data</h1>
      <p className="text-sm text-muted-foreground">
        Participant: <code>{participantId}</code>
      </p>
      <p className="text-sm">
        Token validation + soft-delete + R2 object cleanup ships in Phase 2.
      </p>
      {!token && (
        <p className="text-sm text-destructive">
          Missing token. Click the deletion link from your confirmation email.
        </p>
      )}
    </main>
  );
}
