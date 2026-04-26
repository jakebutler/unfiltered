// Participant consent + study landing.
// Wires up in Phase 2 week 6 (invitations + consent flow).
export default async function JoinStudy({
  params,
}: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Welcome to your interview</h1>
      <p className="text-sm text-muted-foreground">
        Invitation: <code>{invitationId}</code>
      </p>
      <p className="text-sm">
        Consent screen + bot disclosure ships in Phase 2 (week 6).
      </p>
    </main>
  );
}
