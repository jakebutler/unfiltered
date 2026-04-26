// Authenticated app shell. Sidebar + auth wired in Phase 0 day 3-4.
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r bg-muted/30 p-6">
        <div className="text-sm font-semibold">Unfiltered</div>
        <div className="mt-2 text-xs text-muted-foreground">
          Sidebar wires up in Phase 0 day 6-7.
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
