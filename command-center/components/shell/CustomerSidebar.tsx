"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AudioLines, Clapperboard, Image as ImageIcon, Languages, Mic, Play, ScanText, Scissors, Wand2, ZoomIn, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { CUSTOMER_SIDEBAR, sidebarCurrent, type NavItem, type StudioTool } from "@/lib/navigation";
import { AccountMenu } from "@/components/account/AccountMenu";
import { ICONS } from "@/components/navigation/navIcons";
import type { AccountPlan } from "@/lib/account";

const TOOL_ICONS: Record<StudioTool, LucideIcon> = {
  t2i: ImageIcon,
  t2v: Clapperboard,
  tts: Mic,
  edit: Wand2,
  i2v: Play,
  upscale: ZoomIn,
  remove_bg: Scissors,
  voice_change: AudioLines,
  dub: Languages,
  describe: ScanText,
};

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
 * Presentation only: every destination is a customer section, and the layout
 * and RLS decide what anyone may open.
 */
export function CustomerSidebar({ email, plan }: { email: string | null; plan: AccountPlan | null }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const { home, footer } = CUSTOMER_SIDEBAR;

  return (
    <aside className="shell-sidebar sticky top-0 z-30 hidden h-dvh w-[240px] shrink-0 flex-col lg:flex">
      <div className="flex h-14 shrink-0 items-center px-5">
        <Link
          href={path(home.href)}
          className="font-display text-[17px] font-semibold tracking-[-0.02em] text-[var(--color-fg)]"
        >
          <span aria-hidden className="mr-2 inline-block size-2 rounded-full bg-[var(--color-primary)] align-middle" />
          {t.brand.name}
        </Link>
      </div>

      <nav aria-label={t.shell.primary} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        <Suspense fallback={<SidebarRows current={null} />}>
          <CurrentRows />
        </Suspense>
      </nav>

      <div className="flex shrink-0 flex-col gap-0.5 border-t border-[var(--shell-border)] px-3 pb-3 pt-2">
        <FooterRows items={footer} />
        <div className="pt-2">
          <AccountMenu email={email} variant="card" plan={plan} />
        </div>
      </div>
    </aside>
  );
}

/** The rows that need the query string (the tool rows), behind Suspense. */
function CurrentRows() {
  const section = useSection();
  const tool = useSearchParams().get("tool");
  return <SidebarRows current={sidebarCurrent(section, tool)} />;
}

function SidebarRows({ current }: { current: string | null }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const { home, tools, work } = CUSTOMER_SIDEBAR;
  const HomeIcon = ICONS[home.key];
  return (
    <>
      <ul className="flex flex-col gap-0.5 pt-1">
        <li>
          <Link href={path(home.href)} aria-current={current === "hub" ? "page" : undefined} className="shell-link">
            <HomeIcon aria-hidden className="shell-icon size-[18px]" strokeWidth={1.9} />
            <span className="truncate">{t.nav[home.key]}</span>
          </Link>
        </li>
      </ul>

      <h2 className="shell-group">{t.shell.gCreate}</h2>
      <ul className="flex flex-col gap-0.5">
        {tools.map(({ tool, href }) => {
          const Icon = TOOL_ICONS[tool];
          return (
            <li key={tool}>
              <Link href={path(href)} aria-current={current === `tool:${tool}` ? "page" : undefined} className="shell-link">
                <span aria-hidden className="shell-tile" style={{ background: `var(--tool-${tool})` }}>
                  <Icon className="size-3.5" strokeWidth={2.1} />
                </span>
                <span className="truncate">{t.gen.kinds[tool]}</span>
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
  return (
    <li>
      <Link href={path(item.href)} aria-current={current === item.key ? "page" : undefined} className="shell-link">
        <Icon aria-hidden className="shell-icon size-[18px]" strokeWidth={1.9} />
        <span className="truncate">{label}</span>
      </Link>
    </li>
  );
}
