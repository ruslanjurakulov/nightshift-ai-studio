"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ellipsis } from "lucide-react";
import { ICONS } from "@/components/navigation/navIcons";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { ALL_SECTIONS, CUSTOMER_RAIL, HOME, OPERATOR_TABS, navGroupsFor, operatorTabCurrent, tabsFor, type NavKey, type OperatorTab } from "@/lib/navigation";
import { CustomerSidebar } from "@/components/shell/CustomerSidebar";
import { useShell } from "@/components/shell/ShellContext";
import { type AccountPlan } from "@/lib/account";
import { nav as MNav } from "motion/react-m";
import { Plate, SharedLayout } from "@/components/motion/SharedLayout";

/**
 * The app's primary navigation, as a left rail — icon + label, grouped.
 *
 * The order is deliberate: the daily loop (the Command Center, Nightshift
 * Studio — every creative tool behind one entry — the Inbox and Analytics) sits
 * at the top with no group heading, the way a product surfaces its main tabs.
 * Everything else is grouped and calm below, so the rail reads as a product's
 * navigation rather than a wall of admin links. Every route is still one click
 * away, and Cmd-K still reaches them all by name.
 *
 * On wide screens it is a sticky rail. Below `lg` the operator gets a bottom
 * tab bar (OperatorBottomBar: Home, Studio, Billing, Alerts and More, where
 * More is a visible page listing every section) — never a hamburger or a drawer
 * hiding the main navigation.
 *
 * The routes and their order live in lib/navigation (the breadcrumbs and tab
 * titles read them too); the icons are shared (navigation/navIcons).
 *
 * That rail is the operator's. A customer gets the creative-app sidebar
 * (shell/CustomerSidebar) on wide screens and the bottom bar on a phone.
 */
export { ICONS };

/** Is a rail entry the current place? Studio and Settings also own their tabs' screens. */
export function useIsActive() {
  const pathname = usePathname();
  const section = "/" + pathname.split("/").slice(2).join("/");
  const group = tabsFor(pathname.split("/")[2] ?? "")?.rail;
  return (href: string, key?: NavKey) =>
    section === href || section.startsWith(href + "/") || (key !== undefined && key === group);
}

