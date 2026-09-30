"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, Coins, LogOut, Settings, UserRound, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt, LOCALES } from "@/lib/i18n";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits } from "@/lib/credits";
import {
  coerceAccountSummary,
  type AccountPlan,
  type AccountSummary,
  type ConnectedAccount,
  type Platform,
} from "@/lib/account";

/**
 * The account button in the header and the panel it opens: who is signed in,
 * their plan and credits, the publishing accounts connected to the workspace,
 * and the ways out (buy credits, settings, sign out).
 *
 * The panel reads GET /api/account each time it opens — the user's own
 * session, RLS-scoped, read-only. It shows what came back and "—" for
 * anything that did not; it never fills a gap with a guess.
 *
 * Keyboard: Escape closes and returns focus to the button; Tab stays inside
 * the panel while it is open. Below `sm` it is a full-width sheet under the
 * header; above, a popover anchored to the button.
 */
export function AccountMenu({ email }: { email: string | null }) {
  const { t, locale, setLocale } = useI18n();
  const path = useChannelPath();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AccountSummary | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const panelId = useId();

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Fresh numbers on every open: a purchase or a finished run changes them.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setState("loading");
    fetch("/api/account", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const summary = coerceAccountSummary(await res.json());
        if (!summary) throw new Error("malformed");
        if (live) {
          setData(summary);
          setState("ready");
        }
      })
      .catch(() => {
        if (live) setState("failed");
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Focus into the panel on open; Escape, outside clicks and Tab wrapping.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.focus();
    function focusables(): HTMLElement[] {
      return panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
          )
        : [];
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panel?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);

  async function signOut() {
    const supabase = createClient();
    if (supabase) await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const shownEmail = data?.email ?? email;
  const initial = shownEmail ? shownEmail.trim().charAt(0).toUpperCase() : null;
  const dash = t.common.dash;
  const credits = data?.credits ?? null;
  // The operator's own organization is never charged, so it has no credit
  // numbers to show; neither does an account whose plan could not be read and
  // that has no credit account. Anything else shows its numbers, or "—".
  const showCredits =
    state !== "ready" || (data?.plan.kind !== "exempt" && !(data?.plan.kind === "unknown" && !credits));

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t.account.open}
        title={shownEmail ?? undefined}
        className="btn-sky is-quiet pill inline-flex size-10 items-center justify-center p-0"
      >
        {initial ? (
          <span aria-hidden className="text-[14px] font-medium text-[var(--color-primary)]">
            {initial}
          </span>
        ) : (
          <UserRound aria-hidden className="size-4" />
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="drawer-enter absolute right-0 top-full z-50 mt-3 flex max-h-[calc(100dvh-110px)] w-[min(360px,calc(100vw-24px))] flex-col gap-4 overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-[var(--shadow-elevated)] outline-none"
        >
          <header className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[15px] font-medium text-[var(--color-primary)]"
            >
              {initial ?? <UserRound className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
                {t.account.title}
              </h2>
              <p className="truncate text-[14px] text-[var(--color-fg)]" title={shownEmail ?? undefined}>
                <span className="sr-only">{t.account.signedInAs} </span>
                {shownEmail ?? dash}
              </p>
            </div>
            <button
              type="button"
              onClick={() => close()}
              aria-label={t.account.close}
              className="btn-sky is-quiet pill inline-flex size-10 shrink-0 items-center justify-center p-0"
            >
              <X aria-hidden className="size-4" />
            </button>
          </header>

          {state === "failed" && (
            <p role="status" className="text-[12px] text-[var(--color-warn)]">
              {t.account.loadFailed}
            </p>
          )}

          <dl className="grid grid-cols-2 gap-2" aria-busy={state === "loading"}>
            <Stat label={t.account.plan} wide>
              {state === "ready" && data ? planLabel(data.plan, t) : state === "loading" ? t.account.loading : dash}
              {state === "ready" && data && planDetail(data.plan, t, locale) && (
                <span className="mt-0.5 block text-[10px] font-normal text-[var(--color-muted)]">
                  {planDetail(data.plan, t, locale)}
                </span>
              )}
            </Stat>
            {showCredits && (
              <>
                <Stat label={t.account.remaining}>
                  <span className="mono">{credits ? formatCredits(credits.available, locale) : dash}</span>
                  {credits && credits.reserved > 0 && (
                    <span className="mt-0.5 block text-[10px] font-normal text-[var(--color-muted)]">
                      {fmt(t.account.onHold, { n: formatCredits(credits.reserved, locale) })}
                    </span>
                  )}
                  {credits && credits.fromPlan !== null && credits.fromTopups !== null && (
                    <span className="mt-0.5 block text-[10px] font-normal text-[var(--color-muted)]">
                      {fmt(t.account.bySource, {
                        plan: formatCredits(credits.fromPlan, locale),
                        topups: formatCredits(credits.fromTopups, locale),
                      })}
                    </span>
                  )}
                </Stat>
                <Stat label={t.account.spent}>
                  <span className="mono">
                    {credits && credits.spent !== null ? formatCredits(credits.spent, locale) : dash}
                  </span>
                </Stat>
              </>
            )}
          </dl>

          <section aria-label={t.account.accounts} className="flex flex-col gap-1.5">
            <h3 className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">{t.account.accounts}</h3>
            <ul className="flex flex-col gap-1">
              {rows(state === "ready" ? (data?.accounts ?? []) : null).map((row) =>
                row.kind === "account" ? (
                  <AccountRow key={`${row.account.platform}:${row.account.id}`} account={row.account} />
                ) : (
                  <PlaceholderRow
                    key={`p:${row.platform}`}
                    platform={row.platform}
                    connectable={
                      row.platform === "youtube" ||
                      (state === "ready" && Boolean(data?.connectable[row.platform]))
                    }
                    status={state === "ready" ? "ready" : state === "failed" ? "failed" : "loading"}
                    onNavigate={() => close(false)}
                  />
                ),
              )}
            </ul>
          </section>

          {/* Language and theme live here on a phone; the header bar has room for
              them from `sm` up. */}
          <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3 sm:hidden">
            <div role="group" aria-label={t.common.language} className="flex gap-1.5">
              {LOCALES.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  lang={l.code}
                  aria-pressed={l.code === locale}
                  onClick={() => l.code !== locale && setLocale(l.code)}
                  className="btn-sky is-quiet pill h-10 flex-1 px-2 text-[13px] font-light"
                  style={{ color: l.code === locale ? "var(--color-primary)" : undefined }}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <ThemeToggle showLabel />
          </div>

          <nav className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-3">
            <Link href={path("/credits")} onClick={() => close(false)} className="side-link">
              <Coins aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
              <span>{t.account.buyCredits}</span>
            </Link>
            <Link href={path("/organization")} onClick={() => close(false)} className="side-link">
              <Settings aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
              <span>{t.account.settings}</span>
            </Link>
            <button type="button" onClick={signOut} className="side-link w-full text-left">
              <LogOut aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
              <span>{t.common.signOut}</span>
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}

type Dict = ReturnType<typeof useI18n>["t"];

function planLabel(plan: AccountPlan, t: Dict): string {
  switch (plan.kind) {
    case "plan":
      return plan.name;
    case "exempt":
      return t.account.planExempt;
    default:
      return t.common.dash;
  }
}

/** "Renews 1 Nov" / "Ends 1 Nov" / "Payment failed" under the plan name; null for Free. */
function planDetail(plan: AccountPlan, t: Dict, locale: string): string | null {
  if (plan.kind !== "plan" || !plan.status) return null;
  if (plan.status === "past_due") return t.plans.status.past_due;
  if (!plan.periodEnd) return t.plans.status[plan.status];
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(plan.periodEnd));
  return plan.status === "canceled" || plan.cancelAtPeriodEnd ? fmt(t.plans.endsOn, { date }) : fmt(t.plans.renews, { date });
}

const PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

type Row = { kind: "account"; account: ConnectedAccount } | { kind: "placeholder"; platform: Platform };

/** Real rows first, in platform order; a platform with none gets one placeholder. */
function rows(accounts: ConnectedAccount[] | null): Row[] {
  const out: Row[] = [];
  for (const platform of PLATFORMS) {
    const mine = (accounts ?? []).filter((a) => a.platform === platform);
    if (mine.length === 0) out.push({ kind: "placeholder", platform });
    else for (const account of mine) out.push({ kind: "account", account });
  }
  return out;
}

function Stat({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 ${wide ? "col-span-2" : ""}`}
    >
      <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium text-[var(--color-fg)]">{children}</dd>
    </div>
  );
}

function PlatformGlyph({ platform }: { platform: Platform }) {
  // Plain marks, not brand logos: a rounded tile with the platform's initial.
  const letter = platform === "youtube" ? "YT" : platform === "instagram" ? "IG" : "TT";
  return (
    <span
      aria-hidden
      className="mono flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[10px] text-[var(--color-muted)]"
    >
      {letter}
    </span>
  );
}

const PLATFORM_NAME: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

function AccountRow({ account }: { account: ConnectedAccount }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-1.5">
      {account.avatarUrl ? (
        // A public avatar from the platform; not proxied through next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={account.avatarUrl}
          alt=""
          width={32}
          height={32}
          referrerPolicy="no-referrer"
          className="size-8 shrink-0 rounded-full border border-[var(--color-border)] object-cover"
        />
      ) : (
        <PlatformGlyph platform={account.platform} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-[var(--color-fg)]">{account.name}</p>
        <p className="text-[10px] text-[var(--color-muted)]">{PLATFORM_NAME[account.platform]}</p>
      </div>
      {account.connected ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-ok)]">
          <CircleCheck aria-hidden className="size-4" />
          {t.account.connected}
        </span>
      ) : (
        <span className="shrink-0 text-[11px] text-[var(--color-muted)]">{t.account.notConnected}</span>
      )}
    </li>
  );
}

function PlaceholderRow({
  platform,
  connectable,
  status,
  onNavigate,
}: {
  platform: Platform;
  /** Instagram / TikTok: the deployment has the platform's app keys (0028). */
  connectable: boolean;
  /** Before the data arrives, or when it failed, nothing is claimed about YouTube. */
  status: "loading" | "failed" | "ready";
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const path = useChannelPath();
  const youtube = platform === "youtube";
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-1.5">
      <PlatformGlyph platform={platform} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-[var(--color-fg)]">{PLATFORM_NAME[platform]}</p>
        <p className="text-[10px] text-[var(--color-muted)]">
          {!youtube
            ? connectable
              ? t.account.notConnected
              : t.account.comingSoon
            : status === "ready"
              ? t.account.noYoutube
              : status === "loading"
                ? t.account.loading
                : t.common.dash}
        </p>
      </div>
      {youtube || connectable ? (
        status === "ready" && (
          <Link href={path("/channels")} onClick={onNavigate} className="btn-sky is-quiet pill shrink-0 px-3 py-1 text-[11px]">
            {t.account.connect}
          </Link>
        )
      ) : (
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={t.account.comingSoon}
          className="btn-sky is-quiet pill shrink-0 px-3 py-1 text-[11px] opacity-50"
        >
          {t.account.connect}
        </button>
      )}
    </li>
  );
}
