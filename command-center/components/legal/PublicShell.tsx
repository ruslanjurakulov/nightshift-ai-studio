import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { PublicMobileMenu } from "@/components/legal/PublicMobileMenu";
import { BrandMark } from "@/components/site/BrandMark";
import "@/components/site/site.css";

/** Which top-level page the visitor is on, for the nav's lit item. */
export type PublicSection = "home" | "solutions" | "pricing" | "docs" | "legal" | null;

/** The public pages' navigation. Hash targets are absolute ("/#how") so they
 *  work from Pricing or Privacy as well as from the homepage itself. */
export function publicNavLinks(t: Dictionary): { href: string; label: string; section: PublicSection }[] {
  const n = t.site.nav;
  return [
    { href: "/#how", label: n.how, section: null },
    { href: "/#studio", label: n.studio, section: null },
    { href: "/solutions", label: n.solutions, section: "solutions" },
    { href: "/pricing", label: n.pricing, section: "pricing" },
    { href: "/docs/api", label: n.api, section: "docs" },
  ];
}

/**
 * The frame shared by the pages a signed-out visitor can open — landing,
 * Solutions, Pricing, the API reference, Privacy, Terms and the 404. It uses
 * none of the app shell (side nav, channel switcher), which reads Supabase and
 * would have nothing to show.
 *
 * The header is a solid rack face (no glass, IDENTITY.md §Elevation) that
 * sticks; on a phone the links fold into a menu while Start free stays in the
 * bar — the one action the pages exist to offer is never behind a tap.
 */
export function PublicShell({
  t,
  current = null,
  children,
}: {
  t: Dictionary;
  current?: PublicSection;
  children: React.ReactNode;
}) {
  const links = publicNavLinks(t);
  return (
    <div className="st relative flex min-h-dvh flex-col">
      <a href="#main" className="st-skip">
        {t.landing.nav.skip}
      </a>
      <header className="st-header">
        <div className="st-wrap st-header-row relative">
          <Link href="/" className="st-brand">
            <BrandMark />
            {t.brand.name}
          </Link>

          <nav aria-label={t.landing.nav.label} className="st-nav">
            {links.map((l) => (
              <Link key={l.href} href={l.href} aria-current={l.section && l.section === current ? "page" : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="st-header-tools">
            <div className="st-header-desk">
              <LanguageSelector />
              <ThemeToggle />
              <Link href="/login" className="st-signin">
                {t.site.nav.signIn}
              </Link>
            </div>
            <Link href="/signup" className="st-key" data-size="sm">
              {t.site.nav.start}
            </Link>
            <PublicMobileMenu
              links={links.map((l) => ({ href: l.href, label: l.label, current: Boolean(l.section && l.section === current) }))}
              signInLabel={t.site.nav.signIn}
            />
          </div>
        </div>
      </header>
      {/* The one main landmark of every public page; the pages render sections inside it. */}
      <main id="main" tabIndex={-1} className="relative flex-1 focus:outline-none">
        {children}
      </main>
      <PublicFooter t={t} />
    </div>
  );
}
