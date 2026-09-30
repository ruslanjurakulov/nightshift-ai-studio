"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/context";
import { formatCredits } from "@/lib/credits";
import { packMinutes } from "@/lib/pricing";
import { columnPrice, type EntitlementType, type EntitlementValue, type PlanMatrix as Matrix } from "@/lib/plans";
import { ensurePaddle, previewPrices } from "@/lib/paddle-client";

type Dict = ReturnType<typeof useI18n>["t"];

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
 */
export function PlanMatrix({
  matrix,
  perMinute,
  signedIn,
  subscribeHref,
}: {
  matrix: Matrix;
  perMinute: number | null;
  signedIn: boolean;
  subscribeHref: string;
}) {
  const { t, locale } = useI18n();
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
        <span
          className="mono pill self-start border border-[var(--color-warn)] px-2.5 py-0.5 text-[10px] uppercase tracking-[0.14em]"
          style={{ color: "var(--color-warn)" }}
        >
          {t.pricing.sandbox}
        </span>
      )}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {matrix.columns.map((col, i) => {
          const price = columnPrice(col, preview, loading);
          const minutes = col.isDefault ? null : packMinutes(col.monthlyCredits, perMinute);
          return (
            <li
              key={col.id}
              className="glass-card flex flex-col gap-5 rounded-[22px] border border-[var(--color-border)] p-6"
            >
              <div className="t-label">{col.name}</div>
              <div>
                {price.kind === "free" ? (
                  <div className="font-display text-[2rem] font-semibold leading-none tracking-[-0.02em]">{p.free}</div>
                ) : price.kind === "preview" || price.kind === "display" ? (
                  <div className="font-display text-[2rem] font-semibold leading-none tracking-[-0.02em]">
                    {price.text}
                    <span className="ml-1 text-[13px] font-light text-[var(--color-muted)]">{p.perMonth}</span>
                  </div>
                ) : (
                  <div className="text-[15px] font-medium text-[var(--color-muted)]" aria-live="polite">
                    {price.kind === "pending"
                      ? t.pricing.priceLoading
                      : price.kind === "at_checkout"
                        ? t.pricing.priceAtCheckout
                        : p.priceUnpublished}
                  </div>
                )}
              </div>
              <div className="border-t border-[var(--color-border)] pt-4">
                <div className="mono text-[20px] leading-none text-[var(--color-primary)]">
                  {col.isDefault
                    ? p.freeCredits
                    : fmt(p.monthlyCredits, { n: formatCredits(col.monthlyCredits, locale) })}
                </div>
                {minutes !== null && (
                  <div className="mt-2 text-[12px] font-light text-[var(--color-muted)]">
                    {fmt(p.minutes, { m: formatCredits(minutes, locale) })}
                  </div>
                )}
              </div>
              <dl className="flex flex-col gap-2.5 text-[13px]">
                {matrix.rows.map((row) => {
                  const v = row.cells[i];
                  const off = v === false || v === 0 || v === "none";
                  return (
                    <div key={row.key} className="flex items-start justify-between gap-3">
                      <dt className="font-light text-[var(--color-muted)]">{rowLabel(row.key)}</dt>
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
              {!col.isDefault && col.priceId && (
                <Link
                  href={signedIn ? subscribeHref : "/signup"}
                  className="btn-sky is-solid pill mt-auto self-start px-5 py-2.5 text-sm"
                >
                  {signedIn ? p.subscribe : p.subscribeSignedOut}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
