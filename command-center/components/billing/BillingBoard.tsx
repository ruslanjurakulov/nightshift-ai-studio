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
import { formatNumber, formatUsdAmount } from "@/lib/number-format";
import { planTopups, type ElevenLabsRunway } from "@/lib/billing";
import { BulkPay, PayPanel } from "@/components/billing/TopupControls";
import { postOperator } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";

/** One paid provider, already derived on the server (see billing/page.tsx). */
export interface ProviderView {
  id: string;
  name: string;
  billingUrl: string;
  unitLabel: string;
  keySet: boolean;
  /** The key-name read (GitHub) failed: the lamp says "unknown", not "key missing". */
  keyUnknown?: boolean;
  price: number | null;
  /** False when nothing in the cost ledger maps to this provider (Anthropic, OpenAI): its usage is not tracked. */
  tracked?: boolean;
  /** Units used in the window, or null when the spend could not be read / is not tracked. */
  units30: number | null;
  /** The days `units30` and the per-day figure are averaged over: 30, or fewer when this provider is younger than that. */
  windowDays?: number;
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
  /** "untracked": spend is not recorded here. "auto": the provider tops itself up. null: unknown. */
  daysLeft: number | "never" | "untracked" | "auto" | null;
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

/** Dollars, grouped and fixed ("$1,234.56", three decimals under $1): the same text on the server and in the browser. */
export function usd(v: number | null, locale = "en"): string {
  if (v === null) return "—";
  const small = Math.abs(v) < 1 && v !== 0;
  return formatUsdAmount(v, locale, small ? 3 : 2, small ? 3 : 2);
}

const n0 = (v: number, locale = "en") => formatNumber(Math.round(v), locale, 0);

export function BillingBoard({
  providers,
  runway,
  githubConfigured,
  spendUnknown = false,
  spendNoRows = false,
  lastSync = null,
  basisDays = 30,
  runwayUnknown = false,
}: {
  providers: ProviderView[];
  runway: RunwayView | null;
  githubConfigured: boolean;
  /** The spend ledger or the prices could not be read: the 30-day figure is unknown, not $0. */
  spendUnknown?: boolean;
  /** The ledger read worked and has no rows: "no rows yet", never a measured $0. */
  spendNoRows?: boolean;
  /** When the nightly mirror last wrote a cost row, already formatted; the ledger is only as fresh as this. */
  lastSync?: string | null;
  /** The days the headline figure is really averaged over (30, or fewer for a young ledger). */
  basisDays?: number;
  /** The balance snapshots could not be read: the ElevenLabs panel says so instead of "no data yet". */
  runwayUnknown?: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [refresh, setRefresh] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [refreshWhy, setRefreshWhy] = useState<string | null>(null);

  const known = providers.filter((p) => p.usdPerDay !== null);
  const spend30 = spendUnknown ? null : known.length ? known.reduce((s, p) => s + (p.usdPerDay ?? 0) * 30, 0) : null;
  const partial = providers.some((p) => p.usdPerDay === null);
  const running = providers
    .filter((p) => typeof p.daysLeft === "number" && !p.autoRecharge)
    .sort((a, b) => (a.daysLeft as number) - (b.daysLeft as number));
  const first = running[0] ?? null;

  async function doRefresh() {
    setRefresh("busy");
    setRefreshWhy(null);
    // "Started" only when the server said so: a sign-in page or a redirect answers 200 too (lib/operator-post.ts).
    const out = await postOperator("/api/billing/refresh");
    if (out.ok) {
      setRefresh("ok");
      return;
    }
    setRefreshWhy(operatorFailureText(t, out, t.billing.refreshFailed));
    setRefresh("fail");
  }

  return (
    <div className="rhythm stagger-enter">
      <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-3">
        <StatCard
          label={basisDays > 0 && basisDays < 30 ? t.ownerTruth.spendPace : t.billing.statBurn30}
          value={spendUnknown ? t.common.unknown : spendNoRows ? t.ownerTruth.noRowsYet : usd(spend30, locale)}
          sub={
            spendUnknown
              ? t.common.couldNotRead
              : [
                  partial ? t.billing.partialNote : "",
                  basisDays > 0 && basisDays < 30 ? fmt(t.ownerTruth.basedOnDays, { n: basisDays }) : "",
                  // The cost ledger is mirrored nightly: say how old it is.
                  lastSync ? fmt(t.ownerTruth.lastSync, { when: lastSync }) : spendNoRows ? "" : t.ownerTruth.syncUnknown,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
          }
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
            {refresh === "fail" && <span className="g5-fail-text">{refreshWhy ?? t.billing.refreshFailed}</span>}
          </span>
        </div>
      </div>

      <ElevenLabsPanel runway={runway} unknown={runwayUnknown} />

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

function ElevenLabsPanel({ runway, unknown }: { runway: RunwayView | null; unknown: boolean }) {
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
          {unknown ? t.common.couldNotRead : t.billing.elevenNoData}
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
      <p className="g5-figure">{fmt(t.billing.elevenMinutes, { minutes: n0(runway.minMinutes, locale) })}</p>
      <p className="g5-sub" style={{ marginTop: 0 }}>
        {runway.minVideos !== null && runway.perVideoChars !== null
          ? fmt(t.billing.elevenVideos, { videos: n0(runway.minVideos, locale), chars: n0(runway.perVideoChars, locale) })
          : t.billing.elevenNoHistory}
      </p>
      {runway.total !== null && runway.total > 0 && (
        <Meter
          value={runway.remainingCredits}
          max={runway.total}
          size="lg"
          segments={24}
          label={t.billing.elevenTitle}
          valueText={fmt(t.billing.elevenCredits, { remaining: n0(runway.remainingCredits, locale), total: n0(runway.total, locale) })}
        />
      )}
      <p className="g5-note">
        {runway.total !== null
          ? fmt(t.billing.elevenCredits, { remaining: n0(runway.remainingCredits, locale), total: n0(runway.total, locale) })
          : n0(runway.remainingCredits, locale)}
        {runway.resetsAt ? ` · ${fmt(t.billing.elevenResets, { date: runway.resetsAt.slice(0, 10) })}` : ""}
      </p>
    </section>
  );
}

function ProviderRow({ p, onSaved }: { p: ProviderView; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const [price, setPrice] = useState(p.price === null ? "" : String(p.price));
  const [state, setState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [failWhy, setFailWhy] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  // Suggested top-up: what covers the next 30 days at the current burn.
  const suggested = planTopups([{ id: p.id, usdPerDay: p.usdPerDay, balanceUsd: p.balanceUsd }], 30).lines[0].amount;

  async function save() {
    setState("busy");
    setFailWhy(null);
    const out = await postOperator("/api/billing/settings", {
      provider: p.id,
      usd_per_unit: price.trim() === "" ? null : Number(price),
    });
    if (!out.ok) {
      setFailWhy(operatorFailureText(t, out, t.billing.saveFailed));
      setState("fail");
      return;
    }
    setState("ok");
    onSaved();
  }

  const balance = p.apiBalance && p.apiBalance.remaining !== null
    ? `${n0(p.apiBalance.remaining, locale)} ${p.apiBalance.unit}`
    : p.ledgerUsd !== null
      ? fmt(t.billing.balanceLedger, { usd: usd(p.ledgerUsd, locale) })
      : t.billing.balanceUnknown;

  const lasts =
    p.daysLeft === "never"
      ? t.billing.never
      : p.daysLeft === "untracked"
        ? t.ownerTruth.notTracked
        : p.daysLeft === "auto"
          ? t.ownerTruth.autoRechargeOn
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
        <StatusLamp
          tone={p.keyUnknown ? "warn" : p.keySet ? "ok" : "idle"}
          label={p.keyUnknown ? t.billing.unknown : p.keySet ? t.billing.keySet : t.billing.keyMissing}
        />
      </div>
      <dl className="g5-prov-facts">
        <div>
          <dt className="g5-k">{t.billing.balance}</dt>
          <dd>{balance}</dd>
        </div>
        <div>
          <dt className="g5-k">
            {p.windowDays !== undefined && p.windowDays < 29.5 ? fmt(t.ownerTruth.usedLastDays, { n: Math.max(1, Math.round(p.windowDays)) }) : t.billing.usage30}
          </dt>
          <dd>
            {p.tracked === false
              ? t.ownerTruth.notTracked
              : p.units30 === null
                ? t.billing.unknown
                : n0(p.units30, locale)}
            {p.units30 !== null && p.usdPerDay !== null && p.usdPerDay > 0 ? ` · ${usd(p.usdPerDay, locale)}${t.billing.perDay}` : ""}
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
          {failWhy ?? t.billing.saveFailed}
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
