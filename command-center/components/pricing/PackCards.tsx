"use client";

import { useEffect, useState } from "react";
import { fmt } from "@/lib/i18n/core";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { formatCredits } from "@/lib/credits";
import { displayPriceText, packMinutes, packPrice, type Pricing, type PricingPack } from "@/lib/pricing";
import { ensurePaddle, previewPrices } from "@/lib/paddle-client";
import type { GenerationRates } from "@/lib/plans";
import { Equivalents } from "@/components/credits/Equivalents";

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
  rates = null,
}: {
  packs: PricingPack[];
  paddle: Pricing["paddle"];
  perMinute: number | null;
  /** Today's generation prices; when known, "≈ N images · M videos" replaces the minutes line. */
  rates?: GenerationRates | null;
}) {
  const { t, locale } = usePublicI18n();
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
        <span className="st-tag self-start" style={{ color: "var(--ns-caution)", borderColor: "currentColor" }}>
          {p.sandbox}
        </span>
      )}
      <ul className="st-panel st-price-rows">
        {packs.map((pack) => {
          const price = packPrice(pack, preview, loading);
          const minutes = rates ? null : packMinutes(pack.credits, perMinute);
          return (
            <li key={pack.id} className="st-price-row" data-spot>
              <h3 className="st-price-name">{t.credits.buy.pack[pack.id]}</h3>
              <div>
                <span className="st-price-credits st-num">
                  {formatCredits(pack.credits, locale)}
                  <small>{t.site.pricingTeaser.credits}</small>
                </span>
                <span className="sr-only">{fmt(p.credits, { n: formatCredits(pack.credits, locale) })}</span>
                <Equivalents credits={pack.credits} rates={rates} className="mt-1" />
                {minutes !== null && <div className="st-small mt-1">{fmt(p.minutes, { m: formatCredits(minutes, locale) })}</div>}
              </div>
              {price.kind === "preview" || price.kind === "display" ? (
                <span className="st-price-money">
                  <span className="st-num block text-[24px]">{price.kind === "display" ? displayPriceText(price.text, locale) : price.text}</span>
                  <span className="st-small block">{p.oneTime}</span>
                </span>
              ) : (
                <span className="st-price-pending" aria-live="polite">
                  {price.kind === "pending" ? p.priceLoading : p.priceAtCheckout}
                  <span className="block">{p.oneTime}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
