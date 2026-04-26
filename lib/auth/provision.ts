/**
 * On first sign-in we ensure the user has a personal workspace.
 * Wired into the auth callback in Phase 0 day 3-4 once we have the
 * Cloudflare context binding helper plumbed.
 */

import { eq } from "drizzle-orm";
import { schema, type DrizzleDB } from "@/db";

export interface MinimalAuthKitUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

export async function ensureUserAndWorkspace(
  db: DrizzleDB,
  authUser: MinimalAuthKitUser,
) {
  const existing = await db.query.users.findFirst({
    where: eq(schema.users.workosUserId, authUser.id),
  });
  if (existing) return existing;

  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const fullName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ") || null;

  await db.batch([
    db.insert(schema.workspaces).values({
      id: workspaceId,
      name: fullName ? `${fullName}'s workspace` : `${authUser.email}'s workspace`,
      ownerId: userId,
      billingPlan: "free",
      retentionDays: 365,
    }),
    db.insert(schema.users).values({
      id: userId,
      workosUserId: authUser.id,
      email: authUser.email,
      name: fullName,
      avatarUrl: authUser.profilePictureUrl ?? null,
      defaultWorkspaceId: workspaceId,
    }),
    db.insert(schema.workspaceMembers).values({
      id: memberId,
      workspaceId,
      userId,
      role: "owner",
    }),
  ]);

  return db.query.users.findFirst({
    where: eq(schema.users.id, userId),
  });
}
