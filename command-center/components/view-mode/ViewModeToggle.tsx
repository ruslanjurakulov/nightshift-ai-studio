"use client";

import { useEffect, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { usePublicI18n } from "@/lib/i18n/public-context";
import type { PublicDictionary } from "@/lib/i18n/public";
import {
  DESKTOP_MEDIA,
  choiceFor,
  effectiveMode,
  otherMode,
  readViewChoice,
  viewCookieString,
  type ViewMode,
} from "@/lib/view-mode";
import { reloadTop } from "./frame-nav";

/** A screen this small is a phone: Mobile there is what the device does by itself, so it needs no frame. */
const PHONE_SCREEN_PX = 700;

/**
 * The Mobile / Desktop view switch. The icon and word show the layout on
 * screen NOW (phone and "Mobile", or monitor and "Desktop"); a press gives the
 * other one. The choice is the `ns_view` cookie (lib/view-mode.ts): written
 * here with document.cookie because it holds no secret and no identity, needs
 * no round trip, and the server reads it on the very next request, which is
 * the reload that follows (a layout is chosen by the server, so the page is
 * reloaded rather than patched). Automatic stays the default until the first
 * press.
 *
 * `variant="pill"` is the control that sits beside the theme switch;
 * `variant="link"` is the public footer's small text link, which names the
 * version a press gives ("Desktop version"), as footers do.
 *
 * Before mount the mode is unknown (the viewport is a browser fact), so the
 * control renders an empty box of its final size and then fills in, like
 * ThemeToggle: no layout shift, no hydration mismatch.
 */
export function ViewModeToggle(props: ViewModeProps) {
  const { t } = usePublicI18n();
  return <ViewModeControl {...props} labels={t.common} />;
}

type ViewModeProps = {
  variant?: "pill" | "link";
  showLabel?: boolean;
  /** With a label: below `lg` only the icon shows (the top bar is crowded there); the accessible name stays. */
  compact?: boolean;
  className?: string;
};

/** The same control with its words handed in, for a server-rendered footer that holds the dictionary already. */
export function ViewModeControl({
  variant = "pill",
  showLabel = false,
  compact = false,
  labels,
  className = "",
}: ViewModeProps & { labels: PublicDictionary["common"] }) {
  const [mode, setMode] = useState<ViewMode | null>(null);

  useEffect(() => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_MEDIA) : null;
    const read = () => setMode(effectiveMode(readViewChoice(document.cookie), mq?.matches ?? false));
    read();
    mq?.addEventListener("change", read);
    return () => mq?.removeEventListener("change", read);
  }, []);

  function flip() {
    if (mode === null) return;
    const phone = Math.min(window.screen.width, window.screen.height) < PHONE_SCREEN_PX;
    const choice = choiceFor(otherMode(mode), phone);
    document.cookie = viewCookieString(choice, window.location.protocol === "https:");
    reloadTop();
  }

  const c = labels;
  const action = mode === "mobile" ? c.switchToDesktop : mode === "desktop" ? c.switchToMobile : c.viewMobile;
  const Icon = mode === "desktop" ? Monitor : Smartphone;

  if (variant === "link") {
    return (
      <button
        type="button"
        onClick={flip}
        disabled={mode === null}
        aria-label={mode === null ? undefined : action}
        className={`inline-flex min-h-11 items-center gap-2 underline-offset-4 transition-colors hover:text-[var(--color-primary)] hover:underline ${className}`}
      >
        {mode !== null && <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />}
        <span aria-hidden={mode === null}>{mode === null ? " " : mode === "mobile" ? c.desktopVersion : c.mobileVersion}</span>
      </button>
    );
  }

  const word = mode === "desktop" ? c.viewDesktop : c.viewMobile;
  return (
    <button
      type="button"
      onClick={flip}
      disabled={mode === null}
      title={mode === null ? undefined : action}
      aria-label={mode === null ? c.viewMobile : action}
      className={`${
        showLabel
          ? `btn-sky is-quiet pill h-10 gap-2 px-4 text-sm font-light${compact ? " max-lg:size-10 max-lg:justify-center max-lg:px-0" : ""}`
          : "btn-sky is-quiet pill grid size-10 place-items-center"
      } ${className}`}
    >
      <span className="relative block size-4" aria-hidden>
        {mode !== null && <Icon className="size-4" strokeWidth={1.75} />}
      </span>
      {showLabel && (
        <span aria-hidden className={`min-w-[4.5rem] text-left${compact ? " max-lg:hidden" : ""}`}>
          {mode === null ? " " : word}
        </span>
      )}
    </button>
  );
}
