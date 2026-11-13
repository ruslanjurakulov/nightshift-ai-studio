"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

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
 */
export function PublicMenu({
  links,
  label,
  closeLabel,
  signIn,
  children,
}: {
  links: { href: string; label: string; current: boolean }[];
  /** The button's and the dialog's name ("Menu"). */
  label: string;
  closeLabel: string;
  signIn: string;
  /** Language and theme, drawn by the shell (the same controls as the bar's). */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

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
    return () => {
      root.style.overflow = before;
      wide.removeEventListener("change", onWide);
    };
  }, [open, close]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      // The language list closes itself on Escape first; only a second Escape closes the sheet.
      if (sheet.current?.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) return;
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== "Tab" || !sheet.current) return;
    // Everything in the sheet is shown while it is open (the language list is only in the page while it is open), so no
    // visibility filter: one based on layout (offsetParent) would find nothing where there is no layout.
    const items = Array.from(sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === firstEl || !sheet.current.contains(document.activeElement))) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  }

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
        <div ref={sheet} id={sheetId} role="dialog" aria-modal="true" aria-label={label} className="st-menu-sheet" onKeyDown={onKeyDown}>
          <div className="st-menu-head">
            <button type="button" className="st-menu-close" aria-label={closeLabel} onClick={() => close(true)}>
              <X aria-hidden />
            </button>
          </div>
          <nav aria-label={label} className="st-menu-nav">
            {links.map((l) => (
              <Link key={l.href} href={l.href} aria-current={l.current ? "page" : undefined} onClick={() => close(false)}>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="st-menu-tools">{children}</div>
          {/* Not a key: the bar's one key is Start free, which stays beside the button. */}
          <Link href="/login" className="st-menu-signin" onClick={() => close(false)}>
            {signIn}
          </Link>
        </div>
      </div>
    </>
  );
}
