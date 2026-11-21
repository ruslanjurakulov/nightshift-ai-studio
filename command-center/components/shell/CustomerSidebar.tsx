"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { PanelLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath, useChannelSlug } from "@/lib/channels-client";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { CUSTOMER_SIDEBAR, customerRail, sidebarCurrent, type NavItem } from "@/lib/navigation";
import { AccountMenu } from "@/components/account/AccountMenu";
import { ICONS } from "@/components/navigation/navIcons";
import { useShell } from "@/components/shell/ShellContext";
import { Wordmark } from "@/components/site/Wordmark";
import type { AccountPlan } from "@/lib/account";
import { aside as MAside, nav as MNav } from "motion/react-m";
import { Plate, SharedLayout } from "@/components/motion/SharedLayout";
import { useSidebar } from "@/components/shell/SidebarState";

/** One lit plate for the whole sidebar: it slides from the row you left to the row you opened. */
const PLATE = "sidebar-current";

/** The row's link classes; the current row hosts the plate. */
function rowClass(current: boolean): string {
  return current ? "shell-link ns-plate-host" : "shell-link";
}

/** The section path after the channel: "/chronos/create" → "/create". */
function useSection(): string {
  const pathname = usePathname();
  return "/" + pathname.split("/").slice(2).join("/");
}

/**
 * A customer's desktop sidebar, full height on the left: the wordmark, Home,
 * Nightshift Studio, the Inbox and Channels, and at the foot Plans & credits,
 * Settings and the user card (which opens the account panel). Below `lg` it is
 * not rendered — the phone has the bottom bar.
 *
 * The current row is lit by one plate that slides along the rail to the row
 * you open (components/motion/SharedLayout); reduced motion, it is simply
 * drawn there.
 *
 * Presentation only: every destination is a customer section, and the layout
 * and RLS decide what anyone may open.
 */
export function CustomerSidebar({
  email,
  avatarV = null,
  plan,
}: {
  email: string | null;
  avatarV?: number | null;
  plan: AccountPlan | null;
}) {
  const { t } = useI18n();
  const path = useChannelPath();
  const { collapsed, toggle } = useSidebar();
  const { home, footer } = CUSTOMER_SIDEBAR;
  const label = collapsed ? t.shell.expandSidebar : t.shell.collapseSidebar;
  // The rail's tooltip: a row's name beside it, on hover and on keyboard focus (the name is also the link's accessible
  // name, so the tooltip is a visual extra and hidden from assistive tech). Fixed, so the nav's own scrolling cannot clip it.
  const [tip, setTip] = useState<{ text: string; top: number } | null>(null);
  const showTip = (el: Element | null, needFocusVisible = false) => {
    const row = collapsed ? (el as HTMLElement | null)?.closest<HTMLElement>("[data-tip]") ?? null : null;
    if (!row || (needFocusVisible && !row.matches(":focus-visible"))) return setTip(null);
    const r = row.getBoundingClientRect();
    setTip({ text: row.dataset.tip ?? "", top: r.top + r.height / 2 });
  };

  return (
    <SharedLayout id="customer-sidebar">
      {/* layoutRoot: the sidebar is pinned to the viewport (sticky), so the
          plate measures itself against the sidebar, not the scrolled page. */}
      <MAside
        layoutRoot
        id="customer-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
        className="shell-sidebar sticky top-0 z-30 hidden h-dvh shrink-0 flex-col lg:flex"
        onMouseOver={(e) => showTip(e.target as Element)}
        onMouseLeave={() => setTip(null)}
        onFocus={(e) => showTip(e.target as Element, true)}
        onBlur={() => setTip(null)}
      >
        {collapsed && tip && (
          <div aria-hidden className="shell-tip" style={{ top: tip.top }} data-testid="sidebar-tip">
            {tip.text}
          </div>
        )}
        <div className="shell-sidebar-head">
          {/* The rail keeps the bare N; the full lockup comes back with the labels. */}
          <Link href={path(home.href)} className="inline-flex min-h-11 min-w-11 items-center text-[var(--color-fg)]" aria-label={t.brand.name}>
            <Wordmark height={collapsed ? 32 : 31} mark={collapsed} />
          </Link>
          {/* The panel toggle: a square with a divider, as the panel icon of a chat app. Collapses the rail to its icons. */}
          <button
            type="button"
            onClick={toggle}
            aria-label={label}
            aria-expanded={!collapsed}
            aria-controls="customer-sidebar-nav"
            title={label}
            className="shell-sidebar-toggle"
            data-testid="sidebar-toggle"
          >
            <PanelLeft aria-hidden className="size-5" strokeWidth={1.75} />
          </button>
        </div>

        {/* layoutScroll: the rows scroll inside this box on a short window. */}
        <MNav id="customer-sidebar-nav" layoutScroll aria-label={t.shell.primary} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
          <Suspense fallback={<SidebarRows current={null} collapsed={collapsed} />}>
            <CurrentRows collapsed={collapsed} />
          </Suspense>
        </MNav>

        <div className="flex shrink-0 flex-col gap-0.5 border-t border-[var(--shell-border)] px-3 pb-3 pt-2">
          <FooterRows items={footer} collapsed={collapsed} />
          <div className="pt-2">
            <AccountMenu email={email} avatarV={avatarV} variant="card" plan={plan} />
          </div>
        </div>
      </MAside>
    </SharedLayout>
  );
}

