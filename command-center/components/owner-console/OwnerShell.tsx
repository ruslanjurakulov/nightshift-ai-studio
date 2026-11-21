"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Activity, Bot, ChevronDown, Coins, LayoutDashboard, Plug, Settings, Users } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { OWNER_SECTIONS, currentOwnerSection, type OwnerSectionKey } from "@/lib/owner-console/nav";
import { AccountSwitcher } from "@/components/account/AccountSwitcher";
import { SkipLink } from "@/components/shell/SkipLink";
import "./owner-console.css";

const ICONS: Record<OwnerSectionKey, typeof Users> = {
  overview: LayoutDashboard,
  users: Users,
  revenue: Coins,
  providers: Plug,
  health: Activity,
  ai: Bot,
  settings: Settings,
};

/**
 * The Owner Console's frame: a narrow sidebar (from `lg`) with the seven sections and, at its foot, the account switcher;
 * below `lg` a top bar with the same sections as a scrolling row and the switcher behind the account button. Every
 * destination is a plain link (keyboard and middle-click work); the current one carries aria-current.
 */
export function OwnerShell({
  email,
  account = "owner",
  children,
}: {
  email: string | null;
  account?: "user" | "owner";
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const c = t.ownerConsole;
  const pathname = usePathname() ?? "/owner";
  const current = currentOwnerSection(pathname);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLElement>(null);

  // On a phone the current section can sit past the edge of the scrolling row: bring it into view (instantly, so reduced
  // motion needs nothing of its own).
  useEffect(() => {
    row.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  useEffect(() => {
    if (!open) return;
    // Escape returns focus to the button that opened it (an outside click closes without moving focus).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => menu.current && !menu.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const links = OWNER_SECTIONS.map((s) => {
    const Icon = ICONS[s.key];
    const on = s.key === current;
    return (
      <li key={s.key}>
        <Link href={s.href} className="oc-link" aria-current={on ? "page" : undefined} data-section={s.key}>
          <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
          <span>{c.nav[s.key]}</span>
        </Link>
      </li>
    );
  });

  return (
    <div className="oc-root">
      <SkipLink />
      <aside className="oc-side">
        <div className="oc-brand">
          <span className="oc-mark" aria-hidden>
            N
          </span>
          <span className="oc-brand-tx">{c.title}</span>
        </div>
        <nav aria-label={c.navLabel}>
          <ul role="list" className="oc-nav">
            {links}
          </ul>
        </nav>
        <div className="oc-foot">
          {email && <p className="oc-email">{email}</p>}
          <AccountSwitcher current={account} />
        </div>
      </aside>

      <header className="oc-top">
        <div className="oc-top-row">
          <span className="oc-brand">
            <span className="oc-mark" aria-hidden>
              N
            </span>
            <span className="oc-brand-tx">{c.title}</span>
          </span>
          <div className="relative" ref={menu}>
            <button
              ref={button}
              type="button"
              className="oc-acct"
              aria-expanded={open}
              aria-haspopup="dialog"
              aria-controls="oc-acct-pop"
              aria-label={`${c.switcher.title}: ${c.switcher.owner}`}
              onClick={() => setOpen((o) => !o)}
              data-testid="owner-account-button"
            >
              {c.switcher.owner}
              <ChevronDown aria-hidden className="size-4" />
            </button>
            {open && (
              <div className="oc-pop" id="oc-acct-pop" role="dialog" aria-label={c.switcher.title}>
                <AccountSwitcher current={account} onDone={() => setOpen(false)} />
              </div>
            )}
          </div>
        </div>
        <nav aria-label={c.navLabel} className="oc-top-nav" ref={row}>
          <ul role="list" className="oc-nav-row">
            {links}
          </ul>
        </nav>
      </header>

      <main id="main" tabIndex={-1} className="oc-main">
        {children}
      </main>
    </div>
  );
}
