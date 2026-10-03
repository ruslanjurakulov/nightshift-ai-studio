"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { CUSTOMER_SIDEBAR, sidebarCurrent, type NavItem } from "@/lib/navigation";
import { DESKS, deskFromQuery, deskHref, type Desk } from "@/lib/creative/desks";
import { runPrefillFromQuery } from "@/lib/home";
import { DESK_ICONS } from "@/components/studio/deskIcons";
import { AccountMenu } from "@/components/account/AccountMenu";
import { ICONS } from "@/components/navigation/navIcons";
import { BrandMark } from "@/components/site/BrandMark";
import type { AccountPlan } from "@/lib/account";
import { aside as MAside, nav as MNav } from "motion/react-m";
import { Plate, SharedLayout } from "@/components/motion/SharedLayout";

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
 * A customer's desktop sidebar, full height on the left: the wordmark, Studio,
 * the tools as direct links, their work, and at the foot Plans & credits,
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
export function CustomerSidebar({ email, plan }: { email: string | null; plan: AccountPlan | null }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const { home, footer } = CUSTOMER_SIDEBAR;

  return (
    <SharedLayout id="customer-sidebar">
      {/* layoutRoot: the sidebar is pinned to the viewport (sticky), so the
          plate measures itself against the sidebar, not the scrolled page. */}
      <MAside layoutRoot className="shell-sidebar sticky top-0 z-30 hidden h-dvh w-[240px] shrink-0 flex-col lg:flex">
        <div className="flex h-14 shrink-0 items-center px-5">
          <Link href={path(home.href)} className="ns-wordmark inline-flex items-center gap-2">
            <BrandMark size={20} />
            {t.brand.name}
          </Link>
        </div>

        {/* layoutScroll: the rows scroll inside this box on a short window. */}
        <MNav layoutScroll aria-label={t.shell.primary} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
          <Suspense fallback={<SidebarRows current={null} />}>
            <CurrentRows />
          </Suspense>
        </MNav>

        <div className="flex shrink-0 flex-col gap-0.5 border-t border-[var(--shell-border)] px-3 pb-3 pt-2">
          <FooterRows items={footer} />
          <div className="pt-2">
            <AccountMenu email={email} variant="card" plan={plan} />
          </div>
        </div>
      </MAside>
    </SharedLayout>
  );
}

/** The rows that need the query string (the desk rows), behind Suspense. */
function CurrentRows() {
  const section = useSection();
  const q = useSearchParams();
  const tool = q.get("tool");
  // On /create the row is the desk the page opens (lib/creative/desks), from the same query it reads.
  const onCreate = section === "/create" || section.startsWith("/create/");
  // The same validated read the page makes (lib/home), so a junk ?lang= never lights the YouTube desk.
  const hasRunPrefill = onCreate && !!runPrefillFromQuery({ topic: q.get("topic") ?? undefined, length: q.get("length") ?? undefined, lang: q.get("lang") ?? undefined });
  const desk = onCreate ? deskFromQuery({ desk: q.get("desk"), tool, hasRunPrefill }) : null;
  const current = desk ? `desk:${desk}` : sidebarCurrent(section, tool);
  return <SidebarRows current={current} />;
}

function SidebarRows({ current }: { current: string | null }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const { home, work } = CUSTOMER_SIDEBAR;
  const HomeIcon = ICONS[home.key];
  return (
    <>
      <ul className="flex flex-col gap-0.5 pt-1">
        <li>
          <Link href={path(home.href)} aria-current={current === "hub" ? "page" : undefined} className={rowClass(current === "hub")}>
            {current === "hub" && <Plate id={PLATE} />}
            <HomeIcon aria-hidden className="shell-icon size-[18px]" strokeWidth={1.9} />
            <span className="truncate">{t.nav[home.key]}</span>
          </Link>
        </li>
      </ul>

      <h2 className="shell-group">{t.shell.gCreate}</h2>
      {/* The Studio's desks (lib/creative/desks), each laid out around one job; the tools live inside them. */}
      <ul className="flex flex-col gap-0.5">
        {DESKS.map((d: Desk) => {
          const Icon = DESK_ICONS[d];
          const on = current === `desk:${d}`;
          return (
            <li key={d}>
              <Link href={path(deskHref(d))} aria-current={on ? "page" : undefined} className={rowClass(on)}>
                {on && <Plate id={PLATE} />}
                <span aria-hidden className="shell-tile">
                  <Icon className="size-3.5" strokeWidth={2} />
                </span>
                <span className="truncate">{t.desk.names[d]}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <h2 className="shell-group">{t.shell.gWork}</h2>
      <ul className="flex flex-col gap-0.5">
        {work.map((item) => (
          <Row key={item.key} item={item} current={current} />
        ))}
      </ul>
    </>
  );
}

function FooterRows({ items }: { items: readonly NavItem[] }) {
  return (
    <Suspense fallback={<FooterList items={items} current={null} />}>
      <FooterCurrent items={items} />
    </Suspense>
  );
}

function FooterCurrent({ items }: { items: readonly NavItem[] }) {
  const section = useSection();
  const tool = useSearchParams().get("tool");
  return <FooterList items={items} current={sidebarCurrent(section, tool)} />;
}

function FooterList({ items, current }: { items: readonly NavItem[]; current: string | null }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => (
        <Row key={item.key} item={item} current={current} />
      ))}
    </ul>
  );
}

function Row({ item, current }: { item: NavItem; current: string | null }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const Icon = ICONS[item.key];
  // "Credits" in the rail, "Plans & credits" here: the page holds both.
  const label = item.key === "credits" ? t.shell.plansCredits : t.nav[item.key];
  const on = current === item.key;
  return (
    <li>
      <Link href={path(item.href)} aria-current={on ? "page" : undefined} className={rowClass(on)}>
        {on && <Plate id={PLATE} />}
        <Icon aria-hidden className="shell-icon size-[18px]" strokeWidth={1.9} />
        <span className="truncate">{label}</span>
      </Link>
    </li>
  );
}
