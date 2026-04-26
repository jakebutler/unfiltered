export default function MarketingHome() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 p-8 text-center">
      <span className="rounded-full border px-3 py-1 text-xs uppercase tracking-widest text-muted-foreground">
        Phase 0 — scaffolding
      </span>
      <h1 className="text-balance text-5xl font-semibold tracking-tight">
        Unfiltered
      </h1>
      <p className="max-w-xl text-pretty text-lg text-muted-foreground">
        Always-on AI voice interviewer for honest, multimodal user research.
        Synthetic users for pre-flight, real interviews on demand,
        evidence-grounded findings.
      </p>
      <p className="text-sm text-muted-foreground">
        See <code className="font-mono">docs/v2-architecture-spec.md</code> for
        the full plan.
      </p>
    </main>
  );
}
