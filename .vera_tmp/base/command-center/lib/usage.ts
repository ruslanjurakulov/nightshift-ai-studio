/**
 * The Usage page (migration 0094) — the pure, client-safe half: the workspace's
 * own usage_summary() read, what it means (plan credits used in this billing
 * period, extra credits, the plan's other limits) and the honest states around
 * it. Unit-tested in tests/usage.test.ts.
 *
 * Nothing here is invented. There are no weekly or per-session meters because
 * the platform has none: the only allowance is the plan credits granted for a
 * billing period, and the only other limits are the ones the platform really
 * enforces (parallel runs, queue priority, API access). A figure the database
 * did not give is `null`, never 0 (CLAUDE.md #5); a summary whose numbers are
 * not numbers is a failed read.
 */

import { formatAhead } from "@/lib/date-format";
import { SUBSCRIPTION_STATUSES, type EntitlementType, type EntitlementValue, type PlanMatrix, type SubscriptionStatus } from "@/lib/plans";

const LIVE: readonly SubscriptionStatus[] = ["active", "trialing", "past_due"];

export interface UsageSummary {
  /** The operator's own workspace: never charged, nothing to show. */
  exempt: boolean;
  /** The workspace's switch: may a new run use top-up pack credits after plan credits. */
  extraEnabled: boolean;
  plan: { id: string; name: string; monthlyCredits: number; isDefault: boolean } | null;
  subscription: { status: SubscriptionStatus; periodEnd: string | null; cancelAtPeriodEnd: boolean; live: boolean } | null;
  /** This billing period's plan credits (live lots only); null = none exist right now. */
  planCredits: { granted: number; spent: number; held: number; left: number; periodStart: string | null; periodEnd: string | null } | null;
  /** The end of the latest plan period ever granted (it has expired when planCredits is null). */
  lastPlanPeriodEnd: string | null;
  /** Credits from top-up packs, free to spend, and when the soonest of them expire. */
  extra: { available: number; soonestExpiry: string | null };
  /** Welcome credits, grants and adjustments: spent even with extra credits off. */
  bonus: { available: number; soonestExpiry: string | null };
  /** What a NEW run may draw on right now, under the switch. */
  spendableNow: number;
  runSlots: { limit: number | null; active: number } | null;
  /** The plan's ENFORCED limits only (the database leaves planned ones out). */
  entitlements: Record<string, EntitlementValue>;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * usage_summary()'s jsonb, or null when it is not a usable one: not an object
 * (the person may not read this workspace, or the function is missing), or a
 * figure the page would show is not a number. The caller reads null as "could
 * not read", never as "nothing used".
 */
export function coerceUsageSummary(data: unknown): UsageSummary | null {
  const d = obj(data);
  if (!d || typeof d.extra_enabled !== "boolean") return null;

  const spendableNow = num(d.spendable_now);
  const extra = obj(d.extra_credits);
  const bonus = obj(d.bonus_credits);
  const extraAvail = extra ? num(extra.available) : null;
  const bonusAvail = bonus ? num(bonus.available) : null;
  if (spendableNow === null || extraAvail === null || bonusAvail === null || !extra || !bonus) return null;

  const p = obj(d.plan);
  const plan =
    p && typeof p.id === "string" && typeof p.name === "string"
      ? { id: p.id, name: p.name, monthlyCredits: num(p.monthly_credits) ?? 0, isDefault: p.is_default === true }
      : null;

  const s = obj(d.subscription);
  const status = s && (SUBSCRIPTION_STATUSES as readonly unknown[]).includes(s.status) ? (s.status as SubscriptionStatus) : null;
  const subscription = s && status
    ? { status, periodEnd: iso(s.current_period_end), cancelAtPeriodEnd: s.cancel_at_period_end === true, live: LIVE.includes(status) }
    : null;

  let planCredits: UsageSummary["planCredits"] = null;
  if (d.plan_credits !== null && d.plan_credits !== undefined) {
    const pc = obj(d.plan_credits);
    const granted = pc ? num(pc.granted) : null;
    const spent = pc ? num(pc.spent) : null;
    const held = pc ? num(pc.held) : null;
    const left = pc ? num(pc.left) : null;
    if (!pc || granted === null || spent === null || held === null || left === null) return null;
    planCredits = { granted, spent, held, left, periodStart: iso(pc.period_start), periodEnd: iso(pc.period_end) };
  }

  const r = obj(d.run_slots);
  const runSlots = r ? { limit: num(r.limit), active: num(r.active) ?? 0 } : null;

  const entitlements: Record<string, EntitlementValue> = {};
  const e = obj(d.entitlements) ?? {};
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") entitlements[k] = v;
  }

