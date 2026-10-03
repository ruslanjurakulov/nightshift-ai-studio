"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { resolvedTheme } from "@/lib/theme";
import { checkoutCustomData, paddleLocale, purchaseArrived, type PaddleConfig, type SellablePack } from "@/lib/paddle";
import { ensurePaddle, previewPrices, type PaddleEventData } from "@/lib/paddle-client";
import type { GenerationRates } from "@/lib/plans";
import { Equivalents } from "@/components/credits/Equivalents";
import { Chip } from "@/components/ui/Chip";
import { PriceButton } from "@/components/ui/PriceButton";
import { Timecode } from "@/components/ui/Timecode";

/**
 * Buy credits for the current organization with Paddle's overlay checkout.
 *
 * Paddle.js draws the checkout in its own iframe: card details are typed into
 * Paddle's page, never ours, and nothing here sees, stores or logs them. When
 * the payment completes, Paddle tells the webhook (a Supabase Edge Function
 * with the service role), which credits the organization; this component only
 * waits for the balance to grow, re-reading the page every few seconds.
 *
 * The page renders this only for an owner/admin of an organization that pays,
 * and only when this deployment has Paddle configured (lib/paddle.ts). The
 * one-time, validity and refund terms sit above the Buy buttons, and the
 * customer-facing copy names no payment provider.
 */

type Phase = "idle" | "opening" | "paid" | "arrived" | "slow" | "cancelled" | "error" | "load_failed";

const POLL_MS = 3000;
const POLL_TRIES = 20;

