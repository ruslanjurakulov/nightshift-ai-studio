"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatCard } from "@/components/ui";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Meter } from "@/components/ui/Meter";
import { StateBlock } from "@/components/states/StateBlock";
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
      <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-3">
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
            className="btn-quiet w-fit disabled:opacity-40"
          >
            <RefreshCw className="size-4" aria-hidden />
            {refresh === "busy" ? t.billing.refreshing : t.billing.refresh}
          </button>
          <span className="g5-note" aria-live="polite">
            {refresh === "ok" && <span className="text-[var(--color-ok)]">{t.billing.refreshQueued}</span>}
            {refresh === "fail" && <span className="g5-fail-text">{t.billing.refreshFailed}</span>}
          </span>
        </div>
      </div>

      <ElevenLabsPanel runway={runway} />

      <section className="panel" aria-labelledby="bl-providers">
        <div className="g5-sechead">
          <h2 id="bl-providers" className="g5-h">
            {t.billing.providersTitle}
          </h2>
        </div>
        <ul className="g5-rows">
          {providers.map((p) => (
            <ProviderRow key={p.id} p={p} onSaved={() => router.refresh()} />
          ))}
        </ul>
      </section>

      <BulkPay providers={providers} onDone={() => router.refresh()} />
    </div>
  );
}

function ElevenLabsPanel({ runway }: { runway: RunwayView | null }) {
  const { t, locale } = useI18n();
  if (!runway) {
    return (
      <section className="panel" aria-labelledby="bl-eleven">
        <div className="g5-sechead">
          <h2 id="bl-eleven" className="g5-h">
            {t.billing.elevenTitle}
          </h2>
        </div>
        <StateBlock tone="idle" compact>
          {t.billing.elevenNoData}
        </StateBlock>
      </section>
    );
  }
  return (
    <section className="panel flex flex-col gap-4" aria-labelledby="bl-eleven">
      <div className="g5-sechead" style={{ marginBottom: 0 }}>
        <h2 id="bl-eleven" className="g5-h">
          {t.billing.elevenTitle}
        </h2>
        <span className="g5-note">
          {runway.tier ? `${runway.tier} · ` : ""}
          {fmt(t.billing.checked, { when: relativeTime(runway.checkedAt, locale) })}
        </span>
      </div>
      <p className="g5-figure">{fmt(t.billing.elevenMinutes, { minutes: n0(runway.minMinutes) })}</p>
      <p className="g5-sub" style={{ marginTop: 0 }}>
        {runway.minVideos !== null && runway.perVideoChars !== null
          ? fmt(t.billing.elevenVideos, { videos: n0(runway.minVideos), chars: n0(runway.perVideoChars) })
          : t.billing.elevenNoHistory}
      </p>
      {runway.total !== null && runway.total > 0 && (
        <Meter
          value={runway.remainingCredits}
          max={runway.total}
          size="lg"
          segments={24}
          label={t.billing.elevenTitle}
          valueText={fmt(t.billing.elevenCredits, { remaining: n0(runway.remainingCredits), total: n0(runway.total) })}
        />
      )}
      <p className="g5-note">
        {runway.total !== null
          ? fmt(t.billing.elevenCredits, { remaining: n0(runway.remainingCredits), total: n0(runway.total) })
          : n0(runway.remainingCredits)}
        {runway.resetsAt ? ` · ${fmt(t.billing.elevenResets, { date: runway.resetsAt.slice(0, 10) })}` : ""}
      </p>
    </section>
  );
}

function ProviderRow({ p, onSaved }: { p: ProviderView; onSaved: () => void }) {
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
    <li className="g5-row g5-prov">
      <div className="flex min-w-0 flex-col items-start gap-2">
        <h3 className="g5-row-title" style={{ fontWeight: 600 }}>
          {p.name}
        </h3>
        <StatusLamp tone={p.keySet ? "ok" : "idle"} label={p.keySet ? t.billing.keySet : t.billing.keyMissing} />
      </div>
      <dl className="g5-prov-facts">
        <div>
          <dt className="g5-k">{t.billing.balance}</dt>
          <dd>{balance}</dd>
        </div>
        <div>
          <dt className="g5-k">{t.billing.usage30}</dt>
          <dd>
            {n0(p.units30)}
            {p.usdPerDay !== null && p.usdPerDay > 0 ? ` · ${usd(p.usdPerDay)}${t.billing.perDay}` : ""}
          </dd>
        </div>
        <div>
          <dt className="g5-k">{t.billing.lasts}</dt>
          <dd style={{ color: low ? "var(--color-warn)" : undefined }}>{lasts}</dd>
        </div>
      </dl>
      <div className="g5-prov-act">
      <div className="g5-prov-price">
        <label className="g5-field">
          <span className="g5-k">{fmt(t.billing.price, { unit: p.unitLabel })}</span>
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
            className="ns-field tnum"
          />
        </label>
        <button type="button" onClick={save} disabled={state === "busy"} className="btn-quiet disabled:opacity-40">
          {state === "ok" ? t.billing.saved : t.billing.save}
        </button>
      </div>
      <div className="g5-prov-end">
        <button type="button" onClick={() => setPaying((v) => !v)} aria-expanded={paying} className="btn-quiet">
          {t.billing.pay}
        </button>
        <a href={p.billingUrl} target="_blank" rel="noopener noreferrer" className="g5-link">
          {t.billing.openBilling}
          <ExternalLink className="size-4" aria-hidden />
        </a>
      </div>
      </div>
      {state === "fail" && (
        <p role="alert" className="g5-note g5-fail-text" style={{ gridColumn: "1 / -1" }}>
          {t.billing.saveFailed}
        </p>
      )}
      {paying && (
        <div style={{ gridColumn: "1 / -1" }}>
          <PayPanel p={p} suggested={suggested} onDone={onSaved} />
        </div>
      )}
    </li>
  );
}
