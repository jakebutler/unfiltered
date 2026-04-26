import { handleAuth } from "@workos-inc/authkit-nextjs";

/**
 * WorkOS AuthKit callback handler.
 *
 * After successful sign-in we upsert a `User` row in D1 and ensure the
 * user has a personal `Workspace`. This wires up in Phase 0 day 3-4
 * once the D1 binding helper is reachable from a Next.js Route Handler
 * (via `getCloudflareContext()` from `@opennextjs/cloudflare`).
 */
export const GET = handleAuth({
  returnPathname: "/studies",
  // onSuccess: async ({ user, accessToken, refreshToken }) => {
  //   const { env } = getCloudflareContext();
  //   const db = getDb(env.DB);
  //   await ensureUserAndWorkspace(db, user);
  // },
});
