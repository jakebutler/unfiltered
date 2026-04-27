/**
 * Cloudflare Email Service helpers.
 *
 * Sends transactional emails via the `EMAIL` binding declared in
 * wrangler.toml under `[[send_email]]`. No API keys; the binding is
 * authenticated via your Cloudflare account.
 *
 * Requirements:
 *   - Workers Paid plan
 *   - A sending domain verified in Cloudflare → Email Service
 *   - `EMAIL_FROM_ADDRESS` set to an address on that domain
 *
 * Used in:
 *   - Phase 2: participant invitations
 *   - Phase 2: GDPR deletion confirmations
 *   - Phase 3: cross-session findings ready notifications (optional)
 */

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Override the default from-address. Must be on a verified domain. */
  from?: string;
}

export interface EmailContext {
  binding: SendEmail;
  defaultFrom: string;
}

export async function sendEmail(
  ctx: EmailContext,
  input: SendEmailInput,
): Promise<void> {
  const from = input.from ?? ctx.defaultFrom;
  if (!from) {
    throw new Error(
      "Email send aborted: no from-address. Set EMAIL_FROM_ADDRESS or pass `from`.",
    );
  }
  await ctx.binding.send({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text ?? stripHtml(input.html),
    replyTo: input.replyTo,
  });
}

/** Naive HTML → plain-text fallback so we always send a multipart message. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
