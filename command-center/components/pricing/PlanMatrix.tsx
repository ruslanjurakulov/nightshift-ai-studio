"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { formatCredits } from "@/lib/credits";
import { packMinutes, WELCOME_CREDITS } from "@/lib/pricing";
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
}: {
  matrix: Matrix;
  perMinute: number | null;
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

  return (
    <div className="flex flex-col gap-3">
      {environment === "sandbox" && (
        <span className="st-tag self-start" style={{ color: "var(--ns-caution)", borderColor: "currentColor" }}>
          {t.pricing.sandbox}
        </span>
      )}
      <ul className="st-plans" data-cols={matrix.columns.length >= 4 ? "4" : "3"}>
        {matrix.columns.map((col, i) => {
          const price = columnPrice(col, preview, loading);
          const minutes = col.isDefault || rates ? null : packMinutes(col.monthlyCredits, perMinute);
          return (
            <li key={col.id} className="st-plan">
              <h3 className="st-price-name">{col.name}</h3>
              <div className="min-h-[2.25rem]">
                {price.kind === "free" ? (
                  <div className="st-h3 text-[34px]">{p.free}</div>
                ) : price.kind === "preview" || price.kind === "display" ? (
                  <div className="st-num text-[28px] leading-none">
                    {price.text}
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
                <Equivalents credits={col.isDefault ? WELCOME_CREDITS : col.monthlyCredits} rates={rates} />
                {minutes !== null && (
                  <div className="text-xs font-light text-[var(--color-muted)]">
                    {fmt(p.minutes, { m: formatCredits(minutes, locale) })}
                  </div>
                )}
              </div>
              {matrix.rows.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <div className="st-kicker text-xs">{t.pricing.limitsLabel}</div>
                  <dl className="flex flex-col gap-2.5 text-sm">
                    {matrix.rows.map((row) => {
                      const v = row.cells[i];
                      const off = v === false || v === 0 || v === "none";
                      return (
                        <div key={row.key} className="flex items-start justify-between gap-3">
                          <dt className="text-[var(--ns-text-dim)]">{rowLabel(row.key)}</dt>
                          <dd className="flex items-center gap-1 text-right font-medium">
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
              {!col.isDefault && col.priceId ? (
                <Link href={signedIn ? subscribeHref : "/signup"} className="st-key mt-auto" data-size="sm" data-block="true">
                  {signedIn ? p.subscribe : p.subscribeSignedOut}
                </Link>
              ) : col.isDefault && !signedIn ? (
                <Link href="/signup" className="st-key mt-auto" data-size="sm" data-tone="quiet" data-block="true">
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
