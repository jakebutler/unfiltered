import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

const redirectUri = process.env.WORKOS_REDIRECT_URI;

export default authkitMiddleware({
  redirectUri,
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [
      "/",
      "/pricing",
      "/login",
      "/signup",
      "/join/:invitationId*",
      "/interview/:sessionId*",
      "/share/finding/:slug*",
      "/p/:participantId/delete",
      "/api/health",
      "/api/auth/:path*",
      "/api/webhooks/:path*",
    ],
  },
});

export const config = {
  matcher: [
    // Run middleware on all routes except Next.js internals and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
