import { ConvexError } from "convex/values";

type AuthContext = {
  auth: {
    getUserIdentity: () => Promise<unknown>;
  };
};

/**
 * Hackathon-friendly auth boundary:
 * - default (REQUIRE_AUTH unset): allow guest flows
 * - REQUIRE_AUTH=1: enforce authenticated caller
 */
export async function requireAuthIfConfigured(ctx: AuthContext): Promise<unknown> {
  const identity = await ctx.auth.getUserIdentity();
  if (process.env.REQUIRE_AUTH === "1" && !identity) {
    throw new ConvexError("Unauthorized");
  }
  return identity;
}
