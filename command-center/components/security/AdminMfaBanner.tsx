import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { mfaVerifyUrl, type MfaAction } from "@/lib/security/admin-mfa";

/**
 * The notice an operator sees while the second-factor gate is not blocking
 * them (docs/security/ADMIN_MFA.md): either their session is still
 * password-only although they have an authenticator (finish the code), or they
 * have no authenticator at all (enrol one at /security). Server-rendered, one
 * line plus one key; the key is a full-height touch target on a phone.
 *
 * `enrol_only` (strict `enforce`, no authenticator) shows the enrol notice too: it is where every other page
 * sends that admin.
 *
 * Draws nothing for any other action, so the layout can pass the gate's answer
 * straight in.
 */
export function AdminMfaBanner({ action, t, path }: { action: MfaAction; t: Dictionary["mfa"]; path?: string | null }) {
  if (action !== "warn_complete" && action !== "warn_enrol" && action !== "enrol_only") return null;
  const complete = action === "warn_complete";
  return (
    <div
      role="status"
      data-testid="admin-mfa-banner"
      data-action={action}
      className="relative z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--ns-rule)] px-4 py-2 text-sm sm:px-6"
    >
      <span aria-hidden className="ns-lamp" data-tone="warn" />
      <p className="min-w-0 flex-1 basis-64">{complete ? t.bannerComplete : t.bannerEnrol}</p>
      <Link
        href={complete ? mfaVerifyUrl(path) : "/security"}
        className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm font-medium"
      >
        {complete ? t.bannerCompleteAction : t.bannerEnrolAction}
      </Link>
    </div>
  );
}
