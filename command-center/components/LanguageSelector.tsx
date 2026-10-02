"use client";

import { useEffect, useRef, useState } from "react";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { LOCALES, type Locale } from "@/lib/i18n/core";

/** Compact language menu (EN / RU / UZ) for the header. Switching updates the
 *  whole UI instantly (client) and refreshes Server Components in the new
 *  language via the provider. */
export function LanguageSelector() {
  const { locale, setLocale, t } = usePublicI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];

  function choose(code: Locale) {
    if (code !== locale) setLocale(code);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t.common.language}
        className="btn-sky is-quiet pill h-10 gap-2 px-3.5"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
        </svg>
        <span className="mono text-[11px] font-semibold tracking-wider">{current.short}</span>
      </button>

      {open && (
        <ul
          role="listbox"
          className="drawer-enter absolute right-0 z-50 mt-3 overflow-hidden w-40 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2 shadow-[var(--shadow-elevated)]"
        >
          {LOCALES.map((l) => {
            const active = l.code === locale;
            return (
              <li key={l.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => choose(l.code)}
                  className="btn-sky is-quiet pill w-full justify-between border-transparent px-4 py-2.5 text-left text-[14px] font-light"
                  style={{ color: active ? "var(--color-primary)" : "var(--color-fg)" }}
                >
                  <span>{l.label}</span>
                  <span className="mono text-[10px] tracking-wider text-[var(--color-muted)]">{l.short}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
