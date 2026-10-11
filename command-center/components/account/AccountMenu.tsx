"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Activity, Coins, Gift, LogOut, Settings, UserRound, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt, LOCALES } from "@/lib/i18n";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ViewModeToggle } from "@/components/view-mode/ViewModeToggle";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits } from "@/lib/credits";
import { accountInitial, planName, type AccountPlan } from "@/lib/account";
import { ConnectedAccountsList, planDetail, planLabel, useAccountSummary, useSignOut } from "@/components/account/AccountParts";

/**
 * The account panel and the button that opens it: the sidebar's user card
 * (customers, from `lg`) and the operator's round avatar in the top bar. A
 * customer's phone has no button: its bottom bar's last tab is Settings, whose
 * Account section (AccountSection) shows the same facts and controls.
 *
 * The panel: who is signed in,
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
export function AccountMenu({
  email,
  variant = "button",
  plan = null,
}: {
  email: string | null;
  /** "card": the customer sidebar's user card (initial, email, plan), opening
   *  upward from the foot of the sidebar. "button": the round avatar in the bar. */
  variant?: "button" | "card";
  /** The plan the layout read server-side, for the card's second line. */
  plan?: AccountPlan | null;
}) {
  const { t, locale, setLocale } = useI18n();
  const path = useChannelPath();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const panelId = useId();

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Fresh numbers on every open: a purchase or a finished run changes them.
  const { data, state } = useAccountSummary(open);

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

  const signOut = useSignOut();

  const shownEmail = data?.email ?? email;
  const initial = accountInitial(shownEmail);
  const dash = t.common.dash;
  const credits = data?.credits ?? null;
  // The operator's own organization is never charged, so it has no credit
  // numbers to show; neither does an account whose plan could not be read and
  // that has no credit account. Anything else shows its numbers, or "—".
  const showCredits =
    state !== "ready" || (data?.plan.kind !== "exempt" && !(data?.plan.kind === "unknown" && !credits));
  const card = variant === "card";
  // The fresh read wins when it knows the plan; a failed one does not erase
  // what the layout read moments ago.
  const cardPlan = planName(data && data.plan.kind !== "unknown" ? data.plan : plan, t.account.planExempt);

  return (
    <div className="relative">
      {card ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={t.account.open}
          title={shownEmail ?? undefined}
          data-shell-usercard=""
          className="flex w-full items-center gap-2.5 rounded-[12px] border border-[var(--shell-border)] bg-[var(--color-panel)] p-2 text-left transition-colors hover:bg-[var(--color-hover)] aria-expanded:bg-[var(--color-hover)]"
        >
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-sm font-semibold text-[var(--color-primary)]"
          >
            {initial ?? <UserRound className="size-4" />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-medium text-[var(--color-fg)]">{shownEmail ?? dash}</span>
            {cardPlan && <span className="truncate text-xs text-[var(--color-muted)]">{cardPlan}</span>}
          </span>
        </button>
      ) : (
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
          <span aria-hidden className="text-sm font-medium text-[var(--color-primary)]">
            {initial}
          </span>
        ) : (
          <UserRound aria-hidden className="size-4" />
        )}
      </button>
      )}

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={`${card ? "sheet-enter" : "drawer-enter"} absolute z-50 flex ${card ? "bottom-full left-0 mb-2 max-h-[calc(100dvh-96px)]" : "right-0 top-full mt-3 max-h-[calc(100dvh-110px)]"} w-[min(360px,calc(100vw-24px))] flex-col gap-4 overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-[var(--shadow-elevated)] outline-none`}
        >
          <header className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[15px] font-medium text-[var(--color-primary)]"
            >
              {initial ?? <UserRound className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-xs text-[var(--color-muted)]">
                {t.account.title}
              </h2>
              <p className="truncate text-sm text-[var(--color-fg)]" title={shownEmail ?? undefined}>
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
            <p role="status" className="text-xs text-[var(--color-warn)]">
              {t.account.loadFailed}
            </p>
          )}

          <dl className="grid grid-cols-2 gap-2" aria-busy={state === "loading"}>
            <Stat label={t.account.plan} wide>
              {state === "ready" && data ? planLabel(data.plan, t) : state === "loading" ? t.account.loading : dash}
              {state === "ready" && data && planDetail(data.plan, t, locale) && (
                <span className="mt-0.5 block text-xs font-normal text-[var(--color-muted)]">
                  {planDetail(data.plan, t, locale)}
                </span>
              )}
            </Stat>
            {showCredits && (
              <>
                <Stat label={t.account.remaining}>
                  <span className="tnum">{credits ? formatCredits(credits.available, locale) : dash}</span>
                  {credits && credits.reserved > 0 && (
                    <span className="mt-0.5 block text-xs font-normal text-[var(--color-muted)]">
                      {fmt(t.account.onHold, { n: formatCredits(credits.reserved, locale) })}
                    </span>
                  )}
                  {credits && credits.fromPlan !== null && credits.fromTopups !== null && (
                    <span className="mt-0.5 block text-xs font-normal text-[var(--color-muted)]">
                      {fmt(t.account.bySource, {
                        plan: formatCredits(credits.fromPlan, locale),
                        topups: formatCredits(credits.fromTopups, locale),
                      })}
                    </span>
                  )}
                </Stat>
                <Stat label={t.account.spent}>
                  <span className="tnum">
                    {credits && credits.spent !== null ? formatCredits(credits.spent, locale) : dash}
                  </span>
                </Stat>
              </>
            )}
          </dl>

          <section aria-label={t.account.accounts} className="flex flex-col gap-1.5">
            <h3 className="text-xs text-[var(--color-muted)]">{t.account.accounts}</h3>
            <ConnectedAccountsList data={data} state={state} onNavigate={() => close(false)} />
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
                  className="btn-sky is-quiet pill h-10 flex-1 px-2 text-sm font-light"
                  style={{ color: l.code === locale ? "var(--color-primary)" : undefined }}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <ThemeToggle showLabel />
            <ViewModeToggle showLabel />
          </div>

          <nav className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-3">
            <Link href={path("/usage")} onClick={() => close(false)} className="side-link">
              <Activity aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
              <span>{t.account.usage}</span>
            </Link>
            <Link href={path("/credits")} onClick={() => close(false)} className="side-link">
              <Coins aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
              <span>{t.account.buyCredits}</span>
            </Link>
            <Link href={path("/credits") + "#invite"} onClick={() => close(false)} className="side-link">
              <Gift aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
              <span>{t.account.inviteFriends}</span>
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

function Stat({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 ${wide ? "col-span-2" : ""}`}
    >
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium text-[var(--color-fg)]">{children}</dd>
    </div>
  );
}
