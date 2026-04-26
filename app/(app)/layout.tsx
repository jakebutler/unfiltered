import { Sidebar } from "@/components/shared/sidebar";

// Authenticated app shell. Sidebar populates with workspace + email
// once WorkOS auth is wired (Phase 0 day 3-4) and we read the current
// user's workspace from D1.
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
