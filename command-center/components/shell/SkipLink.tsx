"use client";

import type { MouseEvent } from "react";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";

/**
 * "Skip to content" for the signed-in app: the first stop in the tab order, so a
 * keyboard user does not tab through the sidebar, the top bar and the tab bar
 * (about 25 stops) before the first control of the page. Hidden until it has
 * focus; the public pages draw the same link (`.st-skip`, site.css, same
 * string) and this is its twin for the app, which does not load that sheet.
 * It points at <main id="main" tabIndex={-1}> in app/(app)/layout.tsx.
 *
 * On /create a second one goes straight to the prompt: past the desk bar, the
 * kind chips and the tool tabs, which on a desk are another dozen stops.
 */
export function SkipLink() {
  const { t } = useI18n();
  const pathname = usePathname() ?? "";
  return (
    <>
      <a href="#main" className="app-skip">
        {t.landing.nav.skip}
      </a>
      {isCreatePath(pathname) && (
        <a href="#prompt" className="app-skip" onClick={focusPrompt} data-testid="skip-to-prompt">
          {t.availability.skipToPrompt}
        </a>
      )}
    </>
  );
}

/** `/<channel>/create`, with or without a desk in the query. */
export function isCreatePath(pathname: string): boolean {
  return pathname.split("/").filter(Boolean)[1] === "create";
}

/**
 * Focus the first field of the composer (every /create layout marks its composer `id="prompt"`), not the box around it, so typing
 * can start at once. Without one (no organization, a desk that has no form) the page itself takes focus: never a skip to nowhere.
 */
function focusPrompt(e: MouseEvent<HTMLAnchorElement>) {
  const box = document.getElementById("prompt");
  const field = box?.querySelector<HTMLElement>("textarea:not([disabled]), input:not([type=hidden]):not([disabled])") ?? null;
  const target = field ?? document.getElementById("main");
  if (!target) return;
  e.preventDefault();
  target.focus();
  target.scrollIntoView?.({ block: "center" });
}
