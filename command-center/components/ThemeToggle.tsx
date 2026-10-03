"use client";

import { useEffect, useState } from "react";
import { applyTheme, resolvedTheme, type Theme } from "@/lib/theme";
import { usePublicI18n } from "@/lib/i18n/public-context";

/**
 * Dark / light toggle. The theme is applied to <html> before paint by the
 * no-flash script; this control reads the resolved value after mount (so no
 * hydration mismatch) and flips it, persisting the choice.
 */
export function ThemeToggle({ showLabel = false }: { showLabel?: boolean } = {}) {
  const { t } = usePublicI18n();
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(resolvedTheme());
  }, []);

  function toggle() {
    const next: Theme = (theme ?? resolvedTheme()) === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }

  const isDark = theme === "dark";
  const label = `${t.common.theme}: ${isDark ? t.common.dark : t.common.light}`;

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
