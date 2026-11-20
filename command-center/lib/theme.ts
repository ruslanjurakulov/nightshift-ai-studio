export const THEME_KEY = "chronos_theme";
export type Theme = "light" | "dark";

/**
 * Blocking script injected before paint so the correct theme is applied to
 * <html> before the first frame — no flash of the wrong theme. Reads the saved
 * choice from localStorage. With no saved choice the page is DARK (the
 * product's primary look, owner decision for the 2026-11-24 demo): a new
 * visitor on a light system used to land on the light proof sheet. The default
 * is set, never saved, so it is not a choice: the theme key flips it and only
 * then is anything stored, and an explicit "light" always wins. Without
 * JavaScript, CSS still follows prefers-color-scheme.
 */
export const NO_FLASH_SCRIPT = `(function(){var d=document.documentElement;try{var t=localStorage.getItem('${THEME_KEY}');d.setAttribute('data-theme',t==='light'||t==='dark'?t:'dark');}catch(e){d.setAttribute('data-theme','dark');}})();`;

/** The theme actually in effect right now (the attribute the script set: a choice, else the dark default; else system). */
export function resolvedTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode / storage disabled — the attribute still applies for this session.
  }
}
