"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { resolvedTheme } from "@/lib/theme";
import { checkoutCustomData, paddleLocale, purchaseArrived, type PaddleConfig, type SellablePack } from "@/lib/paddle";
import { ensurePaddle, previewPrices, type PaddleEventData } from "@/lib/paddle-client";

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
 * and only when this deployment has Paddle configured (lib/paddle.ts).
 */

type Phase = "idle" | "opening" | "paid" | "arrived" | "slow" | "cancelled" | "error" | "load_failed";

const POLL_MS = 3000;
const POLL_TRIES = 20;

export function BuyCredits({
  config,
  orgId,
  orgName,
  userId,
  email,
  balance,
}: {
  config: PaddleConfig;
  orgId: string;
  orgName: string;
  userId: string | null;
  email: string | null;
  balance: number;
}) {
  const { t, locale } = useI18n();
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
    paid: { text: t.credits.buy.paid, ok: true },
    arrived: { text: t.credits.buy.arrived, ok: true },
    slow: { text: t.credits.buy.slow },
    cancelled: { text: t.credits.buy.cancelled },
    error: { text: t.credits.buy.checkoutError },
    load_failed: { text: t.credits.buy.loadFailed },
  };
  const msg = message[phase];

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="t-section">
          {t.credits.buy.title} · <span className="font-light">{orgName}</span>
        </h2>
        {config.environment === "sandbox" && (
          <span className="mono pill px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--color-warn)" }}>
            {t.credits.buy.sandbox}
          </span>
        )}
      </div>
      <p className="text-[12px] text-[var(--color-muted)]">{t.credits.buy.hint}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {config.packs.map((pack) => (
          <div key={pack.id} className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] p-4">
            <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              {t.credits.buy.pack[pack.id]}
            </span>
            <span className="mono text-[20px]">{fmt(t.credits.buy.credits, { n: formatCredits(pack.credits, locale) })}</span>
            <span className="text-[12px] text-[var(--color-muted)]">{prices[pack.priceId] ?? t.credits.buy.priceAtCheckout}</span>
            <button
              type="button"
              onClick={() => buy(pack)}
              disabled={phase === "opening"}
              className="btn-sky is-solid pill mt-1 px-5 py-2 text-[13px] disabled:opacity-40"
            >
              {phase === "opening" ? t.credits.buy.opening : t.credits.buy.buy}
            </button>
          </div>
        ))}
      </div>

      {msg && (
        <p
          className="text-[12px]"
          style={{ color: msg.ok ? "var(--color-ok)" : phase === "slow" || phase === "cancelled" ? "var(--color-muted)" : "var(--color-fail)" }}
          aria-live="polite"
        >
          {msg.text}
        </p>
      )}

      <p className="text-[11px] text-[var(--color-muted)]">
        {t.credits.buy.merchant}{" "}
        <Link href="/terms" className="underline">
          {t.credits.buy.terms}
        </Link>
      </p>
    </div>
  );
}

/** For an editor or viewer of a paying organization: who can buy, not a button. */
export function BuyCreditsAdminOnly() {
  const { t } = useI18n();
  return <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.credits.buy.adminOnly}</div>;
}
