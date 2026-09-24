"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatCard, StatusPill } from "@/components/ui";
import { relativeTime } from "@/lib/format";
import { planTopups, type ElevenLabsRunway } from "@/lib/billing";
import { BulkPay, PayPanel } from "@/components/billing/TopupControls";

/** One paid provider, already derived on the server (see billing/page.tsx). */
export interface ProviderView {
  id: string;
  name: string;
  billingUrl: string;
  unitLabel: string;
  keySet: boolean;
  price: number | null;
  units30: number;
  usdPerDay: number | null;
  apiBalance: {
    remaining: number | null;
    total: number | null;
    unit: string;
    tier: string | null;
    resetsAt: string | null;
    checkedAt: string;
  } | null;
  ledgerUsd: number | null;
  balanceUsd: number | null;
  daysLeft: number | "never" | null;
  lowBalanceDays: number;
  includeInBulk: boolean;
  cardSaved: boolean;
  autoRecharge: boolean;
}

export type RunwayView = ElevenLabsRunway & {
  total: number | null;
  resetsAt: string | null;
  tier: string | null;
  checkedAt: string;
};

export function usd(v: number | null): string {
  if (v === null) return "—";
  return `$${v.toFixed(Math.abs(v) < 1 && v !== 0 ? 3 : 2)}`;
}

const n0 = (v: number) => Math.round(v).toLocaleString();

export function BillingBoard({
  providers,
  runway,
  githubConfigured,
}: {
  providers: ProviderView[];
  runway: RunwayView | null;
  githubConfigured: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [refresh, setRefresh] = useState<"idle" | "busy" | "ok" | "fail">("idle");

  const known = providers.filter((p) => p.usdPerDay !== null);
  const spend30 = known.length ? known.reduce((s, p) => s + (p.usdPerDay ?? 0) * 30, 0) : null;
  const partial = providers.some((p) => p.usdPerDay === null);
  const running = providers
    .filter((p) => typeof p.daysLeft === "number" && !p.autoRecharge)
    .sort((a, b) => (a.daysLeft as number) - (b.daysLeft as number));
  const first = running[0] ?? null;

  async function doRefresh() {
    setRefresh("busy");
    try {
      const res = await fetch("/api/billing/refresh", { method: "POST" });
      setRefresh(res.ok ? "ok" : "fail");
    } catch {
      setRefresh("fail");
    }
  }

  return (
    <div className="rhythm stagger-enter">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label={t.billing.statBurn30}
          value={usd(spend30)}
          sub={partial ? t.billing.partialNote : undefined}
        />
        <StatCard
          label={t.billing.statFirstOut}
          value={first ? first.name : t.billing.statFirstOutNone}
          sub={first ? fmt(t.billing.days, { n: Math.floor(first.daysLeft as number) }) : undefined}
          tone={first && (first.daysLeft as number) <= first.lowBalanceDays ? "warn" : undefined}
        />
        <div className="flex flex-col justify-end gap-2 border-t border-[var(--color-border)] pt-4">
          <button
            type="button"
            onClick={doRefresh}
            disabled={!githubConfigured || refresh === "busy"}
            className="btn-sky pill inline-flex w-fit items-center gap-2 px-4 py-2 text-[13px] disabled:opacity-40"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {refresh === "busy" ? t.billing.refreshing : t.billing.refresh}
          </button>
          <span className="mono text-[11px]" aria-live="polite">
            {refresh === "ok" && <span className="text-[var(--color-ok)]">{t.billing.refreshQueued}</span>}
            {refresh === "fail" && <span className="text-[var(--color-fail)]">{t.billing.refreshFailed}</span>}
          </span>
        </div>
      </div>

      <ElevenLabsPanel runway={runway} />

      <section className="space-y-3">
        <h2 className="t-section">{t.billing.providersTitle}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => (
            <ProviderCard key={p.id} p={p} onSaved={() => router.refresh()} />
          ))}
        </div>
      </section>

      <BulkPay providers={providers} onDone={() => router.refresh()} />
    </div>
  );
}

