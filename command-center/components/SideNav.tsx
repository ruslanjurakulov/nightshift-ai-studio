"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { ICONS } from "@/components/navigation/navIcons";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { navGroupsFor, tabsFor, type NavKey } from "@/lib/navigation";
import { useOverlay } from "@/components/a11y/useOverlay";
import { CustomerSidebar } from "@/components/shell/CustomerSidebar";
import type { AccountPlan } from "@/lib/account";

/**
 * The app's primary navigation, as a left rail — icon + label, grouped.
 *
 * The order is deliberate: the five destinations of the daily loop (make a
 * video, watch it, shape the look, follow the pipeline, read the numbers) sit
 * at the top with no group heading, the way a product surfaces its main tabs.
 * Everything else is grouped and calm below, so the rail reads as a product's
 * navigation rather than a wall of admin links. Every route is still one click
 * away, and Cmd-K still reaches them all by name.
 *
 * On wide screens it is a sticky rail; below `lg` it collapses to a button that
 * opens the same list as a left drawer.
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
  return (
    <nav className="flex flex-col gap-5">
      {navGroupsFor(operator).map((group, gi) => (
        <div key={group.label ?? `g${gi}`} className="flex flex-col gap-0.5">
          {group.label && (
            <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">
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
  plan = null,
}: {
  operator?: boolean;
  /** For the customer sidebar's user card. */
  email?: string | null;
  plan?: AccountPlan | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes, focus moves into the drawer and returns to the Menu button.
  const menuRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerId = useId();
  useOverlay(open, { onClose: () => setOpen(false), container: drawerRef, opener: menuRef });

  return (
    <>
      {/* Desktop rail. z-30 keeps it above a section panel's scrim (z-0) so the
          nav stays bright and clickable while a panel is open — clicking a
          section jumps straight there instead of the scrim closing to home. */}
      {operator ? (
        <aside className="sticky top-[72px] z-30 hidden h-[calc(100dvh-72px)] w-[236px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] px-3 py-5 lg:block">
          <NavList operator={operator} />
        </aside>
      ) : (
        <CustomerSidebar email={email} plan={plan} />
      )}

      {/* A customer's phone: the five destinations as a bottom tab bar, Studio in
          the middle and raised — where the thumb is, as phone apps do. */}
      {!operator && <BottomBar />}

      {/* Mobile trigger (operator) — a slim bar under the header */}
      {operator && (
      <div className="sticky top-[73px] z-20 flex items-center gap-2 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] px-[clamp(0.75rem,3vw,56px)] py-2 backdrop-blur-md lg:hidden">
        <button
          ref={menuRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? drawerId : undefined}
          className="btn-sky is-quiet pill inline-flex h-10 items-center gap-2 px-3 text-[13px]"
        >
          <Menu aria-hidden className="size-4" />
          {t.nav.menu}
        </button>
      </div>
      )}

      {/* Mobile drawer */}
      {operator && open && (
        <div
          ref={drawerRef}
          id={drawerId}
          className="fixed inset-0 z-50 outline-none lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t.nav.menu}
          tabIndex={-1}
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="drawer-enter absolute inset-y-0 left-0 flex w-[280px] max-w-[82vw] flex-col overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-4 shadow-[var(--shadow-elevated)]">
            <div className="mb-3 flex items-center justify-between px-2">
              <span className="font-display text-base font-semibold text-[var(--color-primary)]">
                {t.brand.name}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.ops.shortcutsClose}
                className="btn-sky is-quiet pill inline-flex size-10 items-center justify-center"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
            <NavList operator={operator} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Bottom order: Videos, Channels, Studio (centre), Credits, Settings. */
const BOTTOM_ORDER: readonly NavKey[] = ["videos", "channels", "hub", "credits", "settings"];

function BottomBar() {
  const { t } = useI18n();
  const isActive = useIsActive();
  const path = useChannelPath();
  const items = navGroupsFor(false)[0]?.items ?? [];
  const ordered = BOTTOM_ORDER.map((k) => items.find((i) => i.key === k)).filter((i) => i !== undefined);
  return (
    <nav
      aria-label={t.nav.menu}
      className="ns-tabbar fixed inset-x-0 bottom-0 z-40 pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="mx-auto grid max-w-[520px] grid-cols-5 items-end px-2 pt-1">
        {ordered.map(({ href, key }) => {
          const active = isActive(href, key);
          const Icon = ICONS[key];
          const centre = key === "hub";
          return (
            <li key={key} className="flex justify-center">
              <Link href={path(href)} aria-current={active ? "page" : undefined} className="ns-tab">
                {centre ? (
                  // Studio, standing proud of the bar where the thumb is: the lit key.
                  <span className="ns-tab-create">
                    <Icon aria-hidden className="size-[22px]" strokeWidth={2.1} />
                  </span>
                ) : (
                  <span className="ns-tab-icon">
                    <Icon aria-hidden className="size-[19px]" strokeWidth={active ? 2.2 : 1.8} />
                  </span>
                )}
                <span className="truncate">{t.nav[key]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
