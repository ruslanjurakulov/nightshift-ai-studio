"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { relativeTime } from "@/lib/format";
import { LEDGER_UNITS, SPECIAL_UNITS, formatCredits, parsePriceInput, type CreditPrice } from "@/lib/credits";

/**
 * The platform's credit price list (credit_prices, migration 0020).
 *
 * Everyone signed in can read it — it is what they are charged. Only a
 * platform owner/admin may change it: the table's policies refuse anyone else,
 * and this editor is only offered to them. Who changed a price and when is
 * stamped by the database, not sent from here.
 */
export function CreditPricesEditor({ prices, canEdit }: { prices: CreditPrice[]; canEdit: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [unit, setUnit] = useState("");
  const [rate, setRate] = useState("");
  const [margin, setMargin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }

  const inputClass =
    "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";
  const suggestions = [...SPECIAL_UNITS, ...LEDGER_UNITS];

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <h2 className="t-section">{t.credits.pricesTitle}</h2>
      <p className="text-[12px] leading-relaxed text-[var(--color-muted)]">{t.credits.pricesHint}</p>

      {prices.length === 0 ? (
        <p className="text-[13px] text-[var(--color-warn)]">{t.credits.pricesEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-[12px]">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              <tr>
                <th className="py-2 pr-3 font-semibold">{t.credits.colUnit}</th>
                <th className="py-2 pr-3 text-right font-semibold">{t.credits.colRate}</th>
                <th className="py-2 pr-3 text-right font-semibold">{t.credits.colMargin}</th>
                <th className="py-2 pr-3 font-semibold">{t.credits.colUpdated}</th>
                {canEdit && <th className="py-2" />}
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.unit} className="border-t border-[var(--color-border)]">
                  <td className="mono py-2 pr-3">{p.unit}</td>
                  <td className="mono py-2 pr-3 text-right">
                    {new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 }).format(p.creditsPerUnit)}
                  </td>
                  <td className="mono py-2 pr-3 text-right">
                    {p.margin ? `+${formatCredits(p.margin * 100, locale)}%` : "—"}
                  </td>
                  <td className="py-2 pr-3 text-[var(--color-muted)]">{p.updatedAt ? relativeTime(p.updatedAt) : "—"}</td>
                  {canEdit && (
                    <td className="py-2 text-right">
                      <button type="button" onClick={() => edit(p)} className="btn-sky is-quiet pill px-3 py-1 text-[11px]">
                        {t.credits.editPrice}
                      </button>{" "}
                      <button
                        type="button"
                        onClick={() => remove(p.unit)}
                        disabled={busy}
                        className="btn-sky is-quiet pill px-3 py-1 text-[11px] disabled:opacity-40"
                        style={{ color: "var(--color-fail)" }}
                      >
                        {t.credits.removePrice}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit ? (
        <div className="flex flex-wrap items-end gap-3">
          <input
            type="text"
            list="credit-price-units"
            value={unit}
            placeholder={t.credits.unitPh}
            aria-label={t.credits.colUnit}
            onChange={(e) => setUnit(e.target.value)}
            className={`w-56 ${inputClass}`}
          />
          <datalist id="credit-price-units">
            {suggestions.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <input
            type="number"
            min="0"
            step="any"
            value={rate}
            placeholder={t.credits.ratePh}
            aria-label={t.credits.colRate}
            onChange={(e) => setRate(e.target.value)}
            className={`w-36 ${inputClass}`}
          />
          <input
            type="number"
            min="0"
            max="10"
            step="0.01"
            value={margin}
            placeholder={t.credits.marginPh}
            aria-label={t.credits.colMargin}
            onChange={(e) => setMargin(e.target.value)}
            className={`w-32 ${inputClass}`}
          />
          <button
            type="button"
            onClick={save}
            disabled={busy || !unit.trim() || !rate.trim()}
            className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
          >
            {t.credits.savePrice}
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-[var(--color-muted)]">{t.credits.readOnlyPrices}</p>
      )}
      {error && (
        <p className="text-[12px] text-[var(--color-fail)]" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
