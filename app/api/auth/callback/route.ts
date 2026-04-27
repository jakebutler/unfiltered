import { handleAuth } from "@workos-inc/authkit-nextjs";

import { ensureUserAndWorkspace } from "@/lib/auth/provision";
import { getDatabase } from "@/lib/cloudflare";

/**
 * WorkOS AuthKit callback handler.
 *
 * After successful sign-in we upsert a `User` row in D1 and ensure the
 * user has a personal `Workspace`. Errors here are logged but don't
 * block sign-in — D1 may be temporarily unreachable, and we'd rather
 * let the user in and reconcile next time than 500 their first login.
 */
export const GET = handleAuth({
  returnPathname: "/studies",
  onSuccess: async ({ user }) => {
    try {
      const db = getDatabase();
      await ensureUserAndWorkspace(db, {
        id: user.id,
        email: user.email,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        profilePictureUrl: user.profilePictureUrl ?? null,
      });
    } catch (err) {
      console.error("ensureUserAndWorkspace failed", err);
    }
  },
});
