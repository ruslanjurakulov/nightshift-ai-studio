/**
 * The four live cards at the top of the owner's Nightshift AI (/owner/ai), read from figures the Owner Console already has: the
 * owner's facts (people, health, provider plan) and Owner Analytics' money rows. Pure: the page reads, this decides what each card
 * may say.
 *
 * Every card is one of: a value with the state its source gives it (measured / estimated), "unknown" with the reason in words, or
 * "error" (the read failed and asking again can help). A missing count is never drawn as 0 — an unapplied migration or a renamed
 * key must look like a gap on the owner's screen, not like "no signups" or "nothing failed" (CLAUDE.md rule 5).
 */
import { summarize, type MoneyRow } from "@/lib/owner-analytics/money";
import { tashkentDay, tashkentDayStartUtc } from "@/lib/owner-analytics/period";
import type { PlanLine } from "@/lib/owner-analytics/payment-plan";
import type { OwnerFacts } from "./facts-types";
import { block, healthView, peopleView } from "./facts-view";

export type KpiCard<T> =
  | { state: "measured" | "estimated"; value: T; hint?: KpiHint }
  | { state: "unknown"; why: string }
  | { state: "error" };

/** A second line under a value: a subset, a caveat. Only ever a fact the source gave, never a guess. */
export type KpiHint = { kind: "truncated" } | { kind: "refused"; n: number } | { kind: "unjudged"; n: number };

export interface RunwayValue {
  /** null when no provider is tracked at all. */
  name: string | null;
  /** The soonest provider's day it runs out (ISO day), "empty" when it already refuses work, "never" at a zero pace. */
  runsOut: string | "empty" | "never" | null;
  /** True when it runs out inside the payment plan's window (a warning), false when even the soonest lasts beyond it. */
  due: boolean;
  days: number;
}

export interface AiKpis {
  revenueToday: KpiCard<number>;
  signups24h: KpiCard<number>;
  failed24h: KpiCard<number>;
  runway: KpiCard<RunwayValue>;
}

/** Money read result, as lib/server/owner-analytics returns it (kept structural so this file stays importable anywhere). */
export type MoneyRead = { ok: true; data: MoneyRow[]; truncated: boolean } | { ok: false; reason: "missing" | "forbidden" | "session" | "error" };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** "Today" is the owner's calendar day in Tashkent (as Owner Analytics' "today" preset), not the server's UTC day. */
export function tashkentDayStart(nowMs: number): string {
  return tashkentDayStartUtc(tashkentDay(new Date(nowMs)));
}

/** A reason that asking again can fix (a read that failed) is an error with a retry; anything else is an honest unknown. */
function gap(why: string): { state: "unknown"; why: string } | { state: "error" } {
  const w = why.toLowerCase();
  return w.includes("read failed") || w.includes("empty answer") ? { state: "error" } : { state: "unknown", why };
}

export function revenueTodayCard(money: MoneyRead, nowMs: number): KpiCard<number> {
  if (!money.ok) return money.reason === "missing" ? { state: "unknown", why: "migration 0182 is not applied" } : { state: "error" };
  const s = summarize(money.data, { from: tashkentDayStart(nowMs), to: new Date(nowMs).toISOString() });
  // A sale with no amount makes the total a floor: the facts builder says "unknown" for the same case, and so does this card.
  if (s.netBeforeFees.unknownCount > 0) return { state: "unknown", why: `${s.netBeforeFees.unknownCount} payment(s) had no amount` };
  return { state: "measured", value: r2(s.netBeforeFees.usd), ...(money.truncated ? { hint: { kind: "truncated" as const } } : {}) };
}

export function signupsCard(facts: OwnerFacts): KpiCard<number> {
  const b = block(facts.people);
  if (!b.ok) return gap(b.why);
  const d1 = peopleView(b.doc).signups.d1;
  return d1 === null ? { state: "unknown", why: "" } : { state: "measured", value: d1 };
}

export function failedCard(facts: OwnerFacts): KpiCard<number> {
  const b = block(facts.health);
  if (!b.ok) return gap(b.why);
  const h = healthView(b.doc);
  // Both queues or nothing: a sum with one side missing would undercount and still look measured.
  if (h.creative.failed24h === null || h.render.failed24h === null) return { state: "unknown", why: "" };
  const refused = h.creative.quotaFailed24h;
  return {
    state: "measured",
    value: h.creative.failed24h + h.render.failed24h,
    ...(refused !== null && refused > 0 ? { hint: { kind: "refused" as const, n: refused } } : {}),
  };
}

const soonest = (lines: PlanLine[]) =>
  [...lines].sort((a, b) => rank(a) - rank(b) || String(a.runsOutOn).localeCompare(String(b.runsOutOn)))[0];
const rank = (l: PlanLine) => (l.reason === "empty" ? 0 : l.runsOutOn === "never" ? 2 : 1);

export function runwayCard(facts: OwnerFacts): KpiCard<RunwayValue> {
  const p = facts.providers;
  if (p.state === "unknown") return gap(p.why);
  const plan = p.value.plan;
  const unjudged = plan.unknown.length;
  const hint = unjudged > 0 ? { hint: { kind: "unjudged" as const, n: unjudged } } : {};
  // The plan already sorts what is due soonest first; a line runs out on a day computed from a 14-day pace, so the card is
  // "estimated" even when the balance itself was a provider's reading.
  const line = plan.due[0] ?? soonest(plan.fine);
  if (!line) {
    if (unjudged > 0) return { state: "unknown", why: "no reading" };
    return { state: "estimated", value: { name: null, runsOut: null, due: false, days: plan.days } };
  }
  return {
    state: "estimated",
    value: { name: line.name, runsOut: line.reason === "empty" ? "empty" : line.runsOutOn, due: plan.due.length > 0, days: plan.days },
    ...hint,
  };
}

export function aiKpis(facts: OwnerFacts, money: MoneyRead, nowMs: number): AiKpis {
  return { revenueToday: revenueTodayCard(money, nowMs), signups24h: signupsCard(facts), failed24h: failedCard(facts), runway: runwayCard(facts) };
}