function ElevenLabsPanel({ runway }: { runway: RunwayView | null }) {
  const { t } = useI18n();
  if (!runway) {
    return (
      <div className="panel p-4">
        <h2 className="t-section">{t.billing.elevenTitle}</h2>
        <p className="mt-2 text-[13px] text-[var(--color-muted)]">{t.billing.elevenNoData}</p>
      </div>
    );
  }
  const pct =
    runway.total && runway.total > 0 ? Math.max(0, Math.min(100, (runway.remainingCredits / runway.total) * 100)) : null;
  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="t-section">{t.billing.elevenTitle}</h2>
        <span className="mono text-[11px] text-[var(--color-muted)]">
          {runway.tier ? `${runway.tier} · ` : ""}
          {fmt(t.billing.checked, { when: relativeTime(runway.checkedAt) })}
        </span>
      </div>
      <p className="t-figure text-[var(--color-fg)]">{fmt(t.billing.elevenMinutes, { minutes: n0(runway.minMinutes) })}</p>
      <p className="text-[13px] text-[var(--color-muted)]">
        {runway.minVideos !== null && runway.perVideoChars !== null
          ? fmt(t.billing.elevenVideos, { videos: n0(runway.minVideos), chars: n0(runway.perVideoChars) })
          : t.billing.elevenNoHistory}
      </p>
      {pct !== null && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]" aria-hidden>
          <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="mono text-[11px] text-[var(--color-muted)]">
        {runway.total !== null
          ? fmt(t.billing.elevenCredits, { remaining: n0(runway.remainingCredits), total: n0(runway.total) })
          : n0(runway.remainingCredits)}
        {runway.resetsAt ? ` · ${fmt(t.billing.elevenResets, { date: runway.resetsAt.slice(0, 10) })}` : ""}
      </p>
    </div>
  );
}

function ProviderCard({ p, onSaved }: { p: ProviderView; onSaved: () => void }) {
  const { t } = useI18n();
  const [price, setPrice] = useState(p.price === null ? "" : String(p.price));
  const [state, setState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [paying, setPaying] = useState(false);
  // Suggested top-up: what covers the next 30 days at the current burn.
  const suggested = planTopups([{ id: p.id, usdPerDay: p.usdPerDay, balanceUsd: p.balanceUsd }], 30).lines[0].amount;

  async function save() {
    setState("busy");
    try {
      const res = await fetch("/api/billing/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p.id, usd_per_unit: price.trim() === "" ? null : Number(price) }),
      });
      setState(res.ok ? "ok" : "fail");
      if (res.ok) onSaved();
    } catch {
      setState("fail");
    }
  }

  const balance = p.apiBalance && p.apiBalance.remaining !== null
    ? `${n0(p.apiBalance.remaining)} ${p.apiBalance.unit}`
    : p.ledgerUsd !== null
      ? fmt(t.billing.balanceLedger, { usd: usd(p.ledgerUsd) })
      : t.billing.balanceUnknown;

  const lasts =
    p.daysLeft === "never"
      ? t.billing.never
      : p.daysLeft === null
        ? t.billing.unknown
        : fmt(t.billing.days, { n: Math.floor(p.daysLeft) });
  const low = typeof p.daysLeft === "number" && p.daysLeft <= p.lowBalanceDays && !p.autoRecharge;

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">{p.name}</h3>
        <StatusPill tone={p.keySet ? "ok" : "idle"} label={p.keySet ? t.billing.keySet : t.billing.keyMissing} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        <dt className="text-[var(--color-muted)]">{t.billing.balance}</dt>
        <dd className="mono text-right text-[var(--color-fg)]">{balance}</dd>
        <dt className="text-[var(--color-muted)]">{t.billing.usage30}</dt>
        <dd className="mono text-right text-[var(--color-fg)]">
          {n0(p.units30)}
          {p.usdPerDay !== null && p.usdPerDay > 0 ? ` · ${usd(p.usdPerDay)}${t.billing.perDay}` : ""}
        </dd>
        <dt className="text-[var(--color-muted)]">{t.billing.lasts}</dt>
        <dd className="mono text-right" style={{ color: low ? "var(--color-warn)" : "var(--color-fg)" }}>
          {lasts}
        </dd>
      </dl>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
          {fmt(t.billing.price, { unit: p.unitLabel })}
        </span>
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              setState("idle");
            }}
            placeholder={t.billing.pricePlaceholder}
            className="pill min-w-0 flex-1 border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
          />
          <button
            type="button"
            onClick={save}
            disabled={state === "busy"}
            className="btn-sky is-quiet pill px-3 py-1.5 text-[12px] disabled:opacity-40"
          >
            {state === "ok" ? t.billing.saved : t.billing.save}
          </button>
        </div>
        {state === "fail" && <span className="text-[11px] text-[var(--color-fail)]">{t.billing.saveFailed}</span>}
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setPaying((v) => !v)}
          aria-expanded={paying}
          className="cta-glass pill px-4 py-1.5 text-[12px] font-semibold"
        >
          {t.billing.pay}
        </button>
        <a
          href={p.billingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-primary)] hover:underline"
        >
          {t.billing.openBilling}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
      {paying && <PayPanel p={p} suggested={suggested} onDone={onSaved} />}
    </div>
  );
}
