/**
 * The provider runway's tables, shared by the page and the export route. Pure. An unknown is a null cell or the word for why;
 * an estimate says it is one and how it was made; every balance carries the time it is "as of".
 */

import type { Dictionary } from "@/lib/i18n";
import type { Table } from "./export";
import { fill, tashkentDateTime } from "./format";
import { TIMEZONE } from "./period";
import type { ProviderRunway, RunwayStatus } from "./runway";

type D = Dictionary["ownerAnalytics"];
const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The machine's words for a unit and an outcome, in the reader's language; an unlisted one is shown as stored. */
export function unitText(d: D, unit: string): string {
  const u: Record<string, string> = {
    credits: d.unitCredits, usd: d.usd, tokens: d.unitTokens, second: d.unitSeconds, seconds: d.unitSeconds, image: d.unitImages,
    images: d.unitImages, character: d.unitCharacters, characters: d.unitCharacters, tts_characters: d.unitCharacters, request: d.unitRequests,
  };
  return u[unit.toLowerCase()] ?? unit;
}
export function outcomeText(d: D, s: string): string {
  const o: Record<string, string> = {
    completed: d.outcomeCompleted, failed: d.outcomeFailed, cancelled: d.outcomeCancelled, expired: d.outcomeExpired,
    probe_ok: d.outcomeProbeOk, probe_failed: d.outcomeProbeFailed,
  };
  return o[s] ?? s;
}

export const statusText = (d: D, s: RunwayStatus) =>
  s === "empty" ? d.runwayEmpty : s === "low" ? d.runwayLow : s === "ok" ? d.runwayOk : d.unknown;

export function daysText(d: D, v: number | "never" | null): string | number | null {
  return v === null ? null : v === "never" ? d.runwayNeverAtPace : r1(v);
}

/** How "left" was arrived at, in words: the provider's reading and its time, the estimate's method, or why it is unknown. */
export function leftBasis(d: D, r: ProviderRunway): string {
  const rem = r.ledger.remaining;
  if (rem.kind === "reported") {
    const reading = `${(Math.round(rem.amount * 100) / 100).toLocaleString("en-US")} ${unitText(d, rem.unit)}`;
    return `${fill(d.runwayReported, { when: tashkentDateTime(rem.checkedAt) })}: ${reading}${r.nativeRunway ? ` · ${d.runwayNativeNote}` : ""}`;
  }
  if (rem.kind === "estimate") {
    const since = r.ledger.bought.state === "ok" ? tashkentDateTime(new Date(r.ledger.bought.firstMs).toISOString()) : "";
    return fill(d.runwayEstimated, { since });
  }
  const why = rem.why;
  return why === "no_topup"
    ? d.runwayNoTopup
    : why === "negative"
      ? d.runwayNegative
      : why === "unread"
        ? d.runwayUnread
        : d.runwayUsedUnknown;
}

function notes(d: D, r: ProviderRunway): string {
  const out: string[] = [];
  if (r.quotaAt) out.push(fill(d.runwayQuotaAt, { when: tashkentDateTime(r.quotaAt) }));
  if (r.beforeTrackingUnknown) out.push(d.runwayBeforeTracking);
  if (r.autoRecharge) out.push(d.runwayAutoRecharge);
  if (r.estimate && r.leftUsd !== null) out.push(d.runwayIsEstimate);
  if (r.pipelineStale) out.push(d.runwayPipelineStale);
  if (r.emptyUnchecked) out.push(d.runwayEmptyUnchecked);
  return out.join(" · ");
}

function preamble(d: D, title: string, asOf: number, present: boolean): string[] {
  return [
    fill(d.reportTitle, { title }),
    fill(d.runwayAsOf, { when: `${tashkentDateTime(new Date(asOf).toISOString())} (${TIMEZONE})` }),
    d.runwayMethod,
    d.costsOwnerOnly,
    ...(present ? [d.presentOn] : []),
  ];
}

export function runwayProvidersTable(d: D, rows: ProviderRunway[], asOf: number, present = false): Table {
  return {
    name: d.runwayProviders,
    preamble: preamble(d, d.runwayProviders, asOf, present),
    columns: [
      d.providerName,
      d.runwayStatus,
      `${d.runwayLeft}, ${d.usd}`,
      d.runwayLeftBasis,
      `${d.runwayBought}, ${d.usd}`,
      `${d.runwaySpentSince}, ${d.usd}`,
      `${d.runwaySpent24h}, ${d.usd}`,
      `${d.runwaySpent7d}, ${d.usd}`,
      `${d.runwayBurn7d}, ${d.usd}`,
      d.runwayRunsOut,
      d.runwayRange,
      d.note,
    ],
    rows: rows.map((r) => [
      r.name,
      statusText(d, r.status),
      r2(r.leftUsd),
      leftBasis(d, r),
      r.ledger.bought.state === "ok" ? r2(r.ledger.bought.usd) : r.ledger.bought.state === "none" ? d.runwayNoTopup : null,
      // With no top-up the ledger counts the last 30 days, which is not "since the first top-up": no figure here.
      r.ledger.bought.state === "ok" ? r2(r.ledger.used.usd) : d.runwayNoTopup,
      r2(r.usd24h),
      r2(r.usd7d),
      r2(r.burn7d),
      // An empty provider has run out already, whatever an estimate of what is left says.
      r.status === "empty" ? d.runwayEmpty : daysText(d, r.runsOut),
      r.status === "empty"
        ? d.runwayEmpty
        : r.runsOutRange
          ? r.runsOutRange[0] === r.runsOutRange[1]
            ? daysText(d, r.runsOutRange[0])
            : `${daysText(d, r.runsOutRange[0])} – ${daysText(d, r.runsOutRange[1])}`
          : null,
      notes(d, r),
    ]),
  };
}

export function runwayModelsTable(d: D, rows: ProviderRunway[], asOf: number, present = false): Table {
  return {
    name: d.runwayModels,
    preamble: [...preamble(d, d.runwayModels, asOf, present), d.runwayModelsNote],
    columns: [
      d.providerName,
      d.model,
      d.runwayJobs24h,
      d.runwayJobs7d,
      d.runwayUnits7d,
      d.unit,
      d.runwayProbes7d,
      d.runwayFailedCalls7d,
      `${d.runwaySpent7d}, ${d.usd}`,
      d.runwaySpendBasis,
      d.runwayLastAt,
      d.runwayLastOutcome,
    ],
    rows: rows.flatMap((r) =>
      r.models.map((m) => [
        r.name,
        m.model,
        m.jobs1d,
        m.jobs7d,
        m.units7d === null ? null : r2(m.units7d),
        m.unit === null ? "" : m.unitsFloor ? `${unitText(d, m.unit)} (${d.runwayAtLeast})` : unitText(d, m.unit),
        m.probes7d,
        m.failedCalls7d,
        r2(m.usd7d),
        m.usd7dPriced > 0 || m.usd7d === null ? (m.usd7dEstimate ? d.runwayIsEstimate : d.runwayBilled) : "",
        m.lastAt ? tashkentDateTime(m.lastAt) : null,
        m.lastStatus === null ? null : m.lastErrorCode ? `${outcomeText(d, m.lastStatus)}: ${m.lastErrorCode}` : outcomeText(d, m.lastStatus),
      ]),
    ),
  };
}
