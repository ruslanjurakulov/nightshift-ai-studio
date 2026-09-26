import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { LegalFooter } from "@/components/legal/LegalFooter";

/**
 * The frame shared by the pages a signed-out visitor can open — landing,
 * Privacy, Terms. It deliberately uses none of the app shell (side nav,
 * channel switcher), which reads Supabase and would have nothing to show.
 *
 * The backdrop is the token-driven `atmos` wash and grid rather than the login
 * page's video, so the public pages stay light to load and follow the theme.
 */
export function PublicShell({ t, children }: { t: Dictionary; children: React.ReactNode }) {
  return (
    <div className="atmos relative flex min-h-dvh flex-col">
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-70" aria-hidden />
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link
          href="/"
          className="font-display text-xl font-semibold tracking-[-0.02em] text-[var(--color-primary)]"
          style={{ textShadow: "0 0 28px var(--glow-primary)" }}
        >
          {t.brand.name}
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSelector />
          <ThemeToggle />
          <Link href="/login" className="btn-sky is-solid pill px-4 py-2 text-sm">
            {t.auth.signIn}
          </Link>
        </div>
      </header>
      <div className="relative z-10 flex-1">{children}</div>
      <LegalFooter className="border-t border-[var(--color-border)]" />
    </div>
  );
}
