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
      className="btn-quiet"
    >
      {copied ? t.billing.payCopied : t.billing.payCopy}
    </button>
  );
}

const inputClass = "ns-field tnum";

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
    <div className="g5-pay">
      <p className="g5-row-title" style={{ fontWeight: 600 }}>
        {fmt(t.billing.payTitle, { name: p.name })}
      </p>
      <p className="flex items-start gap-2 g5-note">
        <CreditCard className="mt-0.5 size-4 shrink-0" aria-hidden />
        {fmt(t.billing.payCards, { name: p.name })}
      </p>
      <label className="g5-field" style={{ maxWidth: "16rem" }}>
        <span className="g5-k">{t.billing.payAmount}</span>
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
      <div className="g5-actions">
        <a href={p.billingUrl} target="_blank" rel="noopener noreferrer" className="btn-quiet">
          {fmt(t.billing.payOpen, { name: p.name })}
          <ExternalLink className="size-4" aria-hidden />
        </a>
        {valid && <CopyButton value={value.toFixed(2)} />}
        <button
          type="button"
          onClick={record}
          disabled={!valid || state === "busy" || state === "ok"}
          className="btn-quiet disabled:opacity-40"
        >
          {state === "ok" ? t.billing.payRecorded : t.billing.payDone}
        </button>
      </div>
      {state === "fail" && (
        <span role="alert" className="g5-note g5-fail-text">
          {t.billing.payFailed}
        </span>
      )}
      <div className="flex flex-col gap-1 border-t border-[var(--ns-rule)] pt-3">
        <label className="g5-check">
          <input type="checkbox" checked={cardSaved} onChange={(e) => toggle("card_saved_on_provider", e.target.checked)} />
          {t.billing.cardSaved}
        </label>
        <label className="g5-check">
          <input type="checkbox" checked={autoRecharge} onChange={(e) => toggle("auto_recharge_on_provider", e.target.checked)} />
          {t.billing.autoRecharge}
        </label>
        <p className="g5-note">{t.billing.autoRechargeHint}</p>
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
    <section className="panel ns-desk flex flex-col gap-6" aria-labelledby="bp-title">
      <div>
        <h2 id="bp-title" className="g5-h">
          {t.billing.bulkTitle}
        </h2>
        <p className="g5-sub">{t.billing.bulkSubtitle}</p>
      </div>

      <div className="g5-form">
        <label className="g5-field" data-fixed>
          <span className="g5-k">{t.billing.bulkHorizon}</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputClass}>
            {HORIZONS.map((d) => (
              <option key={d} value={d}>
                {fmt(t.billing.bulkDays, { n: d })}
              </option>
            ))}
          </select>
        </label>
        <label className="g5-field" data-fixed>
          <span className="g5-k">{t.billing.bulkCap}</span>
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

      <div>
        <div aria-hidden className="g5-plan-head">
          <span />
          <span>{t.billing.colProvider}</span>
          <span>{t.billing.colBurn}</span>
          <span>{t.billing.colBalance}</span>
          <span>{t.billing.colNeed}</span>
          <span>{t.billing.colAmount}</span>
        </div>
        <ul className="g5-plan">
          {providers.map((p) => {
            const on = selected.has(p.id);
            const line = lineOf.get(p.id);
            return (
              <li key={p.id} className="g5-plan-row" data-off={on ? undefined : "true"}>
                <div className="g5-plan-name">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => toggle(p.id, e.target.checked)}
                    aria-label={p.name}
                    className="size-5 shrink-0"
                    style={{ accentColor: "var(--ns-act)" }}
                  />
                  <span>{p.name}</span>
                </div>
                <div className="g5-plan-cell">
                  <span className="g5-k">{t.billing.colBurn}</span>
                  {p.usdPerDay === null ? t.billing.needUnpriced : money(p.usdPerDay)}
                </div>
                <div className="g5-plan-cell">
                  <span className="g5-k">{t.billing.colBalance}</span>
                  {p.balanceUsd !== null ? money(p.balanceUsd) : on ? t.billing.balanceAssumed : "—"}
                </div>
                <div className="g5-plan-cell">
                  <span className="g5-k">{t.billing.colNeed}</span>
                  {on ? (line?.need === null ? t.billing.needUnpriced : money(line?.need ?? null)) : "—"}
                </div>
                <div className="g5-plan-cell" style={{ fontWeight: 600 }}>
                  <span className="g5-k">{t.billing.colAmount}</span>
                  {on ? money(line?.amount ?? null) : "—"}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="g5-plan-total">
          <span className="g5-h">{t.billing.bulkTotal}</span>
          <span className="g5-figure" style={{ fontSize: "1.75rem" }}>
            {money(plan.total)}
          </span>
        </div>
      </div>
      {plan.scaled && <p className="g5-note" style={{ color: "var(--color-warn)" }}>{t.billing.bulkScaled}</p>}

      {step === null ? (
        <button
          type="button"
          disabled={queue.length === 0}
          onClick={() => {
            setPaidCount(0);
            setStep(0);
          }}
          className="btn-primary w-fit disabled:opacity-40"
        >
          {queue.length === 0 ? t.billing.bulkNothing : `${t.billing.bulkPay} · ${money(plan.total)}`}
        </button>
      ) : current ? (
        <div className="g5-pay" aria-live="polite" style={{ boxShadow: "inset 0 0 0 1px var(--ns-act)" }}>
          <p className="g5-k tnum">{fmt(t.billing.stepOf, { i: step + 1, n: queue.length })}</p>
          <p className="g5-h">
            {current.name} · {money(lineOf.get(current.id)?.amount ?? null)}
          </p>
          <p className="g5-note">{fmt(t.billing.payCards, { name: current.name })}</p>
          <div className="g5-actions">
            <a href={current.billingUrl} target="_blank" rel="noopener noreferrer" className="btn-primary">
              {fmt(t.billing.payOpen, { name: current.name })}
              <ExternalLink className="size-4" aria-hidden />
            </a>
            <CopyButton value={(lineOf.get(current.id)?.amount ?? 0).toFixed(2)} />
            <button type="button" onClick={confirmStep} disabled={busy} className="btn-quiet disabled:opacity-40">
              {t.billing.payDone}
            </button>
            <button type="button" onClick={() => setStep(step + 1)} className="btn-quiet">
              {t.billing.stepSkip}
            </button>
          </div>
        </div>
      ) : (
        <div className="g5-actions">
          <p className="g5-v" style={{ color: "var(--color-ok)" }} role="status">
            {fmt(t.billing.stepDone, { n: paidCount })}
          </p>
          <button
            type="button"
            onClick={() => {
              setStep(null);
              onDone();
            }}
            className="btn-quiet"
          >
            {t.billing.stepClose}
          </button>
        </div>
      )}
    </section>
  );
}
