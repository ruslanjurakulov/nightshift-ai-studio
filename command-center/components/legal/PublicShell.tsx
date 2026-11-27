import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ViewModeToggle } from "@/components/view-mode/ViewModeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { PublicMenu } from "@/components/legal/PublicMenu";
import { MegaMenu, MegaNav, MegaPanels } from "@/components/legal/PublicMegaMenu";
import { SessionSwap } from "@/components/legal/SessionSwap";
import { APP_HOME } from "@/lib/session-hint";
import { Wordmark } from "@/components/site/Wordmark";
import { preloadSiteFonts } from "@/components/site/fonts";
import { SiteEffects } from "@/components/site/SiteEffects";
import { PageViewBeacon } from "@/components/site/PageViewBeacon";
import { SiteMotion } from "@/components/site/motion/SiteMotion";
import { DEFAULT_LOCALE, LOCALES, dictionaries } from "@/lib/i18n";
import { devPagesEnabled } from "@/lib/dev-pages";
import { menuHref, publicNav, type PublicSection } from "@/lib/public-nav";
import "@/components/site/site.css";
import "@/components/site/site-next.css";
import "@/components/site/site-motion.css";

export type { PublicSection };

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
 *
 * The bar's Studio, Solutions, Developers and Resources are panel triggers (components/legal/PublicMegaMenu.tsx); Pricing
 * stays a plain link. The panels and the sheet's sections are drawn from one list (lib/public-nav.ts), so the phone and the
 * desktop can never offer different pages.
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
  // One navigation source for the bar's panels and the phone's sheet (lib/public-nav.ts). CLI and Skills follow their
  // flag, read per request like the footer's.
  const entries = publicNav(t, { devPages: devPagesEnabled() });
  // The page's language is the dictionary it was handed (server-side lookup, no request read).
  preloadSiteFonts(LOCALES.find((l) => dictionaries[l.code] === t)?.code ?? DEFAULT_LOCALE);
  return (
    <div className={`st${fresh ? " nx" : ""} relative flex min-h-dvh flex-col`}>
      <a href="#main" className="st-skip">
        {t.landing.nav.skip}
      </a>
      <MegaMenu entries={entries} current={current}>
        <header className="st-header">
          <div className="st-wrap st-header-row relative">
            <Link href={menuHref("/")} className="st-brand" aria-label={t.brand.name}>
              <Wordmark />
            </Link>

            {/* The links, language, theme and Sign in: on the bar's row from 1024px, a row of their own under the wordmark and
              Start free from 768px, and in the menu's sheet below that. */}
            <div className="st-header-sub">
              <MegaNav label={t.landing.nav.label} />

              <div className="st-header-desk">
                <LanguageSelector />
                <ThemeToggle />
                {/* The bar is full in every language (the page column stops growing at 1280px), so the view switch is the icon
                  only, and only from 1280px, where it measurably fits; the word is on the footer link. */}
                <span className="hidden min-[1280px]:contents">
                  <ViewModeToggle />
                </span>
                {/* Signed in: no Sign in here; the one key beside the menu opens the app instead (SessionSwap). */}
                <SessionSwap
                  signedOut={
                    <Link href={menuHref("/login")} className="st-signin">
                      {t.site.nav.signIn}
                    </Link>
                  }
                  signedIn={null}
                />
              </div>
            </div>

            <div className="st-header-tools">
              <SessionSwap
                signedOut={
                  <Link href={menuHref("/signup")} className="st-key" data-size="sm">
                    {t.site.nav.start}
                  </Link>
                }
                // A plain link, not next/link: no prefetch of an app route from a public page, and the app opens as a full load.
                signedIn={
                  <a href={APP_HOME} className="st-key" data-size="sm" data-testid="public-open-app">
                    {t.site.nav.openApp}
                  </a>
                }
              />
              <PublicMenu
                entries={entries}
                current={current}
                label={t.site.nav.menu}
                closeLabel={t.site.nav.menuClose}
                signIn={t.site.nav.signIn}
                start={t.site.nav.start}
                openApp={t.site.nav.openApp}
              >
                <LanguageSelector />
                <ThemeToggle />
              </PublicMenu>
            </div>
            {/* Without JavaScript the menu button cannot open its sheet: the wrapped rows come back instead. The row must wrap
              again too: the phone bar is nowrap, and a .st-header-sub of flex 1 0 100% on the same line squeezed the
              wordmark to 0 and pushed the row past a 390px screen. */}
            <noscript>
              <style>{`@media (max-width:767px){.st-header-row{flex-wrap:wrap!important}.st-header-sub{display:flex!important}.st-menu-btn{display:none!important}}.st-mm-trigger{display:none!important}.st-mm-nojs{display:inline-flex!important}`}</style>
            </noscript>
          </div>
          {/* The panels' frame: under the whole bar, over the page (it moves nothing), in the header so it shares its stacking. */}
          <MegaPanels />
        </header>
      </MegaMenu>
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
