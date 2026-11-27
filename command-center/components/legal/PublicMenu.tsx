"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Menu, X } from "lucide-react";
import { useSessionHint } from "@/components/legal/SessionSwap";
import { APP_HOME } from "@/lib/session-hint";
import { isCurrentPage, menuHref } from "@/lib/public-menu-href";
import type { NavEntry, NavGroupId, PublicSection } from "@/lib/public-nav";

/** Phones only: the width below which the bar is the wordmark, Start free and this button (site.css .st-menu-btn). */
const PHONE = "(max-width: 767px)";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The public pages' menu on a phone. Below 768px the links, language, theme and Sign in wrapped into two or three rows
 * under the wordmark (the bar was about 209px tall at 390px, a quarter of the screen before any content); there the
 * bar is the wordmark, Start free and this button, and the rest opens in a sheet. From 768px the button is not drawn
 * and the bar is unchanged.
 *
 * A modal dialog: the button says whether it is open (aria-expanded), focus moves into the sheet and stays there
 * (Tab and Shift+Tab wrap), Escape or the close button closes it and focus returns to the button. Following a link,
 * a route change or widening past the phone breakpoint closes it too. Without JavaScript the button cannot open
 * anything, so a <noscript> rule shows the old wrapped rows instead (nothing is out of reach).
 *
 * The destinations are the desktop panels' own (lib/public-nav.ts), as collapsible sections: a button per group says
 * whether it is open (aria-expanded) and its chevron turns; the group holding the current page starts open. The primary
 * key (Start free, or Open app when signed in) is pinned to the sheet's foot, so it is in reach however long the list is.
 */
export function PublicMenu({
  entries,
  current,
  label,
  closeLabel,
  signIn,
  start,
  openApp,
  children,
}: {
  entries: NavEntry[];
  current: PublicSection;
  /** The button's and the dialog's name ("Menu"). */
  label: string;
  closeLabel: string;
  signIn: string;
  start: string;
  openApp: string;
  /** Language and theme, drawn by the shell (the same controls as the bar's). */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const signedIn = useSessionHint();
  const uid = useId();
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const holding = useCallback(
    () => new Set(entries.flatMap((e) => (e.kind === "group" && e.section && e.section === current ? [e.id] : []))),
    [entries, current],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<NavGroupId>>(holding);
  // A client-side move to another section's page keeps this component mounted: the open section follows the new page.
  useEffect(() => {
    setExpanded(holding());
  }, [holding]);
  const toggleSection = (id: NavGroupId) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }, []);

  // A route change (a link in the sheet, or the back button) leaves no sheet open over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    const first = sheet.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const wide = window.matchMedia(PHONE);
    const onWide = () => {
      if (!wide.matches) close(false);
    };
    wide.addEventListener("change", onWide);

    // On the document, not the sheet: picking a language unmounts its list with focus on the option, focus falls to
    // <body>, and a handler on the sheet then heard neither Escape (the sheet stayed open) nor Tab (it walked into the
    // page behind the scrim).
    const items = () =>
      // A collapsed section's links are in the page but hidden; everything else is shown while the sheet is open (the
      // language list is only in the page while it is open). The filter is the hidden attribute, not layout: one based on
      // layout (offsetParent) would find nothing where there is no layout.
      sheet.current ? Array.from(sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[hidden]")) : [];
    const inside = (n: EventTarget | null) => n instanceof Node && Boolean(sheet.current?.contains(n));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The language list closes itself on Escape first; only a second Escape closes the sheet.
        if (sheet.current?.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) return;
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== "Tab") return;
      const all = items();
      if (all.length === 0) return;
      const firstEl = all[0];
      const lastEl = all[all.length - 1];
      const active = document.activeElement;
      if (!inside(active)) {
        e.preventDefault();
        (e.shiftKey ? lastEl : firstEl).focus();
      } else if (e.shiftKey && active === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    // Anything else that lands focus behind the sheet (a script, an assistive technology's cursor) is brought back. The
    // menu button is exempt: closing returns focus to it before this listener is removed.
    const onFocusIn = (e: FocusEvent) => {
      if (inside(e.target) || e.target === button.current) return;
      items()[0]?.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      root.style.overflow = before;
      wide.removeEventListener("change", onWide);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, close]);

  const sheetId = `${uid}-menu`;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="st-menu-btn"
        aria-expanded={open}
        aria-controls={sheetId}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        <Menu aria-hidden />
      </button>
      <div className="st-menu-root" data-open={open} hidden={!open}>
        <div className="st-menu-scrim" aria-hidden onClick={() => close(true)} />
        <div ref={sheet} id={sheetId} role="dialog" aria-modal="true" aria-label={label} className="st-menu-sheet">
          <div className="st-menu-head">
            <button type="button" className="st-menu-close" aria-label={closeLabel} onClick={() => close(true)}>
              <X aria-hidden />
            </button>
          </div>
          <nav aria-label={label} className="st-menu-nav">
            {entries.map((e) => {
              if (e.kind === "link") {
                return (
                  <Link
                    key={e.href}
                    href={menuHref(e.href)}
                    aria-current={e.section && e.section === current ? "page" : undefined}
                    onClick={() => close(false)}
                  >
                    {e.label}
                  </Link>
                );
              }
              const secOpen = expanded.has(e.id);
              const secId = `${uid}-sec-${e.id}`;
              return (
                <div key={e.id} className="st-menu-sec">
                  <button
                    type="button"
                    className="st-menu-sec-btn"
                    aria-expanded={secOpen}
                    aria-controls={secId}
                    data-current={e.section && e.section === current ? "true" : undefined}
                    onClick={() => toggleSection(e.id)}
                  >
                    {e.label}
                    <ChevronDown aria-hidden className="st-menu-chev" />
                  </button>
                  <div id={secId} className="st-menu-sec-body" hidden={!secOpen}>
                    {e.columns.map((c) => (
                      <div key={c.id} className="st-menu-col">
                        {c.href ? (
                          <Link
                            href={menuHref(c.href)}
                            className="st-menu-col-title"
                            aria-current={isCurrentPage(c.href, pathname) ? "page" : undefined}
                            onClick={() => close(false)}
                          >
                            {c.title}
                          </Link>
                        ) : (
                          // The group's button already names a one-column group with the same title: a second heading is noise.
                          c.title !== e.label && <p className="st-menu-col-title">{c.title}</p>
                        )}
                        <ul>
                          {c.links.map((l) => (
                            <li key={l.href}>
                              <Link
                                href={menuHref(l.href)}
                                aria-current={isCurrentPage(l.href, pathname) ? "page" : undefined}
                                onClick={() => close(false)}
                              >
                                {l.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </nav>
          <div className="st-menu-tools">{children}</div>
          {/* Pinned to the sheet's foot. Signed in, the key opens the app and there is nothing to sign in to
              (components/legal/SessionSwap); the app opens as a full load (a plain link), never a prefetched app route. */}
          <div className="st-menu-foot">
            {!signedIn && (
              <Link href={menuHref("/login")} className="st-menu-signin" onClick={() => close(false)}>
                {signIn}
              </Link>
            )}
            {signedIn ? (
              <a href={APP_HOME} className="st-key" data-sheet-key="" data-block="true" onClick={() => close(false)}>
                {openApp}
              </a>
            ) : (
              <Link href={menuHref("/signup")} className="st-key" data-sheet-key="" data-block="true" onClick={() => close(false)}>
                {start}
              </Link>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