function NavList({ operator, onNavigate }: { operator: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  const isActive = useIsActive();
  const path = useChannelPath();
  // A section behind a server-side switch (Ads) is in the rail only while the layout says that switch is on.
  const { features } = useShell();
  return (
    <nav className="flex flex-col gap-5">
      {navGroupsFor(operator, features).map((group, gi) => (
        <div key={group.label ?? `g${gi}`} className="flex flex-col gap-0.5">
          {group.label && (
            <div className="px-3 pb-1 pt-1 text-xs font-semibold text-[var(--color-muted)]">
              {t.nav[group.label]}
            </div>
          )}
          {group.items.map(({ href, key }) => {
            const active = isActive(href, key);
            const Icon = ICONS[key];
            return (
              <Link
                key={href}
                href={path(href)}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                data-active={active ? "true" : undefined}
                className="side-link"
              >
                <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={active ? 2.25 : 1.75} />
                <span className="truncate">{t.nav[key]}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * `operator` is the platform owner/admin (lib/auth/org-roles.ts isOperator):
 * they get the full console. Everyone else gets the customer's lean rail
 * (lib/navigation.ts CUSTOMER_NAV_KEYS). Presentation only — the layout
 * redirects operator-only URLs, and RLS and each route guard the data.
 */
export function SideNav({
  operator = false,
  email = null,
  avatarV = null,
  plan = null,
}: {
  operator?: boolean;
  /** For the customer sidebar's user card. */
  email?: string | null;
  /** The photo's version (avatar_v), or null for none. */
  avatarV?: number | null;
  plan?: AccountPlan | null;
}) {
  const pathname = usePathname();
  const path = useChannelPath();
  // On Nightshift Studio the sidebar steps back to a 76px icon rail, so the canvas gets the width (one workspace).
  const studio = pathname === path("/studio");
  return (
    <>
      {studio ? (
        <StudioRail operator={operator} />
      ) : (
      <>
      {/* Desktop rail. z-30 keeps it above a section panel's scrim (z-0) so the
          nav stays bright and clickable while a panel is open — clicking a
          section jumps straight there instead of the scrim closing to home. */}
      {operator ? (
        <aside className="sticky top-[72px] z-30 hidden h-[calc(100dvh-72px)] w-[236px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] px-3 py-5 lg:block">
          <NavList operator={operator} />
        </aside>
      ) : (
        <CustomerSidebar email={email} avatarV={avatarV} plan={plan} />
      )}
      </>
      )}

      {/* A customer's phone: the five destinations as a bottom tab bar, Studio in
          the middle and raised — where the thumb is, as phone apps do. */}
      {!operator && <BottomBar />}

      {/* The owner's phone: the same bottom-bar idea, with the owner's five destinations. */}
      {operator && <OperatorBottomBar />}
    </>
  );
}

/**
 * The Studio's rail (the prototype's): the daily destinations as icon + short label, 76px wide, the current one marked
 * with the amber bar. The operator's ends in Admin (the page listing every section); a customer's is their five
 * destinations. From `lg` up; below that the bottom tab bar is the rail.
 */
function StudioRail({ operator }: { operator: boolean }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const isActive = useIsActive();
  const r = t.studioCanvas.rail;
  const items: { href: string; key: NavKey; label: string }[] = operator
    ? [
        { href: HOME, key: "command", label: r.command },
        { href: "/studio", key: "studio", label: r.studio },
        { href: "/inbox", key: "inbox", label: r.inbox },
        { href: "/analytics", key: "analytics", label: r.analytics },
      ]
    : CUSTOMER_RAIL.map((i) => ({ href: i.href, key: i.key, label: i.key in r ? r[i.key as keyof typeof r] : t.nav[i.key] }));
  return (
    <nav aria-label={r.label} className={operator ? "cv-rail is-operator" : "cv-rail"} data-studio-rail="">
      <Link href={path(items[0].href)} className="cv-rail-logo" aria-label={t.brand.name} title={t.brand.name}>
        N
      </Link>
      {items.map(({ href, key, label }) => {
        const Icon = ICONS[key];
        const active = isActive(href, key);
        return (
          <Link key={href} href={path(href)} aria-current={active ? "page" : undefined} title={t.nav[key]}>
            <Icon aria-hidden className="size-5" strokeWidth={1.8} />
            <span className="cv-rail-label">{label}</span>
          </Link>
        );
      })}
      <span className="cv-rail-sp" />
      {operator && (
        <Link href={path(ALL_SECTIONS)} title={t.nav.allSections}>
          <Ellipsis aria-hidden className="size-5" strokeWidth={1.8} />
          <span className="cv-rail-label">{r.admin}</span>
        </Link>
      )}
    </nav>
  );
}

/**
 * Bottom order: Home, Trends, Create (centre, raised), Projects, Library: the rail's five, with making where the thumb is.
 * Credits and the account are the top bar's credit pill and avatar on a phone.
 */
const BOTTOM_ORDER: readonly NavKey[] = ["home", "trends", "create", "projects", "library"];

function BottomBar() {
  const { t } = useI18n();
  const isActive = useIsActive();
  const path = useChannelPath();
  const items = navGroupsFor(false)[0]?.items ?? [];
  const ordered = BOTTOM_ORDER.map((k) => items.find((i) => i.key === k)).filter((i) => i !== undefined);
  return (
    <SharedLayout id="customer-tabbar">
      {/* layoutRoot: the bar is fixed to the viewport, so the tab plate measures
          against the bar, not against how far the page has scrolled. */}
      <MNav
        layoutRoot
        aria-label={t.nav.menu}
        className="ns-tabbar fixed inset-x-0 bottom-0 z-40 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="mx-auto grid max-w-[520px] grid-cols-5 items-end px-2 pt-1">
          {ordered.map(({ href, key }) => {
            const active = isActive(href, key);
            const Icon = ICONS[key];
            const centre = key === "create";
            return (
              <li key={key} className="flex justify-center">
                <Link href={path(href)} aria-current={active ? "page" : undefined} className="ns-tab">
                  {centre ? (
                    // Studio, standing proud of the bar where the thumb is: the lit key.
                    <span className="ns-tab-create">
                      <Icon aria-hidden className="size-[22px]" strokeWidth={2.1} />
                    </span>
                  ) : (
                    // The selection tint is one plate that slides to the tab you tap.
                    <span className={active ? "ns-tab-icon ns-plate-host" : "ns-tab-icon"}>
                      {active && <Plate id="tab-current" className="is-tab" />}
                      <Icon aria-hidden className="size-[19px]" strokeWidth={active ? 2.2 : 1.8} />
                    </span>
                  )}
                  <span className="truncate">{t.nav[key]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </MNav>
    </SharedLayout>
  );
}

/**
 * The platform owner's phone bar: five visible tabs, no drawer. Home first (money, failures and what waits
 * for them at a glance), then Studio (the videos and every creative tool), Billing and Alerts, and More: a tab to the page listing every section
 * (app/(app)/[channel]/sections), so no screen is hidden behind a button. Hidden from `lg`, where the rail
 * shows the whole list. The same bar chrome, tabs and sliding plate as the customer's (BottomBar).
 */
function OperatorBottomBar() {
  const { t } = useI18n();
  const pathname = usePathname();
  const path = useChannelPath();
  const current = operatorTabCurrent("/" + pathname.split("/").slice(2).join("/"));
  const label: Record<OperatorTab["key"], string> = {
    home: t.ownerShell.tabHome,
    studio: t.ownerShell.tabStudio,
    billing: t.ownerShell.tabBilling,
    alerts: t.ownerShell.tabAlerts,
    more: t.ownerShell.tabMore,
  };
  return (
    <SharedLayout id="operator-tabbar">
      <MNav
        layoutRoot
        aria-label={t.ownerShell.tabsLabel}
        data-operator-tabbar=""
        className="ns-tabbar fixed inset-x-0 bottom-0 z-40 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="mx-auto grid max-w-[520px] grid-cols-5 items-end px-1 pt-1">
          {OPERATOR_TABS.map(({ href, key, icon }) => {
            const active = current === key;
            const Icon = icon === "sections" ? Ellipsis : ICONS[icon];
            return (
              <li key={key} className="flex justify-center">
                <Link href={path(href)} aria-current={active ? "page" : undefined} className="ns-tab w-full min-w-0">
                  <span className={active ? "ns-tab-icon ns-plate-host" : "ns-tab-icon"}>
                    {active && <Plate id="tab-current" className="is-tab" />}
                    <Icon aria-hidden className="size-[19px]" strokeWidth={active ? 2.2 : 1.8} />
                  </span>
                  <span className="max-w-full truncate px-0.5">{label[key]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </MNav>
    </SharedLayout>
  );
}
