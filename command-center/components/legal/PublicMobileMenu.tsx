"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";

/**
 * The public header's menu below the desktop breakpoint: the section links,
 * Sign in, and the theme and language controls that do not fit a phone's bar.
 * "Start creating" stays outside it, in the bar. Closes on a link, on Escape,
 * and on a tap outside, and hands focus back to its button on Escape.
 */
export function PublicMobileMenu({
  links,
  signInLabel,
}: {
  links: { href: string; label: string }[];
  signInLabel: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
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
        className="btn-sky is-quiet pill grid size-11 place-items-center"
      >
        {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
      </button>

      {open && (
        <div
          id={panelId}
          className="sheet-enter absolute inset-x-3 top-[calc(100%+0.5rem)] z-50 rounded-[20px] border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-[var(--shadow-elevated)]"
        >
          <nav aria-label={n.label} className="flex flex-col">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="flex min-h-12 items-center rounded-xl px-4 text-[16px] transition-colors hover:bg-[var(--color-panel-2)]"
              >
                {l.label}
              </Link>
            ))}
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="flex min-h-12 items-center rounded-xl px-4 text-[16px] transition-colors hover:bg-[var(--color-panel-2)]"
            >
              {signInLabel}
            </Link>
          </nav>
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-2 pt-3">
            {/* Theme first: the language list opens leftwards from its button,
                which must therefore sit at the panel's right edge. */}
            <ThemeToggle />
            <LanguageSelector />
          </div>
        </div>
      )}
    </div>
  );
}
