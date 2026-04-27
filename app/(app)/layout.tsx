import { Sidebar } from "@/components/shared/sidebar";
import { requireSession } from "@/lib/auth/session";

// Authenticated app shell. Resolves the WorkOS user → D1 workspace +
// membership in one query, redirects to "/" if the session can't
// be reconciled, and feeds workspace/email into the sidebar.
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { workspace, user } = await requireSession();
  return (
    <div className="flex min-h-screen">
      <Sidebar workspaceName={workspace.name} userEmail={user.email} />
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
