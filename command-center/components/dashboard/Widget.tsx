"use client";

import { useEffect, useState, type ReactNode } from "react";

const KEY = (id: string) => `chronos_widget_${id}`;

/**
 * A dashboard widget frame that can be shown/hidden in customize mode. It
 * listens for the `chronos:customize` window event (from CustomizeButton) to
 * reveal a per-widget visibility toggle, and remembers the choice in
 * localStorage. Hidden widgets render nothing outside customize mode, so the
 * responsive grid reflows naturally.
 */
export function Widget({
  id,
  title,
  span,
  right,
  children,
}: {
  id: string;
  title: string;
  span?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(true);
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY(id)) === "0") setVisible(false);
    } catch {
      // storage unavailable — default to visible
    }
  }, [id]);

  useEffect(() => {
    function onCustomize(e: Event) {
      setCustomizing(Boolean((e as CustomEvent).detail?.on));
    }
    window.addEventListener("chronos:customize", onCustomize);
    return () => window.removeEventListener("chronos:customize", onCustomize);
  }, []);

  function toggle() {
    const next = !visible;
    setVisible(next);
    try {
      localStorage.setItem(KEY(id), next ? "1" : "0");
    } catch {
      // ignore
    }
  }

  if (!visible && !customizing) return null;

  return (
    <section
      className={`section-open transition-opacity ${span ?? ""} ${!visible ? "opacity-45" : ""}`}
    >
      <header className="section-head">
        <h2 className="t-panel">{title}</h2>
        <div className="flex items-center gap-2">
          {right}
          {customizing && (
            <button
              type="button"
              onClick={toggle}
              aria-pressed={visible}
              className="tap-icon grid size-7 place-items-center rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              {visible ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5">
                  <path d="M17.9 17.9A10.4 10.4 0 0 1 12 19C5.5 19 2 12 2 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 7 10 7a18.4 18.4 0 0 1-2.2 3.2M1 1l22 22" />
                </svg>
              )}
            </button>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
