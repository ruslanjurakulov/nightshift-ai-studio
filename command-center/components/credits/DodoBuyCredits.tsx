"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { fmt } from "@/lib/i18n";
import { dodoPriceText, packBonusPercent, type DodoCheckoutItem, type DodoView } from "@/lib/dodo";
import { openDodoCheckout, takeBalanceBefore, takeDodoReturn, type DodoOpenResult } from "@/lib/dodo-client";
import { AddCreditsSheet } from "@/components/credits/AddCreditsSheet";
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
 *
 * With a Pay What You Want product configured (view.amount), the panel opens with the "Add credits" sheet: preset and typed
 * amounts at the base rate (1 credit per US cent, the Starter pack's own rate), and the packs below it as the better-value
 * cards, each saying how many more credits it gives than the same money typed. Both go through the same checkout route, the
 * same return and the same wait for the balance.
 */

type Phase = "idle" | "opening" | "paid" | "arrived" | "slow" | "cancelled" | "error" | "too_many" | "not_on_sale";

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
    const state = takeDodoReturn("pack");
    if (state === "cancelled") go("cancelled");
    else if (state === "return") {
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

  async function open(item: DodoCheckoutItem) {
    // One checkout at a time: a second press while one is opening is dropped, not a second session.
    if (phaseRef.current === "opening") return;
    go("opening");
    const res: DodoOpenResult = await openDodoCheckout(item, path("/credits"), balance);
    if (res === "redirecting") return;
    go(res === "too_many" ? "too_many" : res === "not_on_sale" ? "not_on_sale" : "error");
  }

  const ac = t.addCredits;
  const message: Partial<Record<Phase, { text: string; ok?: boolean }>> = {
    paid: { text: cp.packPaid, ok: true },
    arrived: { text: cp.packArrived, ok: true },
    slow: { text: cp.packSlow },
    cancelled: { text: cp.cancelled },
    error: { text: cp.loadFailed },
    too_many: { text: ac.tooMany },
    not_on_sale: { text: ac.notOnSale },
  };
  const amount = view.amount;
  const packsBetter = amount !== null && view.packs.some((p) => packBonusPercent(p, amount.creditsPerCent) !== null);
  const msg = message[phase];
  const validity =
    packValidMonths === undefined ? cp.packTermsBase : packValidMonths === null ? cp.packTermsNever : fmt(cp.packTermsMonths, { months: packValidMonths });

  return (
    <section id="topups" className="panel flex scroll-mt-7 flex-col gap-5 p-5 sm:p-6" aria-labelledby="topups-title" data-provider="dodo">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="topups-title" className="t-section">
            {amount ? ac.title : cp.packsTitle}
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

      {amount && (
        <AddCreditsSheet
          amount={amount}
          busy={phase === "opening"}
          packsBetter={packsBetter}
          onSubmit={(usdCents) => open({ kind: "amount", usdCents })}
        />
      )}

      {/* "Better value" is claimed only when some pack on sale here really gives more than the typed rate; Starter is the
          same rate, so a panel of Starter alone is just "Top-up packs", and only a card with a bonus chip claims anything. */}
      {amount && view.packs.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-medium">{packsBetter ? ac.packsTitle : cp.packsTitle}</h3>
          {packsBetter && <p className="text-sm font-light text-[var(--color-muted)]">{ac.packsLead}</p>}
        </div>
      )}

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {view.packs.map((pack) => {
          // Only next to a typed amount does "more credits than typed" mean anything; the figure is the two catalogs' own.
          const bonus = amount ? packBonusPercent(pack, amount.creditsPerCent) : null;
          return (
            <li key={pack.id} className="flex flex-col gap-3 rounded-[var(--ns-r-panel)] border border-[var(--color-border)] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[15px] font-medium">{t.credits.buy.pack[pack.id]}</span>
                {bonus !== null && (
                  <Chip plain tone="lit">
                    {fmt(ac.bonus, { pct: bonus })}
                  </Chip>
                )}
              </div>
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
                  onClick={() => open({ kind: "pack", id: pack.id })}
                  disabled={phase === "opening"}
                  label={phase === "opening" ? cp.opening : cp.buy}
                  priceText={dodoPriceText(pack.usdCents, locale)}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {rates && <p className="text-xs text-[var(--color-muted)]">{cp.eq.note}</p>}

      {msg && (
        <p
          className="text-sm"
          style={{ color: msg.ok ? "var(--color-ok)" : phase === "slow" || phase === "cancelled" ? "var(--color-muted)" : "var(--color-fail)" }}
          data-buy-message={phase}
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
