// Live conduction page: Vapi voice + camera + screen + audio capture.
// Wires up in Phase 2 week 7.
export default async function InterviewRoom({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Interview in session</h1>
      <p className="text-sm text-muted-foreground">
        Session: <code>{sessionId}</code>
      </p>
      <p className="text-sm">
        Vapi voice + MediaRecorder + Durable Object wiring ships in Phase 2
        (week 7).
      </p>
    </main>
  );
}
