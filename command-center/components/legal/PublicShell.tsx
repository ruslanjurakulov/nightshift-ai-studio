import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { PublicMobileMenu } from "@/components/legal/PublicMobileMenu";

/** The public pages' navigation. Hash targets are absolute ("/#how") so they
 *  work from Pricing or Privacy as well as from the homepage itself. */
export function publicNavLinks(t: Dictionary): { href: string; label: string }[] {
  const n = t.landing.nav;
  return [
    { href: "/#product", label: n.product },
    { href: "/#how", label: n.how },
    { href: "/pricing", label: n.pricing },
  ];
}

/**
 * The frame shared by the pages a signed-out visitor can open — landing,
 * Pricing, Privacy, Terms. It deliberately uses none of the app shell (side nav,
 * channel switcher), which reads Supabase and would have nothing to show.
 *
 * The header sticks, and on a phone collapses its links into a menu while
 * keeping the primary "Start creating" button in view — the one action the
 * page exists to offer should never be behind a tap.
 *
 * The backdrop is the token-driven `atmos` wash and grid rather than the login
 * page's video, so the public pages stay light to load and follow the theme.
 */
export function PublicShell({ t, children }: { t: Dictionary; children: React.ReactNode }) {
  const links = publicNavLinks(t);
  return (
    <div className="atmos relative flex min-h-dvh flex-col">
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-70" aria-hidden />
      <header className="sticky top-0 z-40 border-b border-[color-mix(in_srgb,var(--color-border)_70%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_78%,transparent)] backdrop-blur-md">
        <div className="relative mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link
            href="/"
            className="font-display text-xl font-semibold tracking-[-0.02em] text-[var(--color-primary)]"
            style={{ textShadow: "0 0 28px var(--glow-primary)" }}
          >
            {t.brand.name}
          </Link>

          <nav aria-label={t.landing.nav.label} className="hidden items-center gap-1 lg:flex">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="nav-link text-[14px]">
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 lg:flex">
              <LanguageSelector />
              <ThemeToggle />
              <Link href="/login" className="btn-sky ghost pill min-h-10 px-4 text-sm">
                {t.auth.signIn}
              </Link>
            </div>
            <Link href="/signup" className="btn-sky is-solid pill min-h-11 px-4 text-sm sm:px-5">
              {t.landing.nav.start}
            </Link>
            <PublicMobileMenu links={links} signInLabel={t.auth.signIn} />
          </div>
        </div>
      </header>
      <div className="relative z-10 flex-1">{children}</div>
      <PublicFooter t={t} />
    </div>
  );
}
