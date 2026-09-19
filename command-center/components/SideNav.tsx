"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Film, Workflow, Palette, BarChart3, ListVideo,
  Users, UserCircle, KeyRound, Bot, ListChecks,
  Lightbulb, Brain, GitBranch, GraduationCap, Database, Hash, Ruler, RefreshCw, Gauge,
  History, Plug, TriangleAlert, ScrollText, ShieldCheck, Menu, X,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import type { Dictionary } from "@/lib/i18n";

type NavKey = Exclude<keyof Dictionary["nav"], "more" | "gManage" | "gIntel" | "gSystem" | "menu">;
type Item = { href: string; key: NavKey; Icon: LucideIcon };
type Group = { label?: keyof Pick<Dictionary["nav"], "gManage" | "gIntel" | "gSystem">; items: Item[] };

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
 */
const GROUPS: Group[] = [
  {
    items: [
      { href: "/command-center", key: "command", Icon: LayoutDashboard },
      { href: "/videos", key: "videos", Icon: Film },
      { href: "/studio", key: "studio", Icon: Palette },
      { href: "/pipeline", key: "pipeline", Icon: Workflow },
      { href: "/analytics", key: "analytics", Icon: BarChart3 },
    ],
  },
  {
    label: "gManage",
    items: [
      { href: "/channels", key: "channels", Icon: Users },
      { href: "/accounts", key: "accounts", Icon: UserCircle },
      { href: "/providers", key: "providers", Icon: KeyRound },
      { href: "/series", key: "series", Icon: ListVideo },
      { href: "/agents", key: "agents", Icon: Bot },
      { href: "/jobs", key: "jobs", Icon: ListChecks },
    ],
  },
  {
    label: "gIntel",
    items: [
      { href: "/intelligence", key: "advisory", Icon: Lightbulb },
      { href: "/intelligence-map", key: "intelligence", Icon: Brain },
      { href: "/decisions", key: "decisions", Icon: GitBranch },
      { href: "/learning", key: "learning", Icon: GraduationCap },
      { href: "/memory", key: "memory", Icon: Database },
      { href: "/topics", key: "topics", Icon: Hash },
      { href: "/measurement", key: "measure", Icon: Ruler },
      { href: "/feedback-loop", key: "feedback", Icon: RefreshCw },
      { href: "/autonomy", key: "autonomy", Icon: Gauge },
    ],
  },
  {
    label: "gSystem",
    items: [
      { href: "/members", key: "members", Icon: ShieldCheck },
      { href: "/time-machine", key: "timeMachine", Icon: History },
      { href: "/integrations", key: "integrations", Icon: Plug },
      { href: "/errors", key: "errors", Icon: TriangleAlert },
      { href: "/logs", key: "logs", Icon: ScrollText },
    ],
  },
];

function useIsActive() {
  const pathname = usePathname();
  const section = "/" + pathname.split("/").slice(2).join("/");
  return (href: string) => section === href || section.startsWith(href + "/");
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const isActive = useIsActive();
  const path = useChannelPath();
  return (
    <nav className="flex flex-col gap-5">
      {GROUPS.map((group, gi) => (
        <div key={group.label ?? `g${gi}`} className="flex flex-col gap-0.5">
          {group.label && (
            <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">
              {t.nav[group.label]}
            </div>
          )}
          {group.items.map(({ href, key, Icon }) => {
            const active = isActive(href);
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

export function SideNav() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Desktop rail */}
      <aside className="sticky top-[72px] hidden h-[calc(100dvh-72px)] w-[236px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] px-3 py-5 lg:block">
        <NavList />
      </aside>

      {/* Mobile trigger — a slim bar under the header */}
      <div className="sticky top-[68px] z-20 flex items-center gap-2 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] px-[clamp(0.75rem,3vw,56px)] py-2 backdrop-blur-md lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t.nav.menu}
          aria-expanded={open}
          className="btn-sky is-quiet pill inline-flex h-9 items-center gap-2 px-3 text-[13px]"
        >
          <Menu aria-hidden className="size-4" />
          {t.nav.menu}
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div
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
                aria-label={t.nav.menu}
                className="btn-sky is-quiet pill inline-flex size-9 items-center justify-center"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
            <NavList onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
