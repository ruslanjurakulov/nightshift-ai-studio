"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { resolvedTheme } from "@/lib/theme";
import { checkoutCustomData, paddleLocale } from "@/lib/paddle";
import { columnPrice, type BillingSummary, type PlanMatrix, type SubscribeAccess } from "@/lib/plans";
import { ensurePaddle, previewPrices, type PaddleEventData } from "@/lib/paddle-client";
import { entitlementText } from "@/components/pricing/PlanMatrix";

type Phase = "idle" | "opening" | "paid" | "arrived" | "slow" | "cancelled" | "error" | "load_failed";
const POLL_MS = 3000;
const POLL_TRIES = 20;

function shortDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(iso));
}

/**
 * The organization's plan on the Credits page: which plan, its status and
 * renewal (or end) date, the credits by where they came from, and — for an
 * owner/admin — either the plans to subscribe to (Paddle's overlay checkout)
 * or "Manage subscription" (Paddle's customer portal, through
 * /api/billing/portal). Nothing here grants anything: the webhook does, and
 * this component waits for the plan to show up.
 */
export function PlanPanel({
  summary,
  matrix,
  access,
  orgId,
  userId,
  email,
}: {
  summary: BillingSummary | null;
  matrix: PlanMatrix | null;
  access: SubscribeAccess;
  orgId: string;
  userId: string | null;
  email: string | null;
}) {
  const { t, locale } = useI18n();
  const p = t.plans;
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [prices, setPrices] = useState<Record<string, string> | null>(null);
  const [portal, setPortal] = useState<"idle" | "opening" | "failed" | "missing">("idle");
  const phaseRef = useRef<Phase>("idle");
  const tries = useRef(0);
  const live = Boolean(summary?.subscription?.live);

  const go = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const onEvent = useCallback(
    (e: PaddleEventData) => {
      if (e.name === "checkout.loaded" && phaseRef.current === "opening") go("idle");
      else if (e.name === "checkout.completed") {
        tries.current = 0;
        go("paid");
      } else if (e.name === "checkout.closed" && !["paid", "arrived", "slow"].includes(phaseRef.current)) go("cancelled");
      else if (e.name === "checkout.error") go("error");
    },
    [go],
  );

  const environment = matrix?.paddle?.environment ?? null;
  const clientToken = matrix?.paddle?.clientToken ?? null;
  const priceKey = (matrix?.columns ?? []).flatMap((c) => (c.priceId ? [c.priceId] : [])).join(",");
  useEffect(() => {
    if (access !== "allowed" || !environment || !clientToken || !priceKey) return;
    let alive = true;
    ensurePaddle({ environment, clientToken }, onEvent)
      .then((pd) => previewPrices(pd, priceKey.split(",")))
      .then((out) => {
        if (alive) setPrices(out);
      })
      .catch(() => {
        // Prices then read "at checkout"; the checkout itself still opens.
      });
    return () => {
      alive = false;
    };
  }, [access, environment, clientToken, priceKey, onEvent]);

  // After payment: re-read the page until the webhook's subscription shows up.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (phase !== "paid") return;
    if (live) {
      go("arrived");
      return;
    }
    if (tries.current >= POLL_TRIES) {
      go("slow");
      return;
    }
    const timer = setTimeout(() => {
      tries.current += 1;
      router.refresh();
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [phase, live, tick, router, go]);

  async function subscribe(priceId: string) {
    if (!environment || !clientToken || phaseRef.current === "opening") return;
    go("opening");
    setTimeout(() => {
      if (phaseRef.current === "opening") go("idle");
    }, 15_000);
    try {
      const paddle = await ensurePaddle({ environment, clientToken }, onEvent);
      paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        customData: checkoutCustomData(orgId, userId),
        ...(email ? { customer: { email } } : {}),
        settings: { displayMode: "overlay", theme: resolvedTheme(), locale: paddleLocale(locale), allowLogout: false, variant: "one-page" },
      });
    } catch {
      go("load_failed");
    }
  }

  async function manage() {
    setPortal("opening");
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
      if (res.ok && typeof data.url === "string") {
        // Same tab: a window opened after an await is what popup blockers stop.
        window.location.assign(data.url);
        return;
      }
      setPortal(data.error === "portal_not_configured" ? "missing" : "failed");
    } catch {
      setPortal("failed");
    }
  }

  const sub = summary?.subscription ?? null;
  const planName = summary?.plan?.name ?? "—";
  const statusText = sub ? p.status[sub.status] : null;
  const dateLine = !sub
    ? null
    : sub.status === "canceled" || sub.cancelAtPeriodEnd
      ? fmt(p.endsOn, { date: shortDate(sub.periodEnd, locale) })
      : fmt(p.renews, { date: shortDate(sub.periodEnd, locale) });
  const c = summary?.credits;
  const message: Partial<Record<Phase, { text: string; ok?: boolean }>> = {
    paid: { text: p.paid, ok: true },
    arrived: { text: p.arrived, ok: true },
    slow: { text: p.slow },
    cancelled: { text: t.credits.buy.cancelled },
    error: { text: t.credits.buy.checkoutError },
    load_failed: { text: t.credits.buy.loadFailed },
  };
  const msg = message[phase];

  return (
    <section id="plans" className="panel flex scroll-mt-24 flex-col gap-4 p-4" aria-labelledby="plan-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="plan-title" className="t-section">
          {p.panelTitle} · <span className="font-light">{planName}</span>
        </h2>
        {statusText && (
          <span
            className="mono pill px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]"
            style={{ color: sub?.status === "past_due" ? "var(--color-warn)" : "var(--color-muted)" }}
          >
            {statusText}
          </span>
        )}
      </div>
      {dateLine && <p className="text-[13px] text-[var(--color-muted)]">{dateLine}</p>}
      {sub?.status === "past_due" && <p className="text-[13px] text-[var(--color-warn)]">{p.pastDue}</p>}

      {c && (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] p-3">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">{p.planCredits}</dt>
            <dd className="mono text-[18px]">{formatCredits(c.subscription, locale)}</dd>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] p-3">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">{p.topupCredits}</dt>
            <dd className="mono text-[18px]">{formatCredits(c.pack, locale)}</dd>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] p-3">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">{p.otherCredits}</dt>
            <dd className="mono text-[18px]">{formatCredits(c.other, locale)}</dd>
          </div>
        </dl>
      )}
      <div className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
        {summary?.nextExpiry && (
          <span>
            {fmt(p.nextExpiry, {
              n: formatCredits(summary.nextExpiry.credits, locale),
              date: shortDate(summary.nextExpiry.at, locale),
            })}
          </span>
        )}
        {summary?.runSlots && summary.runSlots.limit !== null && (
          <span>{fmt(p.runSlots, { active: summary.runSlots.active, limit: summary.runSlots.limit })}</span>
        )}
        <span>{p.spendOrder}</span>
      </div>

      {access === "manage" && (
        <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
          <button
            type="button"
            onClick={manage}
            disabled={portal === "opening"}
            className="btn-sky pill self-start px-5 py-2 text-[13px] disabled:opacity-40"
          >
            {portal === "opening" ? p.manageOpening : p.manage}
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
          <p className="text-[12px] text-[var(--color-muted)]">{p.manageHint}</p>
          <p className="text-[12px] text-[var(--color-muted)]">{p.changePlanNote}</p>
          {portal === "failed" && <p className="text-[12px] text-[var(--color-fail)]">{p.manageFailed}</p>}
          {portal === "missing" && <p className="text-[12px] text-[var(--color-muted)]">{p.managePortalMissing}</p>}
        </div>
      )}

      {access === "admin_only" && <p className="text-[13px] text-[var(--color-muted)]">{p.adminOnly}</p>}

      {access === "allowed" && matrix && (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
          <p className="text-[12px] text-[var(--color-muted)]">{p.subscribeHint}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {matrix.columns
              .filter((col) => !col.isDefault && col.priceId)
              .map((col) => {
                const i = matrix.columns.indexOf(col);
                const price = columnPrice(col, prices, prices === null);
                return (
                  <div key={col.id} className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] p-4">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">{col.name}</span>
                    <span className="mono text-[18px]">
                      {fmt(p.monthlyCredits, { n: formatCredits(col.monthlyCredits, locale) })}
                    </span>
                    <span className="text-[12px] text-[var(--color-muted)]">
                      {price.kind === "preview" || price.kind === "display"
                        ? `${price.text} ${p.perMonth}`
                        : t.pricing.priceAtCheckout}
                    </span>
                    <ul className="flex flex-col gap-0.5 text-[11px] text-[var(--color-muted)]">
                      {matrix.rows.map((row) => (
                        <li key={row.key}>
                          {(p.row as Record<string, string>)[row.key] ?? row.key}:{" "}
                          {entitlementText(row.key, row.type, row.cells[i], t)}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => col.priceId && subscribe(col.priceId)}
                      disabled={phase === "opening"}
                      className="btn-sky is-solid pill mt-1 px-5 py-2 text-[13px] disabled:opacity-40"
                    >
                      {phase === "opening" ? t.credits.buy.opening : p.subscribe}
                    </button>
                  </div>
                );
              })}
          </div>
          <p className="text-[11px] text-[var(--color-muted)]">{p.renewalTerms}</p>
        </div>
      )}

      {msg && (
        <p className="text-[12px]" style={{ color: msg.ok ? "var(--color-ok)" : "var(--color-muted)" }} aria-live="polite">
          {msg.text}
        </p>
      )}
    </section>
  );
}
