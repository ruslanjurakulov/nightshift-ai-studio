"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { formatCredits } from "@/lib/credits";
import { displayPriceText, packMinutes, WELCOME_CREDITS } from "@/lib/pricing";
import {
  columnPrice,
  type EntitlementType,
  type EntitlementValue,
  type GenerationRates,
  type PlanMatrix as Matrix,
} from "@/lib/plans";
import { Equivalents } from "@/components/credits/Equivalents";
import { ensurePaddle, previewPrices } from "@/lib/paddle-client";

type Dict = ReturnType<typeof usePublicI18n>["t"];

/** How one entitlement reads in a cell. Unknown keys fall back to the raw value. */
export function entitlementText(key: string, type: EntitlementType, v: EntitlementValue, t: Dict): string {
  const p = t.plans;
  if (type === "bool") return v === true ? p.yes : p.no;
  if (type === "tier") return p.tier[(v as keyof Dict["plans"]["tier"]) ?? "none"] ?? String(v);
  if (key === "queue_priority") return v === 0 ? p.priorityStandard : fmt(p.priorityLevel, { n: Number(v) });
  if (key === "concurrency") return fmt(p.runsAtOnce, { n: Number(v) });
  return String(v);
}

/**
 * The plans on /pricing: one card per public plan, and in each the monthly
 * credits and every ENFORCED entitlement (lib/plans.ts planMatrix). Prices come
 * from Paddle's preview when Paddle sells the plan, else the owner's display
 * price; a plan with neither says its price is not published — never a number
 * made up here.
 *
 * Under the credits, "≈ N images · M videos" when today's prices could be
 * read (signed-in only — credit_rates() is not public); otherwise the older
 * minutes-of-video line when only the per-minute rate is known, else nothing.
 */
export function PlanMatrix({
  matrix,
  perMinute,
  rates = null,
  signedIn,
  subscribeHref,
  testMode = false,
  testBadge = null,
  outputs,
}: {
  matrix: Matrix;
  /** "What does this plan make?" per plan id, rendered on the server (components/pricing/PlanOutputs.tsx). When given, it
   *  takes the place of the "≈ N images · M videos" line, which counted the cheapest model alone. */
  outputs?: Record<string, React.ReactNode>;
  perMinute: number | null;
  /** Dodo Payments in test mode (PAYMENTS_PROVIDER=dodo): treated exactly as Paddle's sandbox. */
  testMode?: boolean;
  /** The test-payments badge, handed in by the server for a platform admin only. Without it a test-mode card offers no
   *  Subscribe key (it would open a test checkout) and says purchases open soon; the default is that closed state. */
  testBadge?: string | null;
  /** Today's generation prices (lib/plans generationRates); null = unknown, no equivalents shown. */
  rates?: GenerationRates | null;
  signedIn: boolean;
  subscribeHref: string;
}) {
  const { t, locale } = usePublicI18n();
  const p = t.plans;
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(Boolean(matrix.paddle));

  const environment = matrix.paddle?.environment ?? null;
  const clientToken = matrix.paddle?.clientToken ?? null;
  const priceKey = matrix.columns.flatMap((c) => (c.priceId ? [c.priceId] : [])).join(",");
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
        // The display price or "at checkout" already stands in, honestly.
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [environment, clientToken, priceKey]);

  const rowLabel = (key: string) => (p.row as Record<string, string>)[key] ?? key;
  const testing = environment === "sandbox" || testMode;
  // Test payments are for the operator to try the checkout; anyone else is told sales are not open yet.
  const closed = testing && !testBadge;

  return (
    <div className="flex flex-col gap-3">
      {testing && testBadge && (
        <span className="st-tag self-start" style={{ color: "var(--ns-caution)", borderColor: "currentColor" }}>
          {testBadge}
        </span>
      )}
      <ul className="st-plans" data-cols={matrix.columns.length >= 4 ? "4" : "3"}>
        {matrix.columns.map((col, i) => {
          const price = columnPrice(col, preview, loading);
          const minutes = col.isDefault || rates ? null : packMinutes(col.monthlyCredits, perMinute);
          const made = outputs?.[col.id];
          return (
            <li key={col.id} id={`plan-${col.id}`} className="st-plan" data-spot>
              {/* The free plan's catalog name is the English word "Free"; above "Бесплатно" it read as a second, untranslated
                  price (and as "Free / Free" in English). It is named in the page's language, and its price line says it costs
                  nothing in words: a "$0" would be a figure no price list gave this page. */}
              <h3 className="st-price-name">{col.isDefault ? p.freeName : col.name}</h3>
              <div className="min-h-[2.25rem]">
                {price.kind === "free" ? (
                  <div className="st-h3 text-[34px]">{p.freePrice}</div>
                ) : price.kind === "preview" || price.kind === "display" ? (
                  <div className="st-num text-[28px] leading-none">
                    {displayPriceText(price.text, locale)}
                    <span className="ml-1 font-[family-name:var(--font-sans)] text-sm text-[var(--ns-text-dim)]">{p.perMonth}</span>
                  </div>
                ) : (
                  <div className="text-[15px] font-medium text-[var(--ns-text-dim)]" aria-live="polite">
                    {price.kind === "pending"
                      ? t.pricing.priceLoading
                      : price.kind === "at_checkout"
                        ? t.pricing.priceAtCheckout
                        : p.priceUnpublished}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2 border-y border-[var(--ns-rule)] py-4">
                <div className="st-num text-[17px] leading-tight">
                  {col.isDefault
                    ? fmt(p.freeCredits, { n: formatCredits(WELCOME_CREDITS, locale) })
                    : fmt(p.monthlyCredits, { n: formatCredits(col.monthlyCredits, locale) })}
                </div>
                {made !== undefined ? (
                  made
                ) : (
                  <>
                    <Equivalents credits={col.isDefault ? WELCOME_CREDITS : col.monthlyCredits} rates={rates} />
                    {minutes !== null && (
                      <div className="text-sm font-light text-[var(--color-muted)]">
                        {fmt(p.minutes, { m: formatCredits(minutes, locale) })}
                      </div>
                    )}
                  </>
                )}
              </div>
              {matrix.rows.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <div className="st-kicker text-sm">{t.pricing.limitsLabel}</div>
                  {/* A label column and a value column: as two shrinking flex items, "4 at once" broke as "4 at / once". */}
                  <dl className="st-plan-limits">
                    {matrix.rows.map((row) => {
                      const v = row.cells[i];
                      const off = v === false || v === 0 || v === "none";
                      return (
                        <div key={row.key}>
                          <dt>{rowLabel(row.key)}</dt>
                          <dd>
                            {row.type === "bool" ? (
                              off ? (
                                <Minus className="size-4 text-[var(--color-muted)]" aria-label={p.no} />
                              ) : (
                                <Check className="size-4 text-[var(--color-ok)]" aria-label={p.yes} />
                              )
                            ) : (
                              entitlementText(row.key, row.type, v, t)
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              )}
              {!col.isDefault && col.priceId && closed ? (
                <p className="st-small mt-auto" data-sales="soon">
                  {t.pricing.purchasesSoon}
                </p>
              ) : !col.isDefault && col.priceId ? (
                <Link href={signedIn ? subscribeHref : "/signup"} className="st-key mt-auto" data-size="sm" data-block="true" data-wrap="true">
                  {signedIn ? p.subscribe : p.subscribeSignedOut}
                </Link>
              ) : col.isDefault && !signedIn ? (
                <Link href="/signup" className="st-key mt-auto" data-size="sm" data-tone="quiet" data-block="true" data-wrap="true">
                  {t.pricing.ctaSignedOut}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
