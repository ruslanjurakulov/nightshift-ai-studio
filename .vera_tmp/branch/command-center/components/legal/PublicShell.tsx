import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ViewModeToggle } from "@/components/view-mode/ViewModeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { PublicMenu } from "@/components/legal/PublicMenu";
import { Wordmark } from "@/components/site/Wordmark";
import { preloadSiteFonts } from "@/components/site/fonts";
import { SiteEffects } from "@/components/site/SiteEffects";
import { PageViewBeacon } from "@/components/site/PageViewBeacon";
import { SiteMotion } from "@/components/site/motion/SiteMotion";
import { DEFAULT_LOCALE, LOCALES, dictionaries } from "@/lib/i18n";
import { devFor } from "@/lib/i18n/dev";
import "@/components/site/site.css";
import "@/components/site/site-next.css";
import "@/components/site/site-motion.css";

/** Which top-level page the visitor is on, for the nav's lit item. */
export type PublicSection = "home" | "studio" | "solutions" | "pricing" | "docs" | "legal" | null;

/** The public pages' navigation. Hash targets are absolute ("/#how") so they
 *  work from Pricing or Privacy as well as from the homepage itself. One
 *  "Developers" entry stands for the API, MCP, CLI and Skills pages: they are
 *  one click apart on every one of them (components/docs/doc-parts.tsx DevNav)
 *  and in the footer, and a fifth link here would crowd a phone's bar. */
export function publicNavLinks(t: Dictionary): { href: string; label: string; section: PublicSection }[] {
  const n = t.site.nav;
  return [
    { href: "/#how", label: n.how, section: null },
    { href: "/studio", label: n.studio, section: "studio" },
    { href: "/solutions", label: n.solutions, section: "solutions" },
    { href: "/pricing", label: n.pricing, section: "pricing" },
    { href: "/docs/api", label: devFor(t).nav.label, section: "docs" },
  ];
}

/**
 * The frame shared by the pages a signed-out visitor can open — landing,
 * Solutions, Pricing, the API reference, Privacy, Terms and the 404. It uses
 * none of the app shell (side nav, channel switcher), which reads Supabase and
 * would have nothing to show.
 *
 * The header is a solid rack face (no glass, IDENTITY.md §Elevation). From
 * 1024px it is one sticky row; from 768 to 1023px the wordmark and Start free
 * are the first row and the links, language, theme and Sign in a second one,
 * all visible. Below 768px those rows took about 209px of a 390px phone, so
 * there the bar is one 64px row (wordmark, Start free, a menu button) and the
 * rest opens in a sheet (components/legal/PublicMenu.tsx).
 */
export function PublicShell({
  t,
  current = null,
  fresh = false,
  children,
}: {
  t: Dictionary;
  current?: PublicSection;
  /** The marketing pages' calmer frame (components/site/site-next.css): bigger type, more air, a stage for the product. */
  fresh?: boolean;
  children: React.ReactNode;
}) {
  const links = publicNavLinks(t);
  // The page's language is the dictionary it was handed (server-side lookup, no request read).
  preloadSiteFonts(LOCALES.find((l) => dictionaries[l.code] === t)?.code ?? DEFAULT_LOCALE);
  return (
    <div className={`st${fresh ? " nx" : ""} relative flex min-h-dvh flex-col`}>
      <a href="#main" className="st-skip">
        {t.landing.nav.skip}
      </a>
      <header className="st-header">
        <div className="st-wrap st-header-row relative">
          <Link href="/" className="st-brand" aria-label={t.brand.name}>
            <Wordmark />
          </Link>

          {/* The links, language, theme and Sign in: on the bar's row from 1024px, a row of their own under the wordmark and
              Start free from 768px, and in the menu's sheet below that. */}
          <div className="st-header-sub">
            <nav aria-label={t.landing.nav.label} className="st-nav">
              {links.map((l) => (
                <Link key={l.href} href={l.href} aria-current={l.section && l.section === current ? "page" : undefined}>
                  {l.label}
                </Link>
              ))}
            </nav>

            <div className="st-header-desk">
              <LanguageSelector />
              <ThemeToggle />
              {/* The bar is full in every language (the page column stops growing at 1280px), so the view switch is the icon
                  only, and only from 1280px, where it measurably fits; the word is on the footer link. */}
              <span className="hidden min-[1280px]:contents">
                <ViewModeToggle />
              </span>
              <Link href="/login" className="st-signin">
                {t.site.nav.signIn}
              </Link>
            </div>
          </div>

          <div className="st-header-tools">
            <Link href="/signup" className="st-key" data-size="sm">
              {t.site.nav.start}
            </Link>
            <PublicMenu
              links={links.map((l) => ({ href: l.href, label: l.label, current: Boolean(l.section && l.section === current) }))}
              label={t.site.nav.menu}
              closeLabel={t.site.nav.menuClose}
              signIn={t.site.nav.signIn}
            >
              <LanguageSelector />
              <ThemeToggle />
            </PublicMenu>
          </div>
          {/* Without JavaScript the menu button cannot open its sheet: the wrapped rows come back instead. The row must wrap
              again too: the phone bar is nowrap, and a .st-header-sub of flex 1 0 100% on the same line squeezed the
              wordmark to 0 and pushed the row past a 390px screen. */}
          <noscript>
            <style>{`@media (max-width:767px){.st-header-row{flex-wrap:wrap!important}.st-header-sub{display:flex!important}.st-menu-btn{display:none!important}}`}</style>
          </noscript>
        </div>
      </header>
      {/* The one main landmark of every public page; the pages render sections inside it. */}
      <main id="main" tabIndex={-1} className="relative flex-1 focus:outline-none">
        {children}
      </main>
      <PublicFooter t={t} />
      <SiteEffects />
      <SiteMotion />
      <PageViewBeacon />
    </div>
  );
}
