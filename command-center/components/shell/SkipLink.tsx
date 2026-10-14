"use client";

import { useI18n } from "@/lib/i18n/context";

/**
 * "Skip to content" for the signed-in app: the first stop in the tab order, so a
 * keyboard user does not tab through the sidebar, the top bar and the tab bar
 * (about 25 stops) before the first control of the page. Hidden until it has
 * focus; the public pages draw the same link (`.st-skip`, site.css, same
 * string) and this is its twin for the app, which does not load that sheet.
 * It points at <main id="main" tabIndex={-1}> in app/(app)/layout.tsx.
 */
export function SkipLink() {
  const { t } = useI18n();
  return (
    <a href="#main" className="app-skip">
      {t.landing.nav.skip}
    </a>
  );
}
