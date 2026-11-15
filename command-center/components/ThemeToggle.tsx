"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, resolvedTheme, type Theme } from "@/lib/theme";
import { usePublicI18n } from "@/lib/i18n/public-context";

/**
 * Dark / light toggle. The theme is applied to <html> before paint by the
 * no-flash script; this control reads the resolved value after mount (so no
 * hydration mismatch) and flips it, persisting the choice.
 */
export function ThemeToggle({ showLabel = false, choices = false }: { showLabel?: boolean; choices?: boolean } = {}) {
  const { t } = usePublicI18n();
  const [theme, setTheme] = useState<Theme | null>(null);

  // Kept in step with <html>, not read once: the public header draws two of these (the bar and the phone sheet), and a
  // press on one left the other showing the old theme; another tab's choice (ViewFrame) and the system's change it too.
  useEffect(() => {
    const sync = () => setTheme(resolvedTheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const system = window.matchMedia?.("(prefers-color-scheme: dark)");
    system?.addEventListener?.("change", sync);
    return () => {
      observer.disconnect();
      system?.removeEventListener?.("change", sync);
    };
  }, []);

  function choose(next: Theme) {
    applyTheme(next);
    setTheme(next);
  }

  function toggle() {
    choose((theme ?? resolvedTheme()) === "dark" ? "light" : "dark");
  }

  const isDark = theme === "dark";
  const label = `${t.common.theme}: ${isDark ? t.common.dark : t.common.light}`;

  // The account menu offers both choices; other consumers keep the existing toggle.
  if (choices) {
    return (
      <div role="group" aria-label={t.common.theme} className="ns-theme-choices inline-flex self-start items-center gap-1">
        {(["light", "dark"] as const).map((value) => {
          const Icon = value === "light" ? Sun : Moon;
          const name = value === "light" ? t.common.light : t.common.dark;
          return (
            <button
              key={value}
              type="button"
              disabled={theme === null}
              aria-label={name}
              title={name}
              aria-pressed={theme === value}
              onClick={() => choose(value)}
              className="ns-theme-choice btn-sky is-quiet pill inline-flex size-11 items-center justify-center p-0"
            >
              <Icon aria-hidden className="size-4" strokeWidth={1.75} />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className={
        showLabel
          ? "btn-sky is-quiet pill h-10 gap-2 px-4 text-sm font-light"
          : "btn-sky is-quiet pill grid size-10 place-items-center"
      }
    >
      {/* Before mount `theme` is null — render an empty, equally sized box so
          server and client first paint match, then swap in the real icon. */}
      <span className="relative block size-4" aria-hidden>
        {theme !== null && (
          isDark ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          )
        )}
      </span>
      {showLabel && <span aria-hidden>{theme === null ? label : isDark ? t.common.dark : t.common.light}</span>}
    </button>
  );
}
