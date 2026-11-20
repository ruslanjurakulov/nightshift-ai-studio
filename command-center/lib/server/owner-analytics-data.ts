import "server-only";
import type { MoneyRow } from "@/lib/owner-analytics/money";
import type { ActivityRow } from "@/lib/owner-analytics/people";
import type { Period, PeriodSelection } from "@/lib/owner-analytics/period";
import { HISTORY_FROM } from "@/lib/owner-analytics/kpis";
import { readActivity, readMoney, type Read } from "./owner-analytics";

const DAY = 86_400_000;
/** owner_analytics_activity refuses a window over 400 days; one day of slack for the half-open end. */
const ACTIVITY_MAX_DAYS = 399;

/** All money since the platform could take any, up to the end of the period: MRR, churn and cohorts need history. */
export function readMoneyFor(sel: PeriodSelection): Promise<Read<MoneyRow[]>> {
  return readMoney(HISTORY_FROM, sel.current.to);
}

/**
 * Activity for a period, plus the 29 days before it (MAU at the period's end looks back 30 days), and the previous period when
 * comparing. Null when that span is longer than the database will read: the page then says ARPU and engagement are unknown for
 * so long a period, rather than computing them from part of it.
 */
export async function readActivityFor(sel: PeriodSelection): Promise<Read<ActivityRow[]> | null> {
  const start = (p: Period) => Date.parse(p.from) - 29 * DAY;
  const from = Math.min(start(sel.current), sel.previous ? start(sel.previous) : Infinity);
  const to = Date.parse(sel.current.to);
  if ((to - from) / DAY > ACTIVITY_MAX_DAYS) {
    const own = start(sel.current);
    if ((to - own) / DAY > ACTIVITY_MAX_DAYS) return null;
    return readActivity(new Date(own).toISOString(), sel.current.to);
  }
  return readActivity(new Date(from).toISOString(), sel.current.to);
}
