"use client";

/**
 * The owner's two inputs on the costs tab: a monthly cost entry, and a provider balance read off the provider's dashboard.
 * Each writes one row through its route and refreshes the page; nothing here spends, charges or calls a provider.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { COST_CATEGORIES, type CostCategory } from "@/lib/owner-analytics/costs";

type Dict = ReturnType<typeof useI18n>["t"]["ownerAnalytics"];

export function categoryLabel(d: Dict, c: CostCategory): string {
  return {
    infrastructure: d.catInfrastructure,
    tools: d.catTools,
    people: d.catPeople,
    marketing: d.catMarketing,
    legal: d.catLegal,
    other: d.catOther,
  }[c];
}

function usePost(path: string, failText: string, invalidText: string) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  async function post(body: unknown): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const e = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        setError(e === "invalid_request" ? invalidText : e === "mfa_required" ? t.ownerAnalytics.mfaNeeded : failText);
        return false;
      }
      start(() => router.refresh());
      return true;
    } catch {
      setError(failText);
      return false;
    }
  }
  return { post, pending, error };
}

export function CostEntryForm({ maxMonth }: { maxMonth: string }) {
  const { t } = useI18n();
  const d = t.ownerAnalytics;
  const { post, pending, error } = usePost("/api/owner-analytics/costs", d.costFailed, d.costInvalid);
  const [month, setMonth] = useState(maxMonth.slice(0, 7));
  const [category, setCategory] = useState<CostCategory>("infrastructure");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  return (
    <form
      className="oa-picker"
      aria-busy={pending || undefined}
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await post({ action: "add", month: `${month}-01`, category, amount: Number(amount), note });
        if (ok) {
          setAmount("");
          setNote("");
        }
      }}
    >
      <label className="oa-slider">
        {d.month}
        <input type="month" value={month} max={maxMonth.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} required />
      </label>
      <label className="oa-slider">
        {d.category}
        <select value={category} onChange={(e) => setCategory(e.target.value as CostCategory)}>
          {COST_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(d, c)}
            </option>
          ))}
        </select>
      </label>
      <label className="oa-slider">
        {d.amount} ({d.usd})
        <input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <label className="oa-slider">
        {d.note}
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button type="submit" className="oa-chip" disabled={pending}>
        {d.addCost}
      </button>
      {error && (
        <p className="oa-note" data-tone="warn" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function DeleteCost({ id }: { id: number }) {
  const { t } = useI18n();
  const d = t.ownerAnalytics;
  const { post, pending, error } = usePost("/api/owner-analytics/costs", d.costFailed, d.costFailed);
  return (
    <>
      <button type="button" className="oa-chip" disabled={pending} onClick={() => void post({ action: "delete", id })}>
        {d.delete}
      </button>
      {error && (
        <span className="oa-note" data-tone="warn" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

export function BalanceForm() {
  const { t } = useI18n();
  const d = t.ownerAnalytics;
  const { post, pending, error } = usePost("/api/owner-analytics/balance", d.balanceFailed, d.balanceInvalid);
  const [provider, setProvider] = useState("");
  const [metric, setMetric] = useState("credits");
  const [unit, setUnit] = useState("credits");
  const [remaining, setRemaining] = useState("");
  return (
    <form
      className="oa-picker"
      aria-busy={pending || undefined}
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await post({ provider: provider.trim().toLowerCase(), metric: metric.trim(), unit: unit.trim(), remaining: Number(remaining) });
        if (ok) setRemaining("");
      }}
    >
      <label className="oa-slider">
        {d.providerName}
        <input value={provider} onChange={(e) => setProvider(e.target.value)} required maxLength={40} autoComplete="off" spellCheck={false} />
      </label>
      <label className="oa-slider">
        {d.metric}
        <input value={metric} onChange={(e) => setMetric(e.target.value)} required maxLength={40} autoComplete="off" spellCheck={false} />
      </label>
      <label className="oa-slider">
        {d.unit}
        <input value={unit} onChange={(e) => setUnit(e.target.value)} required maxLength={20} autoComplete="off" spellCheck={false} />
      </label>
      <label className="oa-slider">
        {d.remaining}
        <input type="number" inputMode="decimal" min={0} step="any" value={remaining} onChange={(e) => setRemaining(e.target.value)} required />
      </label>
      <button type="submit" className="oa-chip" disabled={pending}>
        {d.saveBalance}
      </button>
      {error && (
        <p className="oa-note" data-tone="warn" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
