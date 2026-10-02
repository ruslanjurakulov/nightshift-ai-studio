"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";

/**
 * The public header's menu below the desktop breakpoint: the section links,
 * Sign in, and the theme and language controls that do not fit a phone's bar.
 * The sign-up key stays outside it, in the bar. While open, focus moves into
 * the panel and Tab cycles between it and the menu button, the page behind is
 * inert and dimmed; it closes on a link, on Escape (handing focus back to its
 * button) and on a tap outside.
 */
export function PublicMobileMenu({
  links,
  signInLabel,
}: {
  links: { href: string; label: string; current?: boolean }[];
  signInLabel: string;
}) {
  const { t } = usePublicI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const panel = panelRef.current;
    // While the panel is open the page behind it is inert: no Tab stop, no
    // click, no screen-reader cursor reaches it. Everything in the public
    // frame except the header (which holds the panel) is switched off.
    const frame = root?.closest(".st");
    const header = root?.closest("header");
    const silenced = frame
      ? [...frame.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== header && !el.inert)
      : [];
    for (const el of silenced) el.inert = true;
    // Focus moves into the panel, onto its first link.
    panel?.querySelector<HTMLElement>("a[href]")?.focus();

    function focusables(): HTMLElement[] {
      const inPanel = panel ? [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')] : [];
      return [buttonRef.current, ...inPanel].filter((el): el is HTMLElement => Boolean(el && el.offsetParent !== null));
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (e.key !== "Tab") return;
      // Tab and Shift+Tab cycle through the menu button and the panel only.
      const items = focusables();
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === -1 || at === items.length - 1 ? 0 : at + 1;
      e.preventDefault();
      items[next].focus();
    }
    function onDoc(e: MouseEvent) {
      if (root && !root.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
      for (const el of silenced) el.inert = false;
    };
  }, [open]);

  const n = t.landing.nav;
  return (
    <div ref={rootRef} className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? n.close : n.menu}
        className="st-menu-btn"
      >
        {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
      </button>

      {open && (
        // The scrim dims the page the menu covers; a tap on it closes the menu.
        <div aria-hidden className="st-menu-scrim" onClick={() => setOpen(false)} />
      )}
      {open && (
        <div id={panelId} ref={panelRef} className="st-menu">
          <nav aria-label={n.label} className="flex flex-col">
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} aria-current={l.current ? "page" : undefined}>
                {l.label}
              </Link>
            ))}
            <Link href="/login" onClick={() => setOpen(false)}>
              {signInLabel}
            </Link>
          </nav>
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-[var(--ns-rule)] px-2 pt-3">
            {/* Theme first: the language list opens leftwards from its button,
                which must therefore sit at the panel's right edge. */}
            <ThemeToggle showLabel />
            <LanguageSelector />
          </div>
        </div>
      )}
    </div>
  );
}
