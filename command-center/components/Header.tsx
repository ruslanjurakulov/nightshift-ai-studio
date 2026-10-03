"use client";

import Link from "next/link";

import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { BrandMark } from "@/components/site/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { AccountMenu } from "@/components/account/AccountMenu";
import { NotificationsCenter } from "@/components/NotificationsCenter";
import { NotificationBell } from "@/components/shell/NotificationBell";
import { UtcClock } from "@/components/UtcClock";
import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { OrgSwitcher } from "@/components/org/OrgSwitcher";
import { CreditBalanceChip } from "@/components/credits/CreditBalanceChip";
import { CreditMenu } from "@/components/shell/CreditMenu";
import type { CreditAccount } from "@/lib/credits";
import type { AccountPlan } from "@/lib/account";
import type { OrgSummary } from "@/lib/orgs";
import { ALL_CHANNELS, unscopedScope, type ChannelScope, type ChannelSelection } from "@/lib/channels";
import type { ChannelRow } from "@/lib/types";

/**
 * The top bar: the wordmark on the left, the controls and — last, so it sits at
 * the right edge on every width — the account button on the right. Route navigation lives in the left rail (SideNav) — grouped and
 * icon-led, with only the daily-loop destinations surfaced at the top so the
 * shell reads as a product, not a wall of admin links.
 */
export function Header({
  channels = [],
  selection = ALL_CHANNELS,
  orgs = [],
  currentOrgId = null,
  credits = null,
  scope = unscopedScope(),
  email = null,
  operator = true,
  plan = null,
}: {
  channels?: ChannelRow[];
  selection?: ChannelSelection;
  /** What the notifications may show — the current organization's channels. */
  scope?: ChannelScope;
  orgs?: OrgSummary[];
  currentOrgId?: string | null;
  /** The current org's credits; null for the exempt default org or before 0020. */
  credits?: CreditAccount | null;
  /** The signed-in email, for the account button's initial; the panel reads
   *  the rest itself when it opens. */
  email?: string | null;
  /** The platform operator keeps the console's bar; a customer gets the
   *  creative app's (sidebar wordmark, credit pill, account on the card). */
  operator?: boolean;
  /** The organization's plan, read server-side, for the credit menu. */
  plan?: AccountPlan | null;
}) {
  const { t } = useI18n();
  const path = useChannelPath();

  function openPalette() {
    window.dispatchEvent(new CustomEvent("chronos:palette-open"));
  }

  if (!operator) {
    return (
      <header className="shell-topbar sticky top-0 z-30 px-4 py-2 lg:px-6">
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2">
          {/* The wordmark lives in the sidebar from `lg` up. */}
          <Link
            href={path("/create")}
            className="tap-link ns-wordmark inline-flex shrink-0 items-center gap-2 lg:hidden"
          >
            <BrandMark size={34} />
            {t.brand.name}
          </Link>
          {/* The organization and channel, when there is more than one to choose
              between (each renders nothing otherwise): beside the wordmark on a
              wide screen, a row of their own under the bar on a phone. */}
          <div className="order-last flex w-full min-w-0 items-center gap-2 empty:hidden sm:order-none sm:mr-auto sm:w-auto">
            <OrgSwitcher orgs={orgs} currentId={currentOrgId} />
            <ChannelSwitcher channels={channels} selection={selection} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:contents">
              <button
                type="button"
                onClick={openPalette}
                aria-label={t.ops.palettePlaceholder}
                className="btn-sky is-quiet pill h-10 gap-2 px-3.5"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <span className="tnum pill border border-[var(--color-border)] px-1.5 text-xs">⌘K</span>
              </button>
            </span>
            <CreditMenu account={credits} plan={plan} />
            {/* The customer's own, database-backed inbox (migration 0064); the
                operator's bar below keeps the event-derived feed. */}
            <NotificationBell orgId={currentOrgId} />
            <span className="hidden sm:contents">
              <LanguageSelector />
              <ThemeToggle />
            </span>
            {/* On a phone and tablet the account sits here; from `lg` up it is
                the sidebar's user card. */}
            <div className="lg:hidden">
              <AccountMenu email={email} plan={plan} />
            </div>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_78%,transparent)] px-[clamp(0.75rem,3vw,56px)] py-4 backdrop-blur-md sm:py-5">
      <div className="bar-measure flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-6 xl:gap-10">
        <Link
          href={path("/command-center")}
          className="tap-link font-display inline-flex shrink-0 items-center gap-2 text-lg font-semibold tracking-[-0.02em] text-[var(--color-primary)] sm:text-xl"
        >
          <BrandMark size={34} />
          {t.brand.name}
        </Link>
      </div>

        {/* Below `sm` the bar keeps only what a phone needs every minute: the
            channel, the bell and the account. Credits, language and theme move
            into the account menu (which shows them anyway), and the ⌘K search
            has no keyboard on a phone. The wrappers are `contents` from `sm`
            up, so the desktop bar is unchanged. They are spans rather than a
            `hidden` class on the control because `.btn-sky` sets its own
            display, which beats the utility. */}
        <div className="flex flex-wrap items-center justify-end gap-2 sm:flex-nowrap sm:gap-3">
        <OrgSwitcher orgs={orgs} currentId={currentOrgId} />
        <span className="hidden sm:contents">
          <CreditBalanceChip account={credits} />
        </span>
        <ChannelSwitcher channels={channels} selection={selection} />
        <span className="hidden sm:contents">
          <button
            type="button"
            onClick={openPalette}
            aria-label={t.ops.palettePlaceholder}
            className="btn-sky is-quiet pill h-10 gap-2 px-3.5"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span className="tnum pill border border-[var(--color-border)] px-1.5 text-xs">⌘K</span>
          </button>
        </span>
        <UtcClock />
        <NotificationsCenter scope={scope} />
        <span className="hidden sm:contents">
          <LanguageSelector />
          <ThemeToggle />
        </span>
        <AccountMenu email={email} />
      </div>
      </div>
    </header>
  );
}
