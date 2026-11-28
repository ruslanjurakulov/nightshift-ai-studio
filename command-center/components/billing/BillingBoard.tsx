"use client";

import { createContext, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatCard } from "@/components/ui";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Meter } from "@/components/ui/Meter";
import { StateBlock } from "@/components/states/StateBlock";
import { relativeTime } from "@/lib/format";
import { formatNumber, formatUsdOwner } from "@/lib/number-format";
// Types only from lib/billing (erased at compile time): the module itself is server-only, and the vendor rows reach
// this board as ProviderView props computed on the server.
import type { ElevenLabsRunway, ProviderLedger, SourceUse } from "@/lib/billing";
import { planTopups } from "@/lib/topup-plan";
import { BulkPay, PayPanel } from "@/components/billing/TopupControls";
import { postOperator } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";
import type { BillingLedgerDictionary } from "@/lib/i18n/billing-ledger/en";

/** One paid provider, already derived on the server (see billing/page.tsx). */
export interface ProviderView {
  id: string;
  name: string;
  /**
   * The vendor's own top-up page (lib/billing.ts billingUrl), or null when none was verified in its docs: no link is shown
   * rather than a guess. Named apart from the server field so scripts/billing-bundle-check.mjs can fail on `billingUrl`
   * anywhere in a static chunk; the value reaches only the signed-in operator's page response.
   */
  payUrl: string | null;
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
  /** `daysLeft` came from the owner's ledger and rests on an estimate (a list price, or bought minus used): the cell says so. */
  daysLeftEstimate?: boolean;
  lowBalanceDays: number;
  includeInBulk: boolean;
  cardSaved: boolean;
  autoRecharge: boolean;
  /** False when the YouTube pipeline never calls this vendor (Studio and probes only): no pipeline figure, no pipeline price. */
  pipeline?: boolean;
  /** USD per vendor credit, or null when the vendor sells none at a fixed price (lib/billing.ts creditUsd, server-side). */
  usdPerCredit?: number | null;
  /** The owner's ledger: bought, used by source, left (lib/billing.ts providerLedger). Absent: the page did not compute one. */
  ledger?: ProviderLedger;
}

export type RunwayView = ElevenLabsRunway & {
  total: number | null;
  resetsAt: string | null;
  tier: string | null;
  checkedAt: string;
};

/** Dollars, grouped and fixed ("$1,234.56", three decimals under $1): the same text on the server and in the browser. */
export function usd(v: number | null, locale = "en"): string {
  return v === null ? "—" : formatUsdOwner(v, locale);
}

const n0 = (v: number, locale = "en") => formatNumber(Math.round(v), locale, 0);

/** The words for the vendor-named ledger units (lib/server/ledger-unit-labels.ts), from the page: not in the dictionary. */
const NO_WORDS: Readonly<Record<string, string>> = {};
const UnitWords = createContext(NO_WORDS);

