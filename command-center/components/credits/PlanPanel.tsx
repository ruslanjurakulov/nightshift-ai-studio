"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { resolvedTheme } from "@/lib/theme";
import { checkoutCustomData, paddleLocale } from "@/lib/paddle";
import { columnPrice, type BillingSummary, type GenerationRates, type PlanMatrix, type SubscribeAccess } from "@/lib/plans";
import { ensurePaddle, previewPrices, type PaddleEventData } from "@/lib/paddle-client";
import { ErrorState } from "@/components/ReadError";
import { entitlementText } from "@/components/pricing/PlanMatrix";
import { Equivalents, shortDate } from "@/components/credits/Equivalents";
import { Chip } from "@/components/ui/Chip";
import { PriceButton } from "@/components/ui/PriceButton";
import { Timecode } from "@/components/ui/Timecode";

/** A "{n} credits a month" line with its figure in the counter face. */
function withFigure(template: string, value: number, locale: string) {
  const [before, after = ""] = template.split("{n}");
  return (
    <>
      {before}
      <Timecode value={value} locale={locale} />
      {after}
    </>
  );
}

type Phase = "idle" | "opening" | "paid" | "arrived" | "slow" | "cancelled" | "error" | "load_failed";
const POLL_MS = 3000;
const POLL_TRIES = 20;

/**
 * The organization's plan on the Credits page: which plan, its status and
 * renewal (or end) date, the plans as cards (monthly credits, what they buy at
 * today's prices, what each unlocks), and — for an owner/admin — either
 * Subscribe (Paddle's overlay checkout) or "Manage subscription" (Paddle's
 * customer portal, through /api/billing/portal). The renewal, cancellation
 * and refund terms sit above the buttons, so they are read before a checkout
 * opens. The credits by source live in BalanceHero. Nothing here grants
 * anything: the webhook does, and this component waits for the plan to show
 * up. The customer-facing copy names no payment provider.
 */