/** The rows that need the section (which one is lit). */
function CurrentRows({ collapsed }: { collapsed: boolean }) {
  const section = useSection();
  return <SidebarRows current={sidebarCurrent(section)} collapsed={collapsed} />;
}

/**
 * Nightshift Studio, the Media library, Nightshift Brain and Channels (lib/navigation CUSTOMER_RAIL). The Studio's desks and tools used to be rows
 * of their own here (and the creative screens a group of their own); they are tiles on Studio home
 * now, so the sidebar is a few places, not a wall of tools (docs/studio/STUDIO_IA.md §4).
 */
function SidebarRows({ current, collapsed }: { current: string | null; collapsed: boolean }) {
  // Nightshift AI only where the server's flag lets this workspace in; Analytics and Research only on one channel.
  const work = customerRail(useShell().features, useChannelSlug() !== ALL_CHANNELS_SLUG);
  return (
    <>
      <ul className="flex flex-col gap-0.5 pt-1">
        {work.map((item) => (
          <Row key={item.key} item={item} current={current} collapsed={collapsed} />
        ))}
      </ul>
    </>
  );
}

function FooterRows({ items, collapsed }: { items: readonly NavItem[]; collapsed: boolean }) {
  return (
    <Suspense fallback={<FooterList items={items} current={null} collapsed={collapsed} />}>
      <FooterCurrent items={items} collapsed={collapsed} />
    </Suspense>
  );
}

function FooterCurrent({ items, collapsed }: { items: readonly NavItem[]; collapsed: boolean }) {
  const section = useSection();
  return <FooterList items={items} current={sidebarCurrent(section)} collapsed={collapsed} />;
}

function FooterList({ items, current, collapsed }: { items: readonly NavItem[]; current: string | null; collapsed: boolean }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => (
        <Row key={item.key} item={item} current={current} collapsed={collapsed} />
      ))}
    </ul>
  );
}

function Row({ item, current, collapsed }: { item: NavItem; current: string | null; collapsed: boolean }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const Icon = ICONS[item.key];
  // "Credits" in the rail, "Plans & credits" here: the page holds both.
  const label = item.key === "credits" ? t.shell.plansCredits : t.nav[item.key];
  const on = current === item.key;
  return (
    <li>
      <Link href={path(item.href)} aria-current={on ? "page" : undefined} className={rowClass(on)} data-tip={collapsed ? label : undefined}>
        {on && <Plate id={PLATE} />}
        <Icon aria-hidden className="shell-icon size-[18px]" strokeWidth={1.9} />
        <span className={collapsed ? "sr-only" : "truncate"}>{label}</span>
      </Link>
    </li>
  );
}
