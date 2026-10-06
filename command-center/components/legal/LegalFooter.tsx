"use client";

import Link from "next/link";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { LEGAL } from "@/lib/legal";

/**
 * Pricing, Privacy and Terms links for every page a signed-out visitor can
 * reach — Google's verification checks that the homepage links to the Privacy
 * Policy, Paddle's that prices are one click away, and a sign-in page is where
 * a new user first hands over data.
 *
 * A client component because the login page is one. Operator details that are
 * not configured are simply left out here; the policy pages themselves show
 * the NOT CONFIGURED marker, which is where the owner will look.
 */
export function LegalFooter({ className = "" }: { className?: string }) {
  const { t } = usePublicI18n();
  return (
    <footer
      className={`relative z-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 px-4 py-6 text-sm font-light text-[var(--color-muted)] ${className}`}
    >
      {LEGAL.legalName && <span>© {LEGAL.legalName}</span>}
      <Link href="/pricing" className="inline-flex min-h-11 min-w-11 items-center justify-center underline-offset-4 transition-colors hover:text-[var(--color-primary)] hover:underline">
        {t.legal.pricing}
      </Link>
      <Link href="/privacy" className="inline-flex min-h-11 min-w-11 items-center justify-center underline-offset-4 transition-colors hover:text-[var(--color-primary)] hover:underline">
        {t.legal.privacy}
      </Link>
      <Link href="/terms" className="inline-flex min-h-11 min-w-11 items-center justify-center underline-offset-4 transition-colors hover:text-[var(--color-primary)] hover:underline">
        {t.legal.terms}
      </Link>
      {LEGAL.contactEmail && (
        <a
          href={`mailto:${LEGAL.contactEmail}`}
          className="inline-flex min-h-11 min-w-11 items-center justify-center underline-offset-4 transition-colors hover:text-[var(--color-primary)] hover:underline"
        >
          {LEGAL.contactEmail}
        </a>
      )}
    </footer>
  );
}
