"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { PROJECTS, sidebarCurrent } from "@/lib/navigation";

import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { Wordmark } from "@/components/site/Wordmark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ViewModeToggle } from "@/components/view-mode/ViewModeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { AccountMenu } from "@/components/account/AccountMenu";
import { NotificationsCenter } from "@/components/NotificationsCenter";
import { NotificationBell } from "@/components/shell/NotificationBell";
import { UtcClock } from "@/components/UtcClock";
import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { OrgSwitcher } from "@/components/org/OrgSwitcher";
import { ContextSwitcher } from "@/components/shell/ContextSwitcher";
import { CreditBalanceChip } from "@/components/credits/CreditBalanceChip";
import { CreditMenu } from "@/components/shell/CreditMenu";
import type { CreditAccount } from "@/lib/credits";
import { useLiveCreditsState } from "@/lib/credits-live";
import type { AccountPlan } from "@/lib/account";
import type { OrgSummary } from "@/lib/orgs";
import { ALL_CHANNELS, unscopedScope, type ChannelScope, type ChannelSelection } from "@/lib/channels";
import type { ChannelRow } from "@/lib/types";

/**
 * The top bar: the wordmark on the left, the controls on the right. For a
 * customer the account is not here: it is the bottom bar's last tab on a phone
 * and the sidebar's user card from `lg`; the operator's bar keeps its account
 * button as its last control. Route navigation lives in the left rail (SideNav) — grouped and
 * icon-led, with only the daily-loop destinations surfaced at the top so the
 * shell reads as a product, not a wall of admin links.
 */
