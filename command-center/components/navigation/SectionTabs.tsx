"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { tabsFor } from "@/lib/navigation";

/**
 * Bring the current tab into view inside the strip, sideways only. It does not
 * use scrollIntoView, which would also scroll the page when the strip is off
 * screen; the strip's own scrollLeft is all that moves. Smooth, unless the
 * person asked for reduced motion or the page has only just mounted.
 */
export function revealCurrentTab(nav: HTMLElement, smooth: boolean, target?: HTMLElement | null) {
  const tab = target ?? nav.querySelector<HTMLElement>('[aria-current="page"]');
  if (!tab) return;
  const n = nav.getBoundingClientRect();
  const r = tab.getBoundingClientRect();
  const pad = 8;
  let delta = 0;
  if (r.left < n.left + pad) delta = r.left - n.left - pad;
  else if (r.right > n.right - pad) delta = r.right - n.right + pad;
  if (!delta) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const left = nav.scrollLeft + delta;
  if (typeof nav.scrollTo === "function") nav.scrollTo({ left, behavior: smooth && !reduce ? "smooth" : "auto" });
  else nav.scrollLeft = left;
}

/**
 * The screens behind one rail entry (Studio), as tabs under the
 * panel's bar. Nothing renders for a section that has no group.
 */
export function SectionTabs() {
  const { t } = useI18n();
  const pathname = usePathname();
  const path = useChannelPath();
  const section = pathname.split("/")[2] ?? "";
  const group = tabsFor(section);
  const nav = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  // On a narrow screen the strip scrolls sideways: show the tab you are on, on arrival and on every route change.
  useEffect(() => {
    if (nav.current) revealCurrentTab(nav.current, mounted.current);
    mounted.current = true;
  }, [pathname]);
  // One entry is a page, not a tab bar (Settings).
  if (!group || group.items.length < 2) return null;
  return (
    <nav
      ref={nav}
      // A tab reached by keyboard is shown whole too (the browser leaves a half-hidden one half-hidden).
      onFocus={(e) => {
        if (nav.current && e.target instanceof HTMLElement) revealCurrentTab(nav.current, false, e.target);
      }}
      aria-label={t.nav.sections}
      className="ns-tabs mb-6 overflow-x-auto"
    >
      {/* Underlined tabs, as the public Studio card draws them: the current screen carries the amber line. */}
      <ul className="flex w-max gap-1">
        {group.items.map(({ href, key }) => {
          const active = "/" + section === href;
          return (
            <li key={key}>
              <Link href={path(href)} aria-current={active ? "page" : undefined} className="ns-tabs-link">
                {t.nav[key]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