  return {
    exempt: d.exempt === true,
    extraEnabled: d.extra_enabled,
    plan,
    subscription,
    planCredits,
    lastPlanPeriodEnd: iso(d.last_plan_period_end),
    extra: { available: extraAvail, soonestExpiry: iso(extra.soonest_expiry) },
    bonus: { available: bonusAvail, soonestExpiry: iso(bonus.soonest_expiry) },
    spendableNow,
    runSlots,
    entitlements,
  };
}

// ── the plan allowance ───────────────────────────────────────────────────────

/**
 * Percent of a period's plan credits that have been spent, a whole number that
 * never tells a half-truth at either end: 0 only when nothing was spent, 100
 * only when everything was, and 1..99 in between however close it is.
 * Null when the period granted nothing (no basis for a percentage).
 */
export function usedPercent(spent: number, granted: number): number | null {
  if (!Number.isFinite(spent) || !Number.isFinite(granted) || granted <= 0) return null;
  if (spent <= 0) return 0;
  if (spent >= granted) return 100;
  return Math.min(99, Math.max(1, Math.round((spent / granted) * 100)));
}

export type PlanAllowance =
  /** A plan period with credits: how much is used, and when it renews (or ends). */
  | {
      kind: "period";
      granted: number;
      spent: number;
      held: number;
      left: number;
      percent: number;
      periodEnd: string | null;
      /** The subscription will not renew (canceled, or set to end at the period's end). */
      ends: boolean;
    }
  /** A live subscription whose last period's credits have expired and the next ones have not arrived. */
  | { kind: "ended"; endedAt: string }
  /** A live subscription that has never been given credits. */
  | { kind: "none" }
  /** No live plan: the Free plan. */
  | { kind: "free" };

/**
 * What the plan card shows. Honest states first: credits that expired are not
 * "spent", a subscription with no credit lot says so instead of drawing 0%,
 * and with no live subscription there is no allowance at all (Free has only
 * the one-time welcome credits).
 */
export function planAllowance(s: UsageSummary): PlanAllowance {
  const pc = s.planCredits;
  const percent = pc ? usedPercent(pc.spent, pc.granted) : null;
  if (pc && percent !== null) {
    const sub = s.subscription;
    return {
      kind: "period",
      granted: pc.granted,
      spent: pc.spent,
      held: pc.held,
      left: pc.left,
      percent,
      periodEnd: pc.periodEnd ?? sub?.periodEnd ?? null,
      ends: Boolean(sub && (sub.status === "canceled" || sub.cancelAtPeriodEnd)),
    };
  }
  // A live lot that granted nothing is not an expired one: nothing to measure, nothing expired.
  if (pc) return { kind: "none" };
  if (s.subscription?.live) return s.lastPlanPeriodEnd ? { kind: "ended", endedAt: s.lastPlanPeriodEnd } : { kind: "none" };
  return { kind: "free" };
}

/**
 * "in 21 days", "tomorrow", "in 3 hours" in the viewer's language; null for a
 * date that is not a date or has already passed (the caller then says nothing
 * relative rather than "0 days ago" about a renewal).
 */
export function relativeUntil(isoDate: string | null, now: number, locale: string): string | null {
  if (!isoDate) return null;
  const at = Date.parse(isoDate);
  if (!Number.isFinite(at) || at <= now) return null;
  const ms = at - now;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (ms < HOUR) {
    value = Math.max(1, Math.round(ms / MIN));
    unit = "minute";
  } else if (ms < DAY) {
    value = Math.round(ms / HOUR);
    unit = "hour";
  } else {
    value = Math.round(ms / DAY);
    unit = "day";
  }
  // By table for en / ru / uz (lib/date-format.ts): the runtime's ICU may lack a language the app is written in.
  const table = formatAhead(value, unit as "minute" | "hour" | "day", locale);
  if (table) return table;
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
  } catch {
    return null;
  }
}

