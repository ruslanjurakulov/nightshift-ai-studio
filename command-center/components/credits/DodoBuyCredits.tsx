"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { fmt } from "@/lib/i18n";
import { dodoPriceText, type DodoView } from "@/lib/dodo";
import { dodoReturnState, openDodoCheckout, takeBalanceBefore } from "@/lib/dodo-client";
import { purchaseArrived } from "@/lib/paddle";
import type { GenerationRates } from "@/lib/plans";
import { Equivalents } from "@/components/credits/Equivalents";
import { Chip } from "@/components/ui/Chip";
import { PriceButton } from "@/components/ui/PriceButton";
import { Timecode } from "@/components/ui/Timecode";

/**
 * Buy a credit pack through Dodo Payments (PAYMENTS_PROVIDER=dodo). The same
 * panel, terms and states as the Paddle one (BuyCredits), with one difference
 * in the flow: Buy asks our server for a checkout session and the page goes to
 * Dodo's hosted checkout, which returns here with ?dodo=return. Card details
 * are typed into Dodo's page, never ours. The credits arrive through the
 * dodo-webhook Edge Function; this component only waits for the balance to
 * grow, re-reading the page every few seconds, and says so plainly when it is
 * slow. The price on the button is the catalog price the webhook checks.
 */

type Phase = "idle" | "opening" | "paid" | "arrived" | "slow" | "cancelled" | "error";

const POLL_MS = 3000;
const POLL_TRIES = 20;

export function DodoBuyCredits({
  view,
  balance,
  rates = null,
  packValidMonths,
  extraOff = false,
}: {
  view: DodoView;
  balance: number;
  rates?: GenerationRates | null;
  packValidMonths?: number | null;
  extraOff?: boolean;
}) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const cp = t.creditsPage;
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const before = useRef<number | null>(null);
  const tries = useRef(0);

  const go = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // Back from Dodo: the query says which message to show while the webhook credits the payment.
  useEffect(() => {
    const state = dodoReturnState(window.location.search);
    if (state === "cancelled") go("cancelled");
    else if (state === "return" && new URLSearchParams(window.location.search).get("item") === "pack") {
      before.current = takeBalanceBefore();
      tries.current = 0;
      go("paid");
    }
  }, [go]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (phase !== "paid") return;
    if (before.current !== null && purchaseArrived(before.current, balance)) {
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
  }, [phase, balance, tick, router, go]);

  async function buy(id: DodoView["packs"][number]["id"]) {
    if (phaseRef.current === "opening") return;
    go("opening");
    const res = await openDodoCheckout({ kind: "pack", id }, path("/credits"), balance);
    if (res !== "redirecting") go("error");
  }

  const message: Partial<Record<Phase, { text: string; ok?: boolean }>> = {
    paid: { text: cp.packPaid, ok: true },
    arrived: { text: cp.packArrived, ok: true },
    slow: { text: cp.packSlow },
    cancelled: { text: cp.cancelled },
    error: { text: cp.loadFailed },
  };
  const msg = message[phase];
  const validity =
    packValidMonths === undefined ? cp.packTermsBase : packValidMonths === null ? cp.packTermsNever : fmt(cp.packTermsMonths, { months: packValidMonths });

  return (
    <section id="topups" className="panel flex scroll-mt-7 flex-col gap-5 p-5 sm:p-6" aria-labelledby="topups-title" data-provider="dodo">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="topups-title" className="t-section">
            {cp.packsTitle}
          </h2>
          {view.environment === "test" && (
            <Chip plain tone="warn">
              {cp.testMode}
            </Chip>
          )}
        </div>
        <p className="text-sm font-light text-[var(--color-muted)]">{cp.packsLead}</p>
        {extraOff && (
          <p className="text-sm leading-relaxed" data-extra-off-note>
            {t.usage.credits.packsOff}{" "}
            <Link href={path("/usage") + "#extra"} className="tap-link text-[var(--color-primary)] underline underline-offset-2">
              {t.usage.refusal.openUsage}
            </Link>
          </p>
        )}
      </div>

      {/* The terms come before the buttons: read before any checkout opens. */}
      <p className="text-xs leading-relaxed text-[var(--color-muted)]" data-purchase-terms>
        {validity} {cp.refunds}{" "}
        <Link href="/terms#credits" className="underline underline-offset-2 hover:text-[var(--color-fg)]">
          {cp.termsLink}
        </Link>
      </p>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {view.packs.map((pack) => (
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
              <PriceButton
                tone="quiet"
                onClick={() => buy(pack.id)}
                disabled={phase === "opening"}
                label={phase === "opening" ? cp.opening : cp.buy}
                priceText={dodoPriceText(pack.usdCents, locale)}
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
        {t.credits.buy.merchantDodo}{" "}
        <Link href="/terms" className="underline">
          {t.credits.buy.terms}
        </Link>
      </p>
    </section>
  );
}
