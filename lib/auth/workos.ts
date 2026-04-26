/**
 * WorkOS AuthKit integration entry points used from Server Components,
 * Server Actions, and Route Handlers.
 *
 * AuthKit is configured via env vars:
 *   WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI, WORKOS_COOKIE_PASSWORD
 *
 * Sign-in / sign-up uses the AuthKit hosted UI; on callback we upsert
 * a `User` row in D1 and ensure a personal `Workspace` exists.
 */

import {
  withAuth,
  signOut as workosSignOut,
} from "@workos-inc/authkit-nextjs";

export type { User } from "@workos-inc/node";

/**
 * Returns the current authenticated user (or null).
 * Use in Server Components.
 */
export async function currentUser() {
  const auth = await withAuth();
  return auth.user ?? null;
}

/**
 * Same as currentUser but throws/redirects when not signed in.
 * Use in Server Components that require auth.
 */
export async function requireUser() {
  const auth = await withAuth({ ensureSignedIn: true });
  return auth.user;
}

export const signOut = workosSignOut;
