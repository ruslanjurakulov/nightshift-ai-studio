"use client";

import { supabaseFailureKind } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";
import { Fragment, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { priceTypedFigure } from "@/lib/confirm-tier";
import { postOperator } from "@/lib/operator-post";
import { priceBigChange, ratioText, REASON_MAX } from "@/lib/owner-rpc";
import { ownerFailureText } from "@/lib/owner-rpc-text";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { useToast } from "@/components/feedback/ToastProvider";
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

/** The plain meaning heads a row, so it starts with a capital in the person's own language. */
function sentence(text: string, locale: string) {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/**
 * `rpc` is passed only while NIGHTSHIFT_OWNER_RPC is on: saving and deleting then go through the server
 * (/api/owner/prices -> owner_set_credit_price / owner_delete_credit_price) instead of the table, with an optional
 * reason, the database's own big-change guard (a rate of zero, or a swing past `maxRatio` either way, needs an
 * explicit confirm) and a history row to restore from. Without it nothing below the two `if (rpc)` lines runs
 * differently from before.
 */
export function CreditPricesEditor({
  prices,
  canEdit,
  rpc,
}: {
  prices: CreditPrice[];
  canEdit: boolean;
  rpc?: { maxRatio: number | null };
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [unit, setUnit] = useState("");
  const [rate, setRate] = useState("");
  const [margin, setMargin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const formRef = useRef<HTMLDivElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);

  /** What the owner calls a price: its plain meaning when there is one, else the code. */
  function nameOf(u: string) {
    return unitMeaning(u, t.credits.unitMeaning) ?? u;
  }

  async function save() {
    if (busy) return;
    if (rpc) return saveViaServer(rpc.maxRatio);
    const row = parsePriceInput(unit, rate, margin);
    if (!row) {
      setError(t.credits.priceInvalid);
      return;
    }
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const old = prices.find((p) => p.unit === row.unit) ?? null;
    const next = { unit: row.unit, creditsPerUnit: row.credits_per_unit, margin: row.margin };
    const name = nameOf(row.unit);
    const show = (a: number | null, b: number, f: (n: number) => string) => (a === null || a === b ? f(b) : `${f(a)} → ${f(b)}`);
    const saved = await confirm({
      title: fmt(old ? t.ownerSafety.priceChangeTitle : t.ownerSafety.priceSetTitle, { name }),
      message: t.ownerSafety.priceSaveBody,
      confirmLabel: t.ownerSafety.priceSaveConfirm,
      tone: "primary",
      details: [
        { label: t.ownerSafety.dService, value: name === row.unit ? row.unit : `${name} (${row.unit})` },
        { label: t.ownerSafety.dRate, value: show(old?.creditsPerUnit ?? null, next.creditsPerUnit, (n) => figure(n)) },
        { label: t.ownerSafety.dMargin, value: show(old ? old.margin : null, next.margin, (n) => marginOf(row.unit, n)) },
        { label: t.ownerSafety.dCharged, value: show(old ? chargePerUnit(old) : null, chargePerUnit(next), (n) => figure(n, 6)) },
      ],
      typeToConfirm: priceTypedFigure(
        old ? { rate: old.creditsPerUnit, margin: old.margin, charged: chargePerUnit(old) } : null,
        { rate: next.creditsPerUnit, margin: next.margin, charged: chargePerUnit(next) },
      ),
      successMessage: fmt(t.ownerSafety.priceSaved, { name }),
      run: async () => {
        const { error: e, status } = await supabase.from("credit_prices").upsert(row, { onConflict: "unit" });
        return e ? operatorFailureText(t, { kind: supabaseFailureKind(e, status), data: {} }, t.ownerTruth.serverError) : true;
      },
    });
    setBusy(false);
    if (!saved) return;
    setUnit("");
    setRate("");
    setMargin("");
    router.refresh();
  }

  async function remove(p: CreditPrice) {
    if (busy) return;
    if (rpc) return removeViaServer(p);
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const name = nameOf(p.unit);
    const removed = await confirm({
      title: fmt(t.ownerSafety.priceDeleteTitle, { name }),
      message: t.ownerSafety.priceDeleteBody,
      confirmLabel: t.ownerSafety.priceDeleteConfirm,
      details: [
        { label: t.ownerSafety.dService, value: name === p.unit ? p.unit : `${name} (${p.unit})` },
        { label: t.ownerSafety.dRate, value: figure(p.creditsPerUnit) },
        { label: t.ownerSafety.dCharged, value: figure(chargePerUnit(p), 6) },
      ],
      successMessage: fmt(t.ownerSafety.priceDeleted, { name }),
      run: async () => {
        const { error: e, status } = await supabase.from("credit_prices").delete().eq("unit", p.unit);
        return e ? operatorFailureText(t, { kind: supabaseFailureKind(e, status), data: {} }, t.ownerTruth.serverError) : true;
      },
    });
    setBusy(false);
    if (removed) router.refresh();
  }

  /** Save through owner_set_credit_price. The sheet is the confirm step; a big change says so before its key works. */
  async function saveViaServer(maxRatioRead: number | null) {
    const row = parsePriceInput(unit, rate, margin);
    if (!row) {
      setError(t.credits.priceInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    const p = t.ownerRpc.prices;
    const old = prices.find((x) => x.unit === row.unit) ?? null;
    const next = { unit: row.unit, creditsPerUnit: row.credits_per_unit, margin: row.margin };
    const name = nameOf(row.unit);
    // The live limit when it was read, else the default the database ships with; the database decides either way.
    const maxRatio = maxRatioRead ?? 3;
    const big = priceBigChange(
      old ? { rate: old.creditsPerUnit, margin: old.margin } : null,
      { rate: next.creditsPerUnit, margin: next.margin },
      maxRatio,
    );
    const show = (a: number | null, b: number, f: (n: number) => string) => (a === null || a === b ? f(b) : `${f(a)} → ${f(b)}`);
    const oldFigures = old ? { rate: old.creditsPerUnit, margin: old.margin, charged: chargePerUnit(old) } : null;
    const newFigures = { rate: next.creditsPerUnit, margin: next.margin, charged: chargePerUnit(next) };
    const base = [
      { label: t.ownerSafety.dService, value: name === row.unit ? row.unit : `${name} (${row.unit})` },
      { label: t.ownerSafety.dRate, value: show(old?.creditsPerUnit ?? null, next.creditsPerUnit, (n) => figure(n)) },
      { label: t.ownerSafety.dMargin, value: show(old ? old.margin : null, next.margin, (n) => marginOf(row.unit, n)) },
      { label: t.ownerSafety.dCharged, value: show(old ? chargePerUnit(old) : null, chargePerUnit(next), (n) => figure(n, 6)) },
    ];
    // A big change always asks for something to be typed: the figure when it is long enough to be worth typing, else a word.
    // The same sheet, with the same typing, whether the screen or the server noticed that the change is big.
    type BigView = { rateX: number | null; chargedX: number | null; max: number };
    const ask = (view: BigView | null, stale: boolean) => ({
      title: view ? fmt(p.bigTitle, { name }) : fmt(old ? t.ownerSafety.priceChangeTitle : t.ownerSafety.priceSetTitle, { name }),
      message: view
        ? stale
          ? fmt(p.staleNote, { rate: ratioText(view.rateX) ?? "—", charged: ratioText(view.chargedX) ?? "—", max: view.max })
          : fmt(p.bigBody, { max: view.max })
        : t.ownerSafety.priceSaveBody,
      confirmLabel: view ? p.bigConfirm : t.ownerSafety.priceSaveConfirm,
      tone: (view ? "danger" : "primary") as "danger" | "primary",
      details: view
        ? [
            ...base,
            {
              label: p.dChange,
              value:
                ratioText(view.rateX) && ratioText(view.chargedX)
                  ? fmt(p.changeText, { rate: ratioText(view.rateX) ?? "—", charged: ratioText(view.chargedX) ?? "—" })
                  : row.credits_per_unit === 0
                    ? p.zeroNote
                    : p.wasZeroNote,
            },
            { label: p.dLimit, value: fmt(p.limitText, { max: view.max }) },
          ]
        : base,
      typeToConfirm: view ? (priceTypedFigure(oldFigures, newFigures) ?? p.bigWord) : priceTypedFigure(oldFigures, newFigures),
    });
    // Set when the server calls it big although the screen did not (a stale page): that sheet closes and the big-change
    // sheet opens, with the typing a locally detected big change needs. One extra tap never confirms it.
    let staleView: BigView | null = null;
    const send = (view: BigView | null) => async () => {
      const out = await postOperator("/api/owner/prices", {
        action: "set",
        unit: row.unit,
        rate: row.credits_per_unit,
        margin: row.margin,
        reason: reason.trim() || undefined,
        confirm: view !== null,
      });
      if (out.ok) return true;
      if (out.data.error === "confirm_required" && view === null) {
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
        staleView = { rateX: num(out.data.rate_ratio), chargedX: num(out.data.charged_ratio), max: num(out.data.max_ratio) ?? maxRatio };
        return true;
      }
      return ownerFailureText(t, out, locale, true);
    };
    const localView: BigView | null = big.big ? { rateX: big.rateRatio, chargedX: big.chargedRatio, max: maxRatio } : null;
    let saved = await confirm({ ...ask(localView, false), run: send(localView) });
    const again = staleView as BigView | null;
    if (saved && again) saved = await confirm({ ...ask(again, true), run: send(again) });
    setBusy(false);
    if (!saved) return;
    toast.success(fmt(t.ownerSafety.priceSaved, { name }));
    setUnit("");
    setRate("");
    setMargin("");
    setReason("");
    router.refresh();
  }

  /** Delete through owner_delete_credit_price. The database counts every delete as a big change, so the sheet's key sends the confirm. */
  async function removeViaServer(p: CreditPrice) {
    setBusy(true);
    setError(null);
    const name = nameOf(p.unit);
    const removed = await confirm({
      title: fmt(t.ownerSafety.priceDeleteTitle, { name }),
      message: t.ownerSafety.priceDeleteBody,
      confirmLabel: t.ownerSafety.priceDeleteConfirm,
      details: [
        { label: t.ownerSafety.dService, value: name === p.unit ? p.unit : `${name} (${p.unit})` },
        { label: t.ownerSafety.dRate, value: figure(p.creditsPerUnit) },
        { label: t.ownerSafety.dCharged, value: figure(chargePerUnit(p), 6) },
      ],
      successMessage: fmt(t.ownerSafety.priceDeleted, { name }),
      run: async () => {
        // No reason is sent: the reason field belongs to the price form, and a delete sheet has no field of its own,
        // so text left there by an earlier edit must not ride along on a different action.
        const out = await postOperator("/api/owner/prices", { action: "delete", unit: p.unit, confirm: true });
        return out.ok ? true : ownerFailureText(t, out, locale, true);
      },
    });
    setBusy(false);
    setReason("");
    if (removed) router.refresh();
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
  const marginOf = (u: string, m: number) =>
    isFlatUnit(u) ? t.credits.flatUnit : `${m ? "+" : ""}${formatCredits(m * 100, locale)}%`;
  const marginText = (p: CreditPrice) => marginOf(p.unit, p.margin);

  const inputClass =
    "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-base text-[var(--color-fg)] outline-none sm:text-[13px] focus:border-[var(--color-primary)]";
  const fieldLabel = "text-xs leading-tight text-[var(--color-muted)]";
  const suggestions = [...SPECIAL_UNITS, ...LEDGER_UNITS];

  return (
    <div id="credit-prices" className="panel flex scroll-mt-7 flex-col gap-3 p-5 sm:p-6">
      {dialog}
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
                        <p className="text-base font-medium text-[var(--color-fg)]">{sentence(meaning, locale)}</p>
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
                      {t.credits.colUpdated}: {p.updatedAt ? relativeTime(p.updatedAt, locale) : "—"}
                    </span>
                    {canEdit && (
                      <span className="flex items-center gap-2">
                        <button type="button" onClick={() => edit(p)} className="btn-quiet text-xs">
                          {t.credits.editPrice}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(p)}
                          disabled={busy}
                          className="btn-quiet btn-danger-quiet text-xs disabled:opacity-55"
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
                            <span className="block text-sm font-medium text-[var(--color-fg)]">{sentence(meaning, locale)}</span>
                            <span className="mono mt-0.5 block text-xs text-[var(--color-muted)]">{p.unit}</span>
                          </>
                        ) : (
                          <span className="mono text-[var(--color-fg)]">{p.unit}</span>
                        )}
                      </td>
                      <td className="tnum py-2 pr-3 text-right text-[var(--color-fg)]">{figure(p.creditsPerUnit)}</td>
                      <td className="tnum py-2 pr-3 text-right text-[var(--color-fg)]">{marginText(p)}</td>
                      <td className="tnum py-2 pr-3 text-right text-[var(--color-fg)]">{figure(chargePerUnit(p), 6)}</td>
                      <td className="py-2 pr-3 text-[var(--color-muted)]">{p.updatedAt ? relativeTime(p.updatedAt, locale) : "—"}</td>
                      {canEdit && (
                        <td className="whitespace-nowrap py-2 text-right">
                          <button type="button" onClick={() => edit(p)} className="btn-quiet text-xs">
                            {t.credits.editPrice}
                          </button>{" "}
                          <button
                            type="button"
                            onClick={() => remove(p)}
                            disabled={busy}
                            className="btn-quiet btn-danger-quiet text-xs disabled:opacity-55"
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
        <div ref={formRef} className="flex flex-wrap items-end gap-3 scroll-mt-7">
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
          {rpc && (
            <label className="flex w-full flex-col gap-1">
              <span className={fieldLabel}>{t.ownerRpc.prices.reasonLabel}</span>
              <input
                type="text"
                maxLength={REASON_MAX}
                value={reason}
                placeholder={t.ownerRpc.prices.reasonPh}
                onChange={(e) => setReason(e.target.value)}
                className={inputClass}
              />
            </label>
          )}
          <button
            type="button"
            onClick={save}
            disabled={busy || !unit.trim() || !rate.trim()}
            aria-busy={busy}
            className="btn-quiet text-sm disabled:opacity-55"
          >
            {busy && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
            {busy ? t.ownerSafety.confirmWorking : t.credits.savePrice}
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
