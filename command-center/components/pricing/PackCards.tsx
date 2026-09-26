"use client";

import { useEffect, useState } from "react";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/context";
import { formatCredits } from "@/lib/credits";
import { packMinutes, packPrice, type Pricing, type PricingPack } from "@/lib/pricing";
import { ensurePaddle, previewPrices } from "@/lib/paddle-client";

/**
 * The three pack cards. When this deployment sells through Paddle, the prices
 * are asked of Paddle itself (PricePreview), so the visitor sees the amount,
 * currency and tax treatment the checkout will use; until that answers — or
 * if it never does — the owner's display price stands in, and failing that
 * the card says the price is shown at checkout. No checkout opens from here.
 */
export function PackCards({
  packs,
  paddle,
  perMinute,
}: {
  packs: PricingPack[];
  paddle: Pricing["paddle"];
  perMinute: number | null;
}) {
  const { t, locale } = useI18n();
  const p = t.pricing;
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(Boolean(paddle));

  // Keyed on values, not objects: a re-render hands in equal but new props.
  const environment = paddle?.environment ?? null;
  const clientToken = paddle?.clientToken ?? null;
  const priceKey = packs.flatMap((pk) => (pk.priceId ? [pk.priceId] : [])).join(",");
  useEffect(() => {
    if (!environment || !clientToken || !priceKey) {
      setLoading(false);
      return;
    }
    let alive = true;
    ensurePaddle({ environment, clientToken })
      .then((pd) => previewPrices(pd, priceKey.split(",")))
      .then((out) => {
        if (alive) setPreview(out);
      })
      .catch(() => {
        // Blocked script or network: the fallback text is already honest.
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [environment, clientToken, priceKey]);

  return (
    <div className="flex flex-col gap-3">
      {environment === "sandbox" && (
        <span
          className="mono pill self-start border border-[var(--color-warn)] px-2.5 py-0.5 text-[10px] uppercase tracking-[0.14em]"
          style={{ color: "var(--color-warn)" }}
        >
          {p.sandbox}
        </span>
      )}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {packs.map((pack) => {
          const price = packPrice(pack, preview, loading);
          const minutes = packMinutes(pack.credits, perMinute);
          return (
            <li
              key={pack.id}
              className="glass-card flex flex-col gap-5 rounded-[22px] border border-[var(--color-border)] p-6 sm:p-7"
            >
              <div className="t-label">{t.credits.buy.pack[pack.id]}</div>
              <div>
                <div className="mono text-[28px] leading-none tracking-[-0.02em] text-[var(--color-primary)]">
                  {fmt(p.credits, { n: formatCredits(pack.credits, locale) })}
                </div>
                {minutes !== null && (
                  <div className="mt-2 text-[13px] font-light text-[var(--color-muted)]">
                    {fmt(p.minutes, { m: formatCredits(minutes, locale) })}
                  </div>
                )}
              </div>
              <div className="mt-auto border-t border-[var(--color-border)] pt-5">
                {price.kind === "preview" || price.kind === "display" ? (
                  <div className="font-display text-[2rem] font-semibold leading-none tracking-[-0.02em]">{price.text}</div>
                ) : (
                  <div className="text-[15px] font-medium text-[var(--color-muted)]" aria-live="polite">
                    {price.kind === "pending" ? p.priceLoading : p.priceAtCheckout}
                  </div>
                )}
                <div className="mt-2 text-[12px] font-light text-[var(--color-muted)]">{p.oneTime}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