export function BuyCredits({
  config,
  orgId,
  userId,
  email,
  balance,
  rates = null,
  packValidMonths,
}: {
  config: PaddleConfig;
  orgId: string;
  userId: string | null;
  email: string | null;
  balance: number;
  /** Today's generation prices, for each pack's "≈ N images" line; null = not shown. */
  rates?: GenerationRates | null;
  /** How long pack credits last: months, null = never expire, undefined = unknown (then not stated). */
  packValidMonths?: number | null;
}) {
  const { t, locale } = useI18n();
  const cp = t.creditsPage;
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const phaseRef = useRef<Phase>("idle");
  const balanceAtCheckout = useRef<number>(balance);
  const tries = useRef(0);

  const go = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const onEvent = useCallback(
    (e: PaddleEventData) => {
      switch (e.name) {
        case "checkout.loaded":
          if (phaseRef.current === "opening") go("idle");
          break;
        case "checkout.completed":
          tries.current = 0;
          go("paid");
          break;
        case "checkout.closed":
          // Closing the overlay after paying is the normal end of a purchase.
          if (phaseRef.current !== "paid" && phaseRef.current !== "arrived" && phaseRef.current !== "slow") {
            go("cancelled");
          }
          break;
        case "checkout.error":
          go("error");
          break;
      }
    },
    [go],
  );

  // Load Paddle.js and ask it for localized prices. A price that cannot be
  // previewed is shown as "at checkout", never as a number we made up. Keyed
  // on the values, not the config object: every router.refresh() hands this
  // component a new (equal) object, and that must not re-run Paddle's setup.
  const { environment, clientToken } = config;
  const priceKey = config.packs.map((p) => p.priceId).join(",");
  useEffect(() => {
    let alive = true;
    ensurePaddle({ environment, clientToken }, onEvent)
      .then((paddle) => previewPrices(paddle, priceKey.split(",")))
      .then((out) => {
        if (alive) setPrices(out);
      })
      .catch(() => {
        // Not fatal here: the prices read "at checkout", and a click retries
        // the load and says so if it fails again.
      });
    return () => {
      alive = false;
    };
  }, [environment, clientToken, priceKey, onEvent]);

  // After payment: re-read the page (the balance comes from the server) until
  // the webhook's credit shows up, or say plainly that it is taking long.
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (phase !== "paid") return;
    if (purchaseArrived(balanceAtCheckout.current, balance)) {
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
      // A refresh that returns the same balance re-renders nothing; the tick
      // schedules the next attempt regardless.
      setPollTick((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [phase, balance, pollTick, router, go]);

  async function buy(pack: SellablePack) {
    if (phaseRef.current === "opening") return;
    go("opening");
    balanceAtCheckout.current = balance;
    // Paddle reports a failure to open as checkout.error; this only makes sure
    // the buttons never stay disabled if it says nothing at all.
    setTimeout(() => {
      if (phaseRef.current === "opening") go("idle");
    }, 15_000);
    try {
      const paddle = await ensurePaddle({ environment, clientToken }, onEvent);
      paddle.Checkout.open({
        items: [{ priceId: pack.priceId, quantity: 1 }],
        customData: checkoutCustomData(orgId, userId),
        ...(email ? { customer: { email } } : {}),
        settings: {
          displayMode: "overlay",
          theme: resolvedTheme(),
          locale: paddleLocale(locale),
          allowLogout: false,
          variant: "one-page",
        },
      });
    } catch {
      go("load_failed");
    }
  }

  const message: Partial<Record<Phase, { text: string; ok?: boolean }>> = {
    paid: { text: cp.packPaid, ok: true },
    arrived: { text: cp.packArrived, ok: true },
    slow: { text: cp.packSlow },
    cancelled: { text: cp.cancelled },
    error: { text: cp.checkoutError },
    load_failed: { text: cp.loadFailed },
  };
  const msg = message[phase];
  const validity =
    packValidMonths === undefined
      ? cp.packTermsBase
      : packValidMonths === null
        ? cp.packTermsNever
        : fmt(cp.packTermsMonths, { months: packValidMonths });

  return (
    <section id="topups" className="panel flex scroll-mt-24 flex-col gap-5 p-5 sm:p-6" aria-labelledby="topups-title">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="topups-title" className="t-section">
            {cp.packsTitle}
          </h2>
          {config.environment === "sandbox" && (
            <Chip plain tone="warn">
              {cp.testMode}
            </Chip>
          )}
        </div>
        <p className="text-sm font-light text-[var(--color-muted)]">
          {cp.packsLead}
        </p>
      </div>

      {/* The terms come before the buttons: read before any checkout opens. */}
      <p className="text-xs leading-relaxed text-[var(--color-muted)]" data-purchase-terms>
        {validity} {cp.refunds}{" "}
        <Link href="/terms#credits" className="underline underline-offset-2 hover:text-[var(--color-fg)]">
          {cp.termsLink}
        </Link>
      </p>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {config.packs.map((pack) => (
          <li key={pack.id} className="flex flex-col gap-3 rounded-[var(--ns-r-panel)] border border-[var(--color-border)] p-4">
            <span className="text-[15px] font-medium">{t.credits.buy.pack[pack.id]}</span>
            <div className="flex flex-col gap-1">
              <span className="text-[28px] font-semibold leading-none">
                <Timecode value={pack.credits} locale={locale} />
              </span>
              <span className="text-sm text-[var(--color-muted)]">{cp.unit}</span>
            </div>
            <Equivalents credits={pack.credits} rates={rates} />
            <div className="mt-auto flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
              {/* The price is the provider's quote, drawn as given; with none, the key says so in words. */}
              {!prices[pack.priceId] && <span className="text-xs text-[var(--color-muted)]">{cp.priceAtCheckout}</span>}
              <PriceButton
                onClick={() => buy(pack)}
                disabled={phase === "opening"}
                label={phase === "opening" ? cp.opening : cp.buy}
                priceText={prices[pack.priceId] ?? null}
              />
            </div>
          </li>
        ))}
      </ul>
      {rates && <p className="text-xs text-[var(--color-muted)]">{cp.eq.note}</p>}

      {msg && (
        <p
          className="text-sm"
          style={{ color: msg.ok ? "var(--color-ok)" : phase === "slow" || phase === "cancelled" ? "var(--color-muted)" : "var(--color-fail)" }}
          aria-live="polite"
        >
          {msg.text}
        </p>
      )}

      {/* Legal disclosure, not branding: the Merchant of Record must be named before payment. */}
      <p className="text-xs text-[var(--color-muted)]">
        {t.credits.buy.merchant}{" "}
        <Link href="/terms" className="underline">
          {t.credits.buy.terms}
        </Link>
      </p>
    </section>
  );
}

/** For an editor or viewer of a paying organization: who can buy, not a button. */
export function BuyCreditsAdminOnly() {
  const { t } = useI18n();
  return <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{t.credits.buy.adminOnly}</div>;
}
