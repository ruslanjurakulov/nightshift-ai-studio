"use client";

import { useMemo, useState } from "react";
import { CreditCard, ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { planTopups } from "@/lib/billing";
import type { ProviderView } from "@/components/billing/BillingBoard";

/**
 * Top-up controls — the per-provider "Pay" panel and the page-bottom "Pay all
 * providers" planner.
 *
 * Providers expose no API to fund an account from outside, so the money moves
 * on each provider's own checkout (Visa / Mastercard, entered and saved there).
 * This site does the part it can do honestly: work out exactly how much each
 * provider needs, open the right checkout with that amount ready to copy, and
 * record the payment once the operator confirms it. No card data is accepted,
 * sent or stored anywhere here.
 */

const money = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);

async function postJson(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function recordTopup(provider: string, amount: number) {
  return postJson("/api/billing/topup", { provider, amount_usd: amount });
}

export function saveSetting(provider: string, patch: Record<string, unknown>) {
  return postJson("/api/billing/settings", { provider, ...patch });
}

function CopyButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — the amount is still visible */
        }
      }}
      className="btn-sky is-quiet pill px-3 py-1.5 text-[12px]"
    >
      {copied ? t.billing.payCopied : t.billing.payCopy}
    </button>
  );
}

const inputClass =
  "pill border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";

/** The per-provider Pay panel, opened from its card. */
export function PayPanel({ p, suggested, onDone }: { p: ProviderView; suggested: number | null; onDone: () => void }) {
  const { t } = useI18n();
  const [amount, setAmount] = useState(suggested && suggested > 0 ? suggested.toFixed(2) : "");
  const [state, setState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [cardSaved, setCardSaved] = useState(p.cardSaved);
  const [autoRecharge, setAutoRecharge] = useState(p.autoRecharge);
  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && value <= 10000;

  async function toggle(flag: "card_saved_on_provider" | "auto_recharge_on_provider", next: boolean) {
    if (flag === "card_saved_on_provider") setCardSaved(next);
    else setAutoRecharge(next);
    const ok = await saveSetting(p.id, { [flag]: next });
    if (!ok) {
      if (flag === "card_saved_on_provider") setCardSaved(!next);
      else setAutoRecharge(!next);
    }
  }

  async function record() {
    if (!valid) return;
    setState("busy");
    const ok = await recordTopup(p.id, value);
    setState(ok ? "ok" : "fail");
    if (ok) onDone();
  }

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
      <p className="text-[12px] font-semibold text-[var(--color-fg)]">{fmt(t.billing.payTitle, { name: p.name })}</p>
      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
        <CreditCard className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {fmt(t.billing.payCards, { name: p.name })}
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.billing.payAmount}</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={10000}
          step="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setState("idle");
          }}
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <a
          href={p.billingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="cta-glass pill inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-semibold"
        >
          {fmt(t.billing.payOpen, { name: p.name })}
          <ExternalLink className="size-3" aria-hidden />
        </a>
        {valid && <CopyButton value={value.toFixed(2)} />}
      </div>
      <button
        type="button"
        onClick={record}
        disabled={!valid || state === "busy" || state === "ok"}
        className="btn-sky pill w-fit px-4 py-1.5 text-[12px] disabled:opacity-40"
      >
        {state === "ok" ? t.billing.payRecorded : t.billing.payDone}
      </button>
      {state === "fail" && <span className="text-[11px] text-[var(--color-fail)]">{t.billing.payFailed}</span>}
      <div className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-2 text-[12px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={cardSaved} onChange={(e) => toggle("card_saved_on_provider", e.target.checked)} />
          {t.billing.cardSaved}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autoRecharge} onChange={(e) => toggle("auto_recharge_on_provider", e.target.checked)} />
          {t.billing.autoRecharge}
        </label>
        <p className="text-[11px] text-[var(--color-muted)]">{t.billing.autoRechargeHint}</p>
      </div>
    </div>
  );
}

const HORIZONS = [7, 30, 90];

