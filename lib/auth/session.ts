/**
 * Server-side session helpers that resolve the current WorkOS user
 * to their D1-backed workspace + membership row.
 *
 * Use from Server Components, Server Actions, and Route Handlers.
 *
 *   const { user, workspace, member } = await requireSession();
 *
 * On a fresh sign-in the auth callback (`app/api/auth/callback/route.ts`)
 * upserts the row via `ensureUserAndWorkspace`. As a safety net we
 * upsert on read here too — covers the rare case where the callback
 * path failed but the WorkOS cookie is still valid.
 */

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { schema } from "@/db";
import { getDatabase } from "@/lib/cloudflare";
import { ensureUserAndWorkspace } from "./provision";
import { currentUser } from "./workos";

export interface AppSession {
  user: typeof schema.users.$inferSelect;
  workspace: typeof schema.workspaces.$inferSelect;
  member: typeof schema.workspaceMembers.$inferSelect;
  workosUser: NonNullable<Awaited<ReturnType<typeof currentUser>>>;
}

/**
 * Returns the current session or null when signed out / D1 unreachable.
 */
export async function currentSession(): Promise<AppSession | null> {
  const workosUser = await currentUser();
  if (!workosUser) return null;

  const db = getDatabase();

  let userRow = await db.query.users.findFirst({
    where: eq(schema.users.workosUserId, workosUser.id),
  });

  // Reconcile if the callback didn't run (shouldn't happen, but safe).
  if (!userRow) {
    await ensureUserAndWorkspace(db, {
      id: workosUser.id,
      email: workosUser.email,
      firstName: workosUser.firstName ?? null,
      lastName: workosUser.lastName ?? null,
      profilePictureUrl: workosUser.profilePictureUrl ?? null,
    });
    userRow = await db.query.users.findFirst({
      where: eq(schema.users.workosUserId, workosUser.id),
    });
    if (!userRow) return null;
  }

  if (!userRow.defaultWorkspaceId) return null;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, userRow.defaultWorkspaceId),
  });
  if (!workspace) return null;

  const member = await db.query.workspaceMembers.findFirst({
    where: eq(schema.workspaceMembers.userId, userRow.id),
  });
  if (!member) return null;

  return { user: userRow, workspace, member, workosUser };
}

/**
 * Same as currentSession but redirects to sign-in when missing.
 * Use in Server Components inside the (app) route group.
 */
export async function requireSession(): Promise<AppSession> {
  const session = await currentSession();
  if (!session) redirect("/");
  return session;
}