export function PlanPanel({
  summary,
  matrix,
  access,
  orgId,
  userId,
  email,
  plansUnread = false,
  rates = null,
}: {
  summary: BillingSummary | null;
  matrix: PlanMatrix | null;
  access: SubscribeAccess;
  orgId: string;
  userId: string | null;
  email: string | null;
  /** The plan catalog could not be read: the plans to choose from are unknown, not absent. */
  plansUnread?: boolean;
  /** Today's generation prices, for each plan's "≈ N images" line; null = not shown. */
  rates?: GenerationRates | null;
}) {
  const { t, locale } = useI18n();
  const p = t.plans;
  const cp = t.creditsPage;
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
  // A summary without a plan is an unknown plan — never "Free".
  const planName = summary?.plan?.name ?? t.common.unknown;
  const currentId = summary?.plan?.id ?? null;
  const statusText = sub ? p.status[sub.status] : null;
  const dateLine = !sub
    ? null
    : sub.status === "canceled" || sub.cancelAtPeriodEnd
      ? fmt(p.endsOn, { date: shortDate(sub.periodEnd, locale) })
      : fmt(p.renews, { date: shortDate(sub.periodEnd, locale) });
  const message: Partial<Record<Phase, { text: string; ok?: boolean }>> = {
    paid: { text: cp.planPaid, ok: true },
    arrived: { text: cp.planArrived, ok: true },
    slow: { text: cp.planSlow },
    cancelled: { text: cp.cancelled },
    error: { text: cp.checkoutError },
    load_failed: { text: cp.loadFailed },
  };
  const msg = message[phase];
  // The plans are shown to anyone who could act on them or already has one;
  // the buttons only to the person who may buy (access "allowed").
  const showCards = Boolean(matrix) && (access === "allowed" || access === "manage" || access === "admin_only");
  const cards = (matrix?.columns ?? []).filter((col) => !col.isDefault && (col.priceId || col.displayPrice || col.id === currentId));

  return (
    <section id="plans" className="panel flex scroll-mt-24 flex-col gap-5 p-5 sm:p-6" aria-labelledby="plan-title">
      <div className="flex flex-col gap-1.5">
        <h2 id="plan-title" className="t-section">
          {cp.plansTitle}
        </h2>
        <p className="text-sm font-light text-[var(--color-muted)]">{cp.plansLead}</p>
      </div>

      <div className="flex items-start justify-between gap-3 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs text-[var(--color-muted)]">{cp.yourPlan}</span>
          <span className="text-[17px] font-medium">{planName}</span>
          {dateLine && <span className="text-xs text-[var(--color-muted)]">{dateLine}</span>}
        </div>
        {statusText && (
          <Chip plain tone={sub?.status === "past_due" ? "warn" : undefined} className="shrink-0">
            {statusText}
          </Chip>
        )}
      </div>
      {sub?.status === "past_due" && <p className="text-sm text-[var(--color-warn)]">{cp.pastDue}</p>}
      {summary?.runSlots && summary.runSlots.limit !== null && (
        <p className="text-xs text-[var(--color-muted)]">
          {fmt(p.runSlots, { active: summary.runSlots.active, limit: summary.runSlots.limit })}
        </p>
      )}

      {access === "manage" && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={manage}
            disabled={portal === "opening"}
            className="btn-quiet self-start text-sm disabled:opacity-40"
          >
            {portal === "opening" ? p.manageOpening : p.manage}
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
          <p className="text-xs text-[var(--color-muted)]">{cp.manageHint}</p>
          <p className="text-xs text-[var(--color-muted)]">{cp.changePlan}</p>
          {portal === "failed" && <p className="text-xs text-[var(--color-fail)]">{cp.manageFailed}</p>}
          {portal === "missing" && <p className="text-xs text-[var(--color-muted)]">{cp.manageMissing}</p>}
        </div>
      )}

      {plansUnread && !live && <ErrorState compact message={p.readFailed} />}

      {access === "admin_only" && <p className="text-sm text-[var(--color-muted)]">{p.adminOnly}</p>}

      {showCards && matrix && cards.length > 0 && (
        <div className="flex flex-col gap-4">
          {/* The terms come before the buttons: read before any checkout opens. */}
          {access === "allowed" && (
            <p className="text-xs leading-relaxed text-[var(--color-muted)]" data-purchase-terms>
              {cp.planTerms} {cp.refunds}{" "}
              <Link href="/terms#credits" className="underline underline-offset-2 hover:text-[var(--color-fg)]">
                {cp.termsLink}
              </Link>
            </p>
          )}
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((col) => {
              const i = matrix.columns.indexOf(col);
              const price = columnPrice(col, prices, prices === null && access === "allowed");
              const priceText = price.kind === "preview" || price.kind === "display" ? price.text : null;
              const current = col.id === currentId;
              const canBuy = access === "allowed" && Boolean(col.priceId) && !current;
              return (
                <li
                  key={col.id}
                  className="flex flex-col gap-3 rounded-[var(--ns-r-panel)] border p-4"
                  style={{ borderColor: current ? "var(--color-primary)" : "var(--color-border)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[15px] font-medium">{col.name}</span>
                    {current && (
                      <Chip plain tone="lit">
                        {cp.yourPlan}
                      </Chip>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    {priceText ? (
                      <>
                        <span className="ns-tc text-[28px] font-semibold leading-none">{priceText}</span>
                        <span className="text-sm text-[var(--color-muted)]">{cp.perMonth}</span>
                      </>
                    ) : (
                      <span className="text-sm text-[var(--color-muted)]">{cp.priceAtCheckout}</span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[15px] font-medium">
                      {withFigure(cp.monthlyCredits, col.monthlyCredits, locale)}
                    </span>
                    <Equivalents credits={col.monthlyCredits} rates={rates} />
                  </div>
                  {matrix.rows.length > 0 && (
                    <ul className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-3 text-xs">
                      {matrix.rows.map((row) => (
                        <li key={row.key} className="flex items-start gap-2">
                          <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]" aria-hidden />
                          <span>
                            <span className="text-[var(--color-muted)]">{(p.row as Record<string, string>)[row.key] ?? row.key}: </span>
                            {entitlementText(row.key, row.type, row.cells[i], t)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {canBuy && (
                    <PriceButton
                      className="mt-auto"
                      onClick={() => col.priceId && subscribe(col.priceId)}
                      disabled={phase === "opening"}
                      label={phase === "opening" ? cp.opening : p.subscribe}
                      priceText={priceText}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {rates && <p className="text-xs text-[var(--color-muted)]">{cp.eq.note}</p>}
        </div>
      )}

      {msg && (
        <p className="text-sm" style={{ color: msg.ok ? "var(--color-ok)" : "var(--color-muted)" }} aria-live="polite">
          {msg.text}
        </p>
      )}
    </section>
  );
}