/** "Pay all providers": select, see exact per-provider amounts and the total, then pay step by step. */
export function BulkPay({ providers, onDone }: { providers: ProviderView[]; onDone: () => void }) {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [cap, setCap] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(providers.filter((p) => p.includeInBulk && p.keySet).map((p) => p.id)),
  );
  const [step, setStep] = useState<number | null>(null);
  const [paidCount, setPaidCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const capValue = cap.trim() === "" ? null : Number(cap);
  const chosen = useMemo(() => providers.filter((p) => selected.has(p.id)), [providers, selected]);
  const plan = useMemo(
    () =>
      planTopups(
        chosen.map((p) => ({ id: p.id, usdPerDay: p.usdPerDay, balanceUsd: p.balanceUsd })),
        days,
        capValue !== null && Number.isFinite(capValue) && capValue >= 0 ? capValue : null,
      ),
    [chosen, days, capValue],
  );
  const lineOf = new Map(plan.lines.map((l) => [l.id, l]));
  const queue = chosen.filter((p) => (lineOf.get(p.id)?.amount ?? 0) > 0);

  function toggle(id: string, next: boolean) {
    setSelected((prev) => {
      const s = new Set(prev);
      if (next) s.add(id);
      else s.delete(id);
      return s;
    });
    void saveSetting(id, { include_in_bulk: next });
  }

  async function confirmStep() {
    if (step === null) return;
    const p = queue[step];
    const amount = lineOf.get(p.id)?.amount ?? 0;
    setBusy(true);
    const ok = await recordTopup(p.id, amount);
    setBusy(false);
    if (!ok) return;
    setPaidCount((n) => n + 1);
    setStep(step + 1);
  }

  const current = step !== null && step < queue.length ? queue[step] : null;

  return (
    <section className="panel flex flex-col gap-4 p-4">
      <div>
        <h2 className="t-section">{t.billing.bulkTitle}</h2>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.billing.bulkSubtitle}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.billing.bulkHorizon}</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputClass}>
            {HORIZONS.map((d) => (
              <option key={d} value={d}>
                {fmt(t.billing.bulkDays, { n: d })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{t.billing.bulkCap}</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            placeholder={t.billing.bulkCapPlaceholder}
            className={inputClass}
          />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              <th className="w-8 py-2" />
              <th className="py-2">{t.billing.colProvider}</th>
              <th className="py-2 text-right">{t.billing.colBurn}</th>
              <th className="py-2 text-right">{t.billing.colBalance}</th>
              <th className="py-2 text-right">{t.billing.colNeed}</th>
              <th className="py-2 text-right">{t.billing.colAmount}</th>
            </tr>
          </thead>
          <tbody className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>
            {providers.map((p) => {
              const on = selected.has(p.id);
              const line = lineOf.get(p.id);
              return (
                <tr key={p.id} className="border-t border-[var(--color-border)]" style={{ opacity: on ? 1 : 0.5 }}>
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => toggle(p.id, e.target.checked)}
                      aria-label={p.name}
                    />
                  </td>
                  <td className="py-2 font-sans text-[var(--color-fg)]">{p.name}</td>
                  <td className="py-2 text-right">{p.usdPerDay === null ? t.billing.needUnpriced : money(p.usdPerDay)}</td>
                  <td className="py-2 text-right">
                    {p.balanceUsd !== null ? money(p.balanceUsd) : on ? t.billing.balanceAssumed : "—"}
                  </td>
                  <td className="py-2 text-right">{on ? (line?.need === null ? t.billing.needUnpriced : money(line?.need ?? null)) : "—"}</td>
                  <td className="py-2 text-right font-semibold text-[var(--color-fg)]">{on ? money(line?.amount ?? null) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--color-border)]">
              <td />
              <td colSpan={4} className="py-3 text-[13px] font-semibold text-[var(--color-fg)]">
                {t.billing.bulkTotal}
              </td>
              <td className="py-3 text-right mono text-[15px] font-semibold text-[var(--color-primary)]">
                {money(plan.total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {plan.scaled && <p className="text-[12px] text-[var(--color-warn)]">{t.billing.bulkScaled}</p>}

      {step === null ? (
        <button
          type="button"
          disabled={queue.length === 0}
          onClick={() => {
            setPaidCount(0);
            setStep(0);
          }}
          className="cta-glass pill w-fit px-6 py-2.5 text-[13px] font-semibold disabled:opacity-40"
        >
          {queue.length === 0 ? t.billing.bulkNothing : `${t.billing.bulkPay} · ${money(plan.total)}`}
        </button>
      ) : current ? (
        <div className="flex flex-col gap-3 rounded-[14px] border border-[var(--color-primary)] p-3" aria-live="polite">
          <p className="mono text-[11px] text-[var(--color-muted)]">
            {fmt(t.billing.stepOf, { i: step + 1, n: queue.length })}
          </p>
          <p className="text-[14px] font-semibold text-[var(--color-fg)]">
            {current.name} · {money(lineOf.get(current.id)?.amount ?? null)}
          </p>
          <p className="text-[11px] text-[var(--color-muted)]">{fmt(t.billing.payCards, { name: current.name })}</p>
          <div className="flex flex-wrap gap-2">
            <a
              href={current.billingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="cta-glass pill inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-semibold"
            >
              {fmt(t.billing.payOpen, { name: current.name })}
              <ExternalLink className="size-3" aria-hidden />
            </a>
            <CopyButton value={(lineOf.get(current.id)?.amount ?? 0).toFixed(2)} />
            <button
              type="button"
              onClick={confirmStep}
              disabled={busy}
              className="btn-sky pill px-4 py-1.5 text-[12px] disabled:opacity-40"
            >
              {t.billing.payDone}
            </button>
            <button type="button" onClick={() => setStep(step + 1)} className="btn-sky is-quiet pill px-3 py-1.5 text-[12px]">
              {t.billing.stepSkip}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[13px] text-[var(--color-ok)]">{fmt(t.billing.stepDone, { n: paidCount })}</p>
          <button
            type="button"
            onClick={() => {
              setStep(null);
              onDone();
            }}
            className="btn-sky is-quiet pill px-3 py-1.5 text-[12px]"
          >
            {t.billing.stepClose}
          </button>
        </div>
      )}
    </section>
  );
}