/** A whole-number percent in the viewer's language ("62%", "62 %"). */
export function formatPercent(n: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(n / 100);
  } catch {
    return `${n}%`;
  }
}

// ── the plan's other limits ──────────────────────────────────────────────────

export interface UsageLimits {
  /** Runs in progress against the plan's parallel-run limit; null = unlimited or unknown. */
  runs: { active: number; limit: number } | null;
  /** The plan's queue priority level (0 = standard); null when the plan does not carry one. */
  priority: number | null;
  /** Public API access, when the plan carries the key. */
  api: boolean | null;
}

export function usageLimits(s: UsageSummary): UsageLimits {
  const slots = s.runSlots;
  const runs = slots && slots.limit !== null ? { active: slots.active, limit: slots.limit } : null;
  const p = s.entitlements.queue_priority;
  const api = s.entitlements.api_access;
  return { runs, priority: typeof p === "number" ? p : null, api: typeof api === "boolean" ? api : null };
}

// ── what the Free plan does not include ──────────────────────────────────────

export interface FreeGap {
  key: "credits" | "concurrency" | "queue_priority" | "api_access";
  /** concurrency: Free's value and the best a paid plan gives. */
  free?: number;
  best?: number;
}

/**
 * What a paid plan gives that Free does not, from the same plan matrix the
 * pricing page draws (so only ENFORCED limits, and only what the price list
 * really says): monthly credits, more runs at once, queue priority, API
 * access. Empty when there is no matrix or no paid plan to compare with.
 */
export function freeGaps(matrix: PlanMatrix | null): FreeGap[] {
  if (!matrix) return [];
  const freeIdx = matrix.columns.findIndex((c) => c.isDefault);
  const paid = matrix.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.isDefault);
  if (freeIdx < 0 || paid.length === 0) return [];
  const out: FreeGap[] = [];
  const free = matrix.columns[freeIdx];
  if (paid.some(({ c }) => c.monthlyCredits > free.monthlyCredits)) out.push({ key: "credits" });
  const cell = (key: string, i: number): EntitlementValue | undefined => matrix.rows.find((r) => r.key === key)?.cells[i];
  const type = (key: string): EntitlementType | undefined => matrix.rows.find((r) => r.key === key)?.type;
  for (const key of ["concurrency", "queue_priority", "api_access"] as const) {
    const t = type(key);
    if (!t) continue;
    const f = cell(key, freeIdx);
    if (t === "bool") {
      if (f !== true && paid.some(({ i }) => cell(key, i) === true)) out.push({ key });
    } else if (t === "int" && typeof f === "number") {
      const best = Math.max(...paid.map(({ i }) => (typeof cell(key, i) === "number" ? (cell(key, i) as number) : 0)));
      if (best > f) out.push(key === "concurrency" ? { key, free: f, best } : { key });
    }
  }
  return out;
}

// ── the upgrade link ─────────────────────────────────────────────────────────

/**
 * Is there a plan above this workspace's current one to point at? Only a plan
 * that is on the price list here (the plan cards on the Credits page show it)
 * and gives more monthly credits. Nothing is offered when the catalog could
 * not be read.
 */
export function higherPlanExists(summary: UsageSummary, matrix: PlanMatrix | null): boolean {
  if (!matrix) return false;
  const current = summary.plan?.monthlyCredits ?? 0;
  const currentId = summary.plan?.id ?? null;
  return matrix.columns.some((c) => !c.isDefault && c.id !== currentId && (c.priceId !== null || c.displayPrice !== null) && c.monthlyCredits > current);
}

/** Where the "Upgrade plan" link goes: the plan cards on the Credits page. */
export const USAGE_LINKS = {
  upgrade: "/credits#plans",
  buy: "/credits#topups",
  /** The page itself, for a refusal that says "turn extra credits on". */
  usage: "/usage",
  extraSection: "/usage#extra",
} as const;

/**
 * Should the page offer "Upgrade plan"? On Free, whenever a plan above exists.
 * On a plan, only when the workspace cannot start a new run (nothing
 * spendable under its own switch) and a higher plan exists: the link is for
 * someone who ran out, not a banner for everyone.
 */
export function offerUpgrade(summary: UsageSummary, matrix: PlanMatrix | null): boolean {
  if (!higherPlanExists(summary, matrix)) return false;
  if (!summary.subscription?.live) return true;
  return summary.spendableNow <= 0;
}
