"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";

/** The ground floor. Named, like every other section — `/` only redirects here. */
export const HOME = "/command-center";


/**
 * How a screen presents itself, following the direction's own two screens.
 *
 * The Command Center is the ground floor: a full-width card, nothing behind it
 * to go back to, so no close control.
 *
 * Every other section opened FROM it is presented the way the direction
 * presents its panel — a narrower surface centred over a dimmed ground, rising
 * into place, with the ✕ in its corner. Escape closes it too, because a panel
 * that only closes by mouse is half a panel.
 */
export function SectionShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const path = useChannelPath();
  const home = path(HOME);
  // Compared after the channel segment: every channel has its own ground floor.
  const isHome = pathname === home;

  useEffect(() => {
    if (isHome) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Don't hijack Escape from a control that handles it itself — closing a
      // <select> dropdown, clearing an <input>, dismissing an open menu. On the
      // form-heavy panels (approvals, members, alerts) pressing Escape there
      // means "close this control", not "eject me to the dashboard".
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (e.defaultPrevented) return;
      router.push(home);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isHome, home, router]);

  if (isHome) {
    return (
      <div className="page-rise">
        <div className="section-card">{children}</div>
      </div>
    );
  }

  return (
    <>
      {/* The ground the panel opened over. Clicking it closes, as a scrim does. */}
      <button
        type="button"
        aria-label={t.ops.shortcutsClose}
        onClick={() => router.push(home)}
        className="scrim-enter fixed inset-0 z-0 cursor-default bg-black/55 backdrop-blur-[2px]"
      />
      <div className="page-rise relative z-10 mx-auto w-full max-w-[1100px]">
        <div className="section-card relative">
          <button
            type="button"
            onClick={() => router.push(home)}
            aria-label={t.ops.shortcutsClose}
            className="sheet-close absolute right-4 top-4 z-10 sm:right-6 sm:top-6"
          >
            ✕
          </button>
          {children}
        </div>
      </div>
    </>
  );
}
