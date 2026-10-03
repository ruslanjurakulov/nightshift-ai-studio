"use client";

import { Fragment, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { relativeTime } from "@/lib/format";
import {
  LEDGER_UNITS,
  SPECIAL_UNITS,
  chargePerUnit,
  formatCredits,
  isFlatUnit,
  parsePriceInput,
  type CreditPrice,
} from "@/lib/credits";
import { unitMeaning } from "@/lib/creditUnits";

/**
 * The platform's credit price list (credit_prices, migration 0020).
 *
 * Everyone signed in can read it — it is what they are charged. Only a
 * platform owner/admin may change it: the table's policies refuse anyone else,
 * and this editor is only offered to them. Who changed a price and when is
 * stamped by the database, not sent from here.
 */
/** A unit name that may wrap only after an underscore (a lone trailing "p" or "i" on its own line is not a name), and still copies as the exact name. */
function breakable(unit: string) {
  const parts = unit.split("_");
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <>
          _<wbr />
        </>
      )}
    </Fragment>
  ));
}

export function CreditPricesEditor({ prices, canEdit }: { prices: CreditPrice[]; canEdit: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [unit, setUnit] = useState("");
  const [rate, setRate] = useState("");
  const [margin, setMargin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);

  async function save() {
    const supabase = createClient();
    const row = parsePriceInput(unit, rate, margin);
    if (!supabase || busy) return;
    if (!row) {
      setError(t.credits.priceInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from("credit_prices").upsert(row, { onConflict: "unit" });
    setBusy(false);
    if (e) {
      setError(t.credits.priceFailed);
      return;
    }
    setUnit("");
    setRate("");
    setMargin("");
    router.refresh();
  }

  async function remove(u: string) {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from("credit_prices").delete().eq("unit", u);
    setBusy(false);
    if (e) {
      setError(t.credits.priceFailed);
      return;
    }
    router.refresh();
  }

  function edit(p: CreditPrice) {
    setUnit(p.unit);
    setRate(String(p.creditsPerUnit));
    setMargin(String(p.margin));
    // On a phone the form sits below the whole list: bring it to the person.
    formRef.current?.scrollIntoView?.({ block: "nearest" });
    rateRef.current?.focus({ preventScroll: true });
  }

  // Figures as the operator set them, never rounded to a cent: 0.008 credits a
  // character must not read 0.01. Six significant digits hide float noise only.
  const figure = (n: number, digits = 8) => new Intl.NumberFormat(locale, { maximumSignificantDigits: digits }).format(n);
  const marginText = (p: CreditPrice) =>
    isFlatUnit(p.unit) ? t.credits.flatUnit : `${p.margin ? "+" : ""}${formatCredits(p.margin * 100, locale)}%`;

  const inputClass =
    "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-base text-[var(--color-fg)] outline-none sm:text-[13px] focus:border-[var(--color-primary)]";
  const fieldLabel = "text-xs leading-tight text-[var(--color-muted)]";
  const suggestions = [...SPECIAL_UNITS, ...LEDGER_UNITS];

  return (
    <div id="credit-prices" className="panel flex scroll-mt-24 flex-col gap-3 p-5 sm:p-6">
      <h2 className="t-section">{t.credits.pricesTitle}</h2>
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">{t.credits.pricesHint}</p>

      {prices.length === 0 ? (
        <p className="text-sm text-[var(--color-warn)]">{t.credits.pricesEmpty}</p>
      ) : (
        <>
          {/* Phone: one row per price, every value in view — no sideways scroll. */}
          <ul className="flex flex-col md:hidden" aria-label={t.credits.pricesTitle}>
            {prices.map((p) => {
              const meaning = unitMeaning(p.unit, t.credits.unitMeaning);
              return (
                <li key={p.unit} className="flex flex-col gap-2 border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0">
                  <div className="min-w-0">
                    {meaning ? (
                      <>
                        <p className="text-base font-medium text-[var(--color-fg)]">{meaning}</p>
                        <p className="mono mt-0.5 break-words text-xs text-[var(--color-muted)]">{breakable(p.unit)}</p>
                      </>
                    ) : (
                      <p className="mono break-words text-sm text-[var(--color-fg)]">{breakable(p.unit)}</p>
                    )}
                  </div>
                  <dl className="grid grid-cols-3 gap-x-3">
                    <div className="flex min-w-0 flex-col">
                      <dt className="text-xs leading-tight text-[var(--color-muted)]">{t.credits.colRate}</dt>
                      <dd className="tnum mt-auto pt-1 text-[15px] font-semibold text-[var(--color-fg)]">{figure(p.creditsPerUnit)}</dd>
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <dt className="text-xs leading-tight text-[var(--color-muted)]">{t.credits.colMargin}</dt>
                      <dd className="tnum mt-auto pt-1 text-[15px] font-semibold text-[var(--color-fg)]">{marginText(p)}</dd>
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <dt className="text-xs leading-tight text-[var(--color-muted)]">{t.credits.colCharged}</dt>
                      <dd className="tnum mt-auto pt-1 text-[15px] font-semibold text-[var(--color-fg)]">{figure(chargePerUnit(p), 6)}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-[var(--color-muted)]">
                      {t.credits.colUpdated}: {p.updatedAt ? relativeTime(p.updatedAt) : "—"}
                    </span>
                    {canEdit && (
                      <span className="flex items-center gap-2">
                        <button type="button" onClick={() => edit(p)} className="btn-quiet text-xs">
                          {t.credits.editPrice}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(p.unit)}
                          disabled={busy}
                          className="btn-quiet text-xs disabled:opacity-40"
                          style={{ color: "var(--color-fail)" }}
                        >
                          {t.credits.removePrice}
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Wide screens: the table. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs text-[var(--color-muted)]">
                <tr>
                  <th className="py-2 pr-3 font-semibold">{t.credits.colUnit}</th>
                  <th className="py-2 pr-3 text-right font-semibold">{t.credits.colRate}</th>
                  <th className="py-2 pr-3 text-right font-semibold">{t.credits.colMargin}</th>
                  <th className="py-2 pr-3 text-right font-semibold">{t.credits.colCharged}</th>
                  <th className="py-2 pr-3 font-semibold">{t.credits.colUpdated}</th>
                  {canEdit && (
                    <th className="py-2">
                      <span className="sr-only">
                        {t.credits.editPrice} / {t.credits.removePrice}
                      </span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => {
                  const meaning = unitMeaning(p.unit, t.credits.unitMeaning);
                  return (
                    <tr key={p.unit} className="border-t border-[var(--color-border)] align-top">
                      <td className="py-2 pr-3">
                        {meaning ? (
                          <>
                            <span className="block text-sm font-medium text-[var(--color-fg)]">{meaning}</span>
                            <span className="mono mt-0.5 block text-xs text-[var(--color-muted)]">{p.unit}</span>
                          </>
                        ) : (
                          <span className="mono text-[var(--color-fg)]">{p.unit}</span>
                        )}
                      </td>
                      <td className="tnum py-2 pr-3 text-right text-[var(--color-fg)]">{figure(p.creditsPerUnit)}</td>
                      <td className="tnum py-2 pr-3 text-right text-[var(--color-fg)]">{marginText(p)}</td>
                      <td className="tnum py-2 pr-3 text-right text-[var(--color-fg)]">{figure(chargePerUnit(p), 6)}</td>
                      <td className="py-2 pr-3 text-[var(--color-muted)]">{p.updatedAt ? relativeTime(p.updatedAt) : "—"}</td>
                      {canEdit && (
                        <td className="whitespace-nowrap py-2 text-right">
                          <button type="button" onClick={() => edit(p)} className="btn-quiet text-xs">
                            {t.credits.editPrice}
                          </button>{" "}
                          <button
                            type="button"
                            onClick={() => remove(p.unit)}
                            disabled={busy}
                            className="btn-quiet text-xs disabled:opacity-40"
                            style={{ color: "var(--color-fail)" }}
                          >
                            {t.credits.removePrice}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {canEdit ? (
        <div ref={formRef} className="flex flex-wrap items-end gap-3 scroll-mt-24">
          {/* Visible labels: once a field holds a value its placeholder is gone, and a phone shows no hint of which field is which. */}
          <label className="flex w-full flex-col gap-1 sm:w-56">
            <span className={fieldLabel}>{t.credits.colUnit}</span>
            <input
              type="text"
              list="credit-price-units"
              value={unit}
              placeholder={t.credits.unitPh}
              onChange={(e) => setUnit(e.target.value)}
              className={inputClass}
            />
          </label>
          <datalist id="credit-price-units">
            {suggestions.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <label className="flex w-full flex-col gap-1 sm:w-36">
            <span className={fieldLabel}>{t.credits.colRate}</span>
            <input
              type="number"
              min="0"
              step="any"
              ref={rateRef}
              value={rate}
              placeholder={t.credits.ratePh}
              onChange={(e) => setRate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex w-full flex-col gap-1 sm:w-32">
            <span className={fieldLabel}>{t.credits.colMargin}</span>
            <input
              type="number"
              min="0"
              max="10"
              step="0.01"
              value={margin}
              placeholder={t.credits.marginPh}
              onChange={(e) => setMargin(e.target.value)}
              className={inputClass}
            />
          </label>
          <button
            type="button"
            onClick={save}
            disabled={busy || !unit.trim() || !rate.trim()}
            className="btn-primary text-sm disabled:opacity-40"
          >
            {t.credits.savePrice}
          </button>
        </div>
      ) : (
        <p className="text-xs text-[var(--color-muted)]">{t.credits.readOnlyPrices}</p>
      )}
      {error && (
        <p className="text-xs text-[var(--color-fail)]" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