export function BillingBoard({
  unitLabels = NO_WORDS,
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
  /** unit -> measure word for the ledger units whose names carry a vendor, resolved on the server. */
  unitLabels?: Readonly<Record<string, string>>;
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
  // "Nothing is running out" is only true when every provider is known not to be (not in use, topped up by itself, or
  // not tracked); a provider whose days left is unknown keeps the answer unknown.
  const nothingRunningOut = providers.every((p) => p.daysLeft === "never" || p.daysLeft === "auto" || p.daysLeft === "untracked");

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
    <UnitWords.Provider value={unitLabels}>
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
                    // The headline is the pipeline's ledger; Studio and the probes are counted on each provider's row.
                    t.billingLedger.headlinePipelineOnly,
                    basisDays > 0 && basisDays < 30 ? fmt(basisDays === 1 ? t.ownerTruth.basedOnDay : t.ownerTruth.basedOnDays, { n: basisDays }) : "",
                    // The cost ledger is mirrored nightly: say how old it is.
                    lastSync ? fmt(t.ownerTruth.lastSync, { when: lastSync }) : spendNoRows ? "" : t.ownerTruth.syncUnknown,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
            }
          />
          <StatCard
            label={t.billing.statFirstOut}
            value={first ? first.name : nothingRunningOut ? t.billing.statFirstOutNone : t.common.unknown}
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
    </UnitWords.Provider>
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

/** The vendor's word for a unit, in the owner's language; a unit the dictionary does not know is shown as stored. */
function unitWord(units: Record<string, string>, unit: string): string {
  return Object.prototype.hasOwnProperty.call(units, unit) ? units[unit] : unit;
}

/** A UTC calendar day, as the ledger counts days ("2026-11-13"): the same text on the server and in the browser. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One source of use (pipeline, Studio, probes) as one line: a figure, or exactly why there is none. */
export function sourceText(src: SourceUse, usdPerCredit: number | null, tl: BillingLedgerDictionary, locale: string): string {
  if (src.state === "unread") return tl.state.unread;
  if (src.state === "untracked") return tl.state.untracked;
  if (src.state === "not_used") return tl.state.notUsed;
  if (src.state === "no_rows") return tl.state.noRows;
  if (src.state === "ok" && src.rows === 0) return tl.state.none;
  const bits: string[] = [];
  if (src.usd !== null) {
    bits.push(usd(src.usd, locale));
    if (usdPerCredit) bits.push(fmt(tl.credits, { n: formatNumber(src.usd / usdPerCredit, locale, 2) }));
  } else if (src.pricedUsd > 0) {
    bits.push(fmt(tl.atLeast, { usd: usd(src.pricedUsd, locale) }));
  }
  if (src.estimate) bits.push(tl.estimate);
  for (const u of src.unpriced) {
    bits.push(
      u.quantity !== null
        ? fmt(tl.usdUnknown, { qty: formatNumber(u.quantity, locale, 2), unit: unitWord(tl.units, u.unit) })
        : fmt(tl.rowsUsdUnknown, { unit: unitWord(tl.units, u.unit), n: u.rows }),
    );
  }
  if (src.billingUnknown > 0) bits.push(fmt(tl.billingUnknown, { n: src.billingUnknown }));
  if (src.failedCalls > 0) bits.push(fmt(tl.failedCalls, { n: src.failedCalls }));
  if (src.state === "partial") bits.push(tl.state.partial);
  return bits.join(" · ");
}

/** Bought, used (with its three sources) and left: the owner's ledger of one provider. Every unknown says why. */
function LedgerFacts({ ledger, usdPerCredit }: { ledger: ProviderLedger; usdPerCredit: number | null }) {
  const { t, locale } = useI18n();
  const words = useContext(UnitWords);
  const tl = { ...t.billingLedger, units: { ...t.billingLedger.units, ...words } };
  const credits = (usdValue: number) => (usdPerCredit ? fmt(tl.credits, { n: formatNumber(usdValue / usdPerCredit, locale, 2) }) : "");
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");

  const b = ledger.bought;
  const bought = b.state === "unread" ? tl.state.unread : b.state === "none" ? tl.boughtNone : join(usd(b.usd, locale), credits(b.usd));

  const sources = [ledger.sources.pipeline, ledger.sources.studio, ledger.sources.probes];
  const nothing = sources.every((s) => s.state === "not_used" || (s.state === "ok" && s.rows === 0));
  const u = ledger.used;
  const used =
    u.usd !== null
      ? nothing
        ? tl.state.none
        : join(usd(u.usd, locale), credits(u.usd), u.estimate ? tl.estimate : "")
      : u.pricedUsd > 0
        ? fmt(tl.atLeast, { usd: usd(u.pricedUsd, locale) })
        : t.billing.unknown;

  const r = ledger.remaining;
  const left =
    r.kind === "reported"
      ? join(`${formatNumber(r.amount, locale, 2)} ${unitWord(tl.units, r.unit)}`, r.usd !== null ? usd(r.usd, locale) : "")
      : r.kind === "estimate"
        ? join(usd(r.usd, locale), credits(r.usd))
        : tl.leftUnknown[r.why];

  return (
    <>
      <div>
        <dt className="g5-k">{tl.bought}</dt>
        <dd>{bought}</dd>
        {b.state === "ok" && <dd className="g5-ledger-sub">{fmt(tl.boughtCount, { n: b.count, date: utcDay(b.firstMs) })}</dd>}
      </div>
      <div className="g5-ledger-used">
        <dt className="g5-k">{ledger.sinceTopup ? fmt(tl.usedSince, { date: utcDay(ledger.startMs) }) : tl.usedLast30}</dt>
        <dd>{used}</dd>
        {(["pipeline", "studio", "probes"] as const).map((k) => (
          <dd key={k} className="g5-ledger-sub" data-source={k}>
            <span className="g5-k">{tl.sources[k]}</span> {sourceText(ledger.sources[k], usdPerCredit, tl, locale)}
          </dd>
        ))}
      </div>
      <div>
        <dt className="g5-k">{tl.left}</dt>
        <dd>{left}</dd>
        {r.kind === "reported" && <dd className="g5-ledger-sub">{fmt(tl.leftReported, { when: relativeTime(r.checkedAt, locale) })}</dd>}
        {r.kind === "estimate" && <dd className="g5-ledger-sub">{tl.leftEstimate}</dd>}
      </div>
    </>
  );
}

function ProviderRow({ p, onSaved }: { p: ProviderView; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const tl = t.billingLedger;
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
            : fmt(t.billing.days, { n: Math.floor(p.daysLeft) }) + (p.daysLeftEstimate ? ` · ${tl.estimate}` : "");
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
        {p.ledger ? (
          <LedgerFacts ledger={p.ledger} usdPerCredit={p.usdPerCredit ?? null} />
        ) : (
          <div>
            <dt className="g5-k">{t.billing.balance}</dt>
            <dd>{balance}</dd>
          </div>
        )}
        {/* The pipeline's own pace (units and dollars a day). A vendor it never calls has no such line: its ledger already says so. */}
        {p.pipeline !== false && (
          <div>
            <dt className="g5-k">
              {p.windowDays !== undefined && p.windowDays < 29.5 ? fmt(Math.round(p.windowDays) <= 1 ? tl.pipelineLastDay : tl.pipelineLastDays, { n: Math.max(1, Math.round(p.windowDays)) }) : tl.pipeline30}
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
        )}
        <div>
          <dt className="g5-k">{t.billing.lasts}</dt>
          <dd style={{ color: low ? "var(--color-warn)" : undefined }}>{lasts}</dd>
        </div>
      </dl>
      <div className="g5-prov-act">
      {/* A price per pipeline unit means nothing for a vendor the pipeline never calls: no field that changes nothing. */}
      {p.pipeline !== false && (
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
      )}
      <div className="g5-prov-end">
        <button type="button" onClick={() => setPaying((v) => !v)} aria-expanded={paying} className="btn-quiet">
          {t.billing.pay}
        </button>
        {p.payUrl ? (
          <a href={p.payUrl} target="_blank" rel="noopener noreferrer" className="g5-link">
            {t.billing.openBilling}
            <ExternalLink className="size-4" aria-hidden />
          </a>
        ) : (
          <span className="g5-note">{tl.noBillingLink}</span>
        )}
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
