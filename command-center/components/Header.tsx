"use client";

import Link from "next/link";

import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { SignOutButton } from "@/components/SignOutButton";
import { NotificationsCenter } from "@/components/NotificationsCenter";
import { UtcClock } from "@/components/UtcClock";
import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { ALL_CHANNELS, type ChannelSelection } from "@/lib/channels";
import type { ChannelRow } from "@/lib/types";

/**
 * The top bar: the wordmark on the left, the account pill and operator controls
 * on the right. Route navigation lives in the left rail (SideNav) — grouped and
 * icon-led, with only the daily-loop destinations surfaced at the top so the
 * shell reads as a product, not a wall of admin links.
 */
export function Header({
  channels = [],
  selection = ALL_CHANNELS,
}: {
  channels?: ChannelRow[];
  selection?: ChannelSelection;
}) {
  const { t } = useI18n();
  const path = useChannelPath();

  function openPalette() {
    window.dispatchEvent(new CustomEvent("chronos:palette-open"));
  }

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_78%,transparent)] px-[clamp(0.75rem,3vw,56px)] py-4 backdrop-blur-md sm:py-5">
      <div className="bar-measure flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-6 xl:gap-10">
        <Link
          href={path("/command-center")}
          className="font-display shrink-0 text-lg font-semibold tracking-[-0.02em] text-[var(--color-primary)] sm:text-xl"
        >
          {t.brand.name}
        </Link>
      </div>

        <div className="flex flex-wrap items-center justify-end gap-2 sm:flex-nowrap sm:gap-3">
        <ChannelSwitcher channels={channels} selection={selection} />
        <button
          type="button"
          onClick={openPalette}
          aria-label={t.ops.palettePlaceholder}
          className="btn-sky is-quiet pill hidden h-9 gap-2 px-3.5 sm:inline-flex"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <span className="mono pill border border-[var(--color-border)] px-1.5 text-[9px] tracking-wider">⌘K</span>
        </button>
        <UtcClock />
        <NotificationsCenter />
        <LanguageSelector />
        <ThemeToggle />
        <SignOutButton />
      </div>
      </div>
    </header>
  );
}