export function Header({
  channels = [],
  selection = ALL_CHANNELS,
  orgs = [],
  currentOrgId = null,
  credits = null,
  creditsReadAt = null,
  scope = unscopedScope(),
  email = null,
  avatarV = null,
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
  /** When the layout read `credits` on the server (ISO): the live store keeps a fresher reading of its own over an older page. */
  creditsReadAt?: string | null;
  /** The signed-in email, for the operator bar's account button; the panel
   *  reads the rest itself when it opens. */
  email?: string | null;
  /** The photo's version (avatar_v), or null for none. */
  avatarV?: number | null;
  /** The platform operator keeps the console's bar; a customer gets the
   *  creative app's (wordmark, credit pill, bell; the account is the sidebar
   *  card or the bottom bar's last tab). */
  operator?: boolean;
  /** The organization's plan, read server-side, for the credit menu. */
  plan?: AccountPlan | null;
}) {
  const { t } = useI18n();
  const path = useChannelPath();
  // The layout's reading seeds the live value; a generation started, cancelled or finished re-reads it (lib/credits-live.ts).
  const { account, stale } = useLiveCreditsState(currentOrgId, credits, creditsReadAt);

  const pathname = usePathname();

  // Nightshift Studio is one workspace: its own bar replaces this one (the canvas portals its project bar into the
  // slot), so the page has ONE bar, not the app's plus the canvas's. Every other route keeps its bar unchanged.
  if (pathname === path("/studio")) {
    return (
      <header className="cv-appbar" data-studio-bar="">
        <div id="studio-bar-slot" className="cv-appbar-slot" />
        <div className="cv-appbar-tools">
          {/* Nobody is stranded here: the workspace and channel pickers at every width (one combined picker on a phone), and
              the language, view and account controls the full sidebar would have given. */}
          <ContextSwitcher orgs={orgs} currentOrgId={currentOrgId} channels={channels} selection={selection} />
          <span className="hidden sm:contents">
            <OrgSwitcher orgs={orgs} currentId={currentOrgId} />
            <ChannelSwitcher channels={channels} selection={selection} />
          </span>
          {operator ? <CreditBalanceChip account={account} /> : <CreditMenu account={account} plan={plan} stale={stale} />}
          {operator ? <NotificationsCenter scope={scope} /> : <NotificationBell orgId={currentOrgId} channels={channels} />}
          <span className="hidden sm:contents">
            <LanguageSelector />
            <ThemeToggle />
            <span className="hidden lg:contents">
              <ViewModeToggle compact />
            </span>
            <AccountMenu email={email} avatarV={avatarV} />
          </span>
        </div>
      </header>
    );
  }

  function openPalette() {
    window.dispatchEvent(new CustomEvent("chronos:palette-open"));
  }

  if (!operator) {
    const section = "/" + pathname.split("/").slice(2).join("/");
    const here = sidebarCurrent(section);
    const hereLabel = here && here in t.nav ? t.nav[here as keyof typeof t.nav] : null;
    return (
      <header className="shell-topbar sticky top-0 z-30 px-4 py-2 lg:px-6" data-customer-topbar="">
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-2 sm:gap-x-3">
          {/* Left: the N and where you are. From `lg` the sidebar carries the full lockup, so the bar keeps only the trail. */}
          <nav aria-label={t.customerApp.shell.breadcrumb} className="flex min-w-0 shrink items-center gap-2">
            <Link
              href={path("/home")}
              aria-label={t.brand.name}
              className="tap-link inline-flex shrink-0 items-center text-[var(--color-fg)] [--wm-h:28px] lg:hidden"
            >
              <Wordmark mark />
            </Link>
            {hereLabel && (
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <span aria-hidden className="text-[var(--color-muted)] lg:hidden">/</span>
                <span aria-current="page" className="truncate font-medium text-[var(--color-fg)]">{hereLabel}</span>
              </span>
            )}
          </nav>
          {/* The organization and channel, when there is more than one to choose between (each renders nothing otherwise). */}
          <div className="order-last flex w-full min-w-0 items-center gap-2 empty:hidden sm:order-none sm:w-auto">
            <OrgSwitcher orgs={orgs} currentId={currentOrgId} />
            <ChannelSwitcher channels={channels} selection={selection} />
          </div>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <span className="hidden sm:contents">
              <button
                type="button"
                onClick={openPalette}
                aria-label={t.ops.palettePlaceholder}
                className="btn-sky is-quiet pill h-10 gap-2 px-3.5"
              >
                <Search aria-hidden className="size-4" strokeWidth={2} />
                <span className="hidden text-sm md:inline">{t.customerApp.shell.search}</span>
                <span className="tnum pill border border-[var(--color-border)] px-1.5 text-xs">⌘K</span>
              </button>
            </span>
            <CreditMenu account={account} plan={plan} stale={stale} />
            {/* The customer's own, database-backed inbox (migration 0064). */}
            <NotificationBell orgId={currentOrgId} channels={channels} />
            <span className="hidden sm:contents">
              <LanguageSelector />
            </span>
            {/* "+ New project": the projects shelf, where a project is started. A link: nothing is made or spent by it. */}
            {/* A span, not `hidden` on the key: .btn-sky sets its own display, which beats the utility. */}
            <span className="hidden md:contents">
              <Link href={path(PROJECTS)} className="btn-sky pill h-10 items-center gap-1.5 px-3.5 text-sm font-medium" data-testid="topbar-new-project">
                <Plus aria-hidden className="size-4" strokeWidth={2.25} />
                {t.customerApp.shell.newProject}
              </Link>
            </span>
            {/* Below `lg` there is no sidebar card: the account (and Owner mode, for the owner) is this round button. */}
            <span className="lg:hidden">
              <AccountMenu email={email} avatarV={avatarV} />
            </span>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_78%,transparent)] px-[clamp(0.75rem,3vw,56px)] py-2 backdrop-blur-md sm:py-5">
      {/* One row on a phone, as the customer's bar is: the mark, ONE workspace picker (organization above
          channel, full names in its sheet), the bell and the account. Navigation is the bottom bar
          (SideNav), not a second row. From `sm` the bar is the desktop one, wrapping as it always did. */}
      <div className="bar-measure flex items-center justify-between gap-x-2 sm:flex-wrap sm:gap-x-6 sm:gap-y-3">
        <div className="flex min-w-0 shrink-0 items-center gap-6 xl:gap-10">
          <Link
            href={path("/command-center")}
            aria-label={t.brand.name}
            className="tap-link inline-flex min-w-11 shrink-0 items-center justify-center text-[var(--color-fg)] [--wm-h:32px] sm:min-w-0 sm:justify-start"
          >
            <span className="sm:hidden">
              <Wordmark mark />
            </span>
            <span className="hidden sm:block">
              <Wordmark />
            </span>
          </Link>
        </div>

        {/* Below `sm` the bar keeps only what a phone needs every minute: the workspace, the bell and the
            account. Credits, language and theme move into the account menu (which shows them anyway), and the
            ⌘K search has no keyboard on a phone. The wrappers are `contents` from `sm` up, so the desktop bar
            is unchanged. They are spans rather than a `hidden` class on the control because `.btn-sky` sets
            its own display, which beats the utility. */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none sm:flex-nowrap sm:gap-3">
          <ContextSwitcher orgs={orgs} currentOrgId={currentOrgId} channels={channels} selection={selection} />
          <span className="hidden sm:contents">
            <OrgSwitcher orgs={orgs} currentId={currentOrgId} />
            <CreditBalanceChip account={account} />
            <ChannelSwitcher channels={channels} selection={selection} />
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
            <span className="hidden md:contents">
              <ViewModeToggle showLabel compact />
            </span>
          </span>
          <AccountMenu email={email} avatarV={avatarV} />
        </div>
      </div>
    </header>
  );
}
