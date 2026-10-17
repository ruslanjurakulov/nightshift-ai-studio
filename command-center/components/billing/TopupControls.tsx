"use client";

import { useMemo, useRef, useState } from "react";
import { CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { planTopups } from "@/lib/billing";
import { formatUsdAmount } from "@/lib/number-format";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { useToast } from "@/components/feedback/ToastProvider";
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
 *
 * Recording a payment writes the balance ledger, which has no delete: so it is
 * never one tap. A sheet names the provider, the amount and the date, locks
 * against a second tap while the request is in flight, and shows a failure in
 * place. (/api/billing/topup takes no request id yet, so the lock is the only
 * double-record protection until a server-side idempotency key exists.)
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

/** Today as the owner reads it, for the "Date" line of a confirm sheet. */
const todayText = (locale: string) => new Date().toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });

/** The per-provider Pay panel, opened from its card. */
export function PayPanel({ p, suggested, onDone }: { p: ProviderView; suggested: number | null; onDone: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const lock = useRef(false);
  const [amount, setAmount] = useState(suggested && suggested > 0 ? suggested.toFixed(2) : "");
  const [state, setState] = useState<"idle" | "busy">("idle");
  // The amount last written to the ledger: the same figure cannot be written twice from this panel.
  const [recorded, setRecorded] = useState<number | null>(null);
  const [cardSaved, setCardSaved] = useState(p.cardSaved);
  const [autoRecharge, setAutoRecharge] = useState(p.autoRecharge);
  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && value <= 10000;
  const already = recorded !== null && recorded === value;

  async function toggle(flag: "card_saved_on_provider" | "auto_recharge_on_provider", next: boolean) {
    if (flag === "card_saved_on_provider") setCardSaved(next);
    else setAutoRecharge(next);
    const ok = await saveSetting(p.id, { [flag]: next });
    if (!ok) {
      if (flag === "card_saved_on_provider") setCardSaved(!next);
      else setAutoRecharge(!next);
      toast.error(t.ownerSafety.settingFailed, { title: p.name });
    }
  }

  async function record() {
    if (!valid || lock.current || already) return;
    lock.current = true;
    setState("busy");
    const shown = formatUsdAmount(value, locale, 2, 2);
    const ok = await confirm({
      title: fmt(t.ownerSafety.topupTitle, { amount: shown, provider: p.name }),
      message: t.ownerSafety.topupBody,
      confirmLabel: t.ownerSafety.topupConfirm,
      tone: "primary",
      details: [
        { label: t.ownerSafety.dProvider, value: p.name },
        { label: t.ownerSafety.dAmount, value: shown },
        { label: t.ownerSafety.dDate, value: todayText(locale) },
      ],
      successMessage: fmt(t.ownerSafety.topupDone, { amount: shown, provider: p.name }),
      run: async () => ((await recordTopup(p.id, value)) ? true : t.billing.payFailed),
    });
    lock.current = false;
    setState("idle");
    if (ok) {
      setRecorded(value);
      onDone();
    }
  }

  return (
    <div className="g5-pay">
      {dialog}
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
          onChange={(e) => setAmount(e.target.value)}
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
          disabled={!valid || state === "busy" || already}
          aria-busy={state === "busy"}
          className="btn-quiet disabled:opacity-55"
        >
          {state === "busy" && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {already ? t.billing.payRecorded : t.billing.payDone}
        </button>
      </div>
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
  const { t, locale } = useI18n();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const lock = useRef(false);
  const [days, setDays] = useState(30);
  const [cap, setCap] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(providers.filter((p) => p.includeInBulk && p.keySet).map((p) => p.id)),
  );
  const [step, setStep] = useState<number | null>(null);
  // The walk is a copy taken when it starts: changing the horizon or ticking a
  // provider mid-way must not shift which provider and amount the next step records.
  const [walk, setWalk] = useState<{ id: string; name: string; billingUrl: string; amount: number }[]>([]);
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

  function setIn(id: string, next: boolean) {
    setSelected((prev) => {
      const s = new Set(prev);
      if (next) s.add(id);
      else s.delete(id);
      return s;
    });
  }

  async function toggle(id: string, next: boolean) {
    setIn(id, next);
    const ok = await saveSetting(id, { include_in_bulk: next });
    if (!ok) {
      setIn(id, !next);
      toast.error(t.ownerSafety.settingFailed, { title: providers.find((p) => p.id === id)?.name });
    }
  }

  async function confirmStep() {
    if (step === null || lock.current) return;
    const item = walk[step];
    if (!item) return;
    lock.current = true;
    setBusy(true);
    const shown = formatUsdAmount(item.amount, locale, 2, 2);
    const ok = await confirm({
      title: fmt(t.ownerSafety.topupTitle, { amount: shown, provider: item.name }),
      message: t.ownerSafety.topupBody,
      confirmLabel: t.ownerSafety.topupConfirm,
      tone: "primary",
      details: [
        { label: t.ownerSafety.dProvider, value: item.name },
        { label: t.ownerSafety.dAmount, value: shown },
        { label: t.ownerSafety.dDate, value: todayText(locale) },
      ],
      successMessage: fmt(t.ownerSafety.topupDone, { amount: shown, provider: item.name }),
      run: async () => ((await recordTopup(item.id, item.amount)) ? true : t.billing.payFailed),
    });
    lock.current = false;
    setBusy(false);
    if (!ok) return;
    setPaidCount((n) => n + 1);
    setStep(step + 1);
  }

  const current = step !== null && step < walk.length ? walk[step] : null;

  return (
    <section className="panel ns-desk flex flex-col gap-6" aria-labelledby="bp-title">
      <div>
        <h2 id="bp-title" className="g5-h">
          {t.billing.bulkTitle}
        </h2>
        <p className="g5-sub">{t.billing.bulkSubtitle}</p>
      </div>

      {dialog}
      <fieldset disabled={step !== null} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
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
      </fieldset>
      {plan.scaled && <p className="g5-note" style={{ color: "var(--color-warn)" }}>{t.billing.bulkScaled}</p>}

      {step === null ? (
        <button
          type="button"
          disabled={queue.length === 0}
          onClick={() => {
            setWalk(queue.map((p) => ({ id: p.id, name: p.name, billingUrl: p.billingUrl, amount: lineOf.get(p.id)?.amount ?? 0 })));
            setPaidCount(0);
            setStep(0);
          }}
          className="btn-primary w-fit disabled:opacity-40"
        >
          {queue.length === 0 ? t.billing.bulkNothing : `${t.billing.bulkPay} · ${money(plan.total)}`}
        </button>
      ) : current ? (
        <div className="g5-pay" aria-live="polite" style={{ boxShadow: "inset 0 0 0 1px var(--ns-act)" }}>
          <p className="g5-k tnum">{fmt(t.billing.stepOf, { i: (step ?? 0) + 1, n: walk.length })}</p>
          <p className="g5-h">
            {current.name} · {money(current.amount)}
          </p>
          <p className="g5-note">{fmt(t.billing.payCards, { name: current.name })}</p>
          <div className="g5-actions">
            <a href={current.billingUrl} target="_blank" rel="noopener noreferrer" className="btn-primary">
              {fmt(t.billing.payOpen, { name: current.name })}
              <ExternalLink className="size-4" aria-hidden />
            </a>
            <CopyButton value={current.amount.toFixed(2)} />
            <button type="button" onClick={confirmStep} disabled={busy} aria-busy={busy} className="btn-quiet disabled:opacity-55">
              {busy && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
              {t.billing.payDone}
            </button>
            <button type="button" onClick={() => setStep((step ?? 0) + 1)} disabled={busy} className="btn-quiet disabled:opacity-55">
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
